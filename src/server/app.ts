/**
 * Hono 应用入口:本机 127.0.0.1:8787。
 * v1 只读,后续 slice 加写路由(CRUD providers / skills / chat)。
 *
 * 事件来源：跨进程从 .admin/events/*.jsonl tail (tracker)。
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { tracker } from "../telemetry/fileTracker.js";
import { ACCOUNTS } from "../config.js";
import {
  KEY_FALLBACK,
  PER_KEY_TOKEN_BUDGET,
  snapshot as poolSnapshot,
} from "../accountPool.js";
import { eventFileForMonth, type RunEvent } from "../telemetry/eventTypes.js";
import { writeUiEvent, readUiEvents } from "../telemetry/ui.js";
import { GLOBAL, listProjects, resolveProject, REPO_ROOT } from "../projectPaths.js";
import { relative } from "node:path";
import {
  listLibrary,
  readLibrary,
  writeLibrary,
  deleteLibrary,
  installPreview,
  install,
  listInstalled,
  type LibKind,
} from "../skillStore.js";
import { chat } from "../chat.js";
import {
  listThreads,
  readThread,
  createThread,
  appendMessages,
  deleteThread,
  type ChatMessage,
} from "../chatStore.js";
import { WORKER_ROLES, ROLE_PROMPTS, type RoleName } from "../roles.js";

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/api/v1/whoami", (c) => c.json({ ok: true, version: "0.1.0" }));

app.get("/api/v1/orchestrator/status", (c) => {
  return c.json({
    accounts: ACCOUNTS.map((a) => ({ id: a.id })),
    keyFallback: KEY_FALLBACK,
    perKeyBudget: PER_KEY_TOKEN_BUDGET,
    liveRuns: tracker.list().map((r) => ({
      runId: r.runId,
      projectId: r.projectId,
      startedAt: r.startedAt,
      currentRound: r.currentRound,
      totalTokens: r.totalTokens,
      state: r.state,
    })),
    poolSnapshot: poolSnapshot(),
  });
});

app.get("/api/v1/runs", async (c) => {
  const project = c.req.query("project") || undefined;
  const runs = await readRunSummaries(project);
  return c.json(runs);
});

/** 项目发现：列出所有项目摘要（只给相对路径，不泄露绝对文件系统路径）。 */
app.get("/api/v1/projects", (c) => {
  return c.json({ projects: listProjects() });
});

/** 单项目详情：相对路径 + 摘要。 */
app.get("/api/v1/projects/:id", (c) => {
  const id = c.req.param("id");
  let resolved;
  try {
    resolved = resolveProject({ projectId: id });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
  const summary = listProjects().find((p) => p.id === id);
  const p = resolved.paths;
  const rel = (abs: string) => relative(REPO_ROOT, abs);
  return c.json({
    id: resolved.id,
    legacy: resolved.legacy,
    summary: summary ?? null,
    paths: {
      goals: rel(p.goalsDir),
      workspace: rel(p.workspaceDir),
      iterations: rel(p.iterationsDir),
      skills: rel(p.skillsDir),
      kb: rel(p.kbDir),
      session: rel(p.sessionDir),
    },
  });
});

// ============ Slice 3：Skill/KB 库 + 安装前预览 + 单角色聊天 ============

function parseKind(raw: string | undefined): LibKind | null {
  return raw === "skill" || raw === "kb" ? raw : null;
}

/** 列全局库条目：GET /api/v1/library/:kind （kind = skill | kb）。 */
app.get("/api/v1/library/:kind", (c) => {
  const kind = parseKind(c.req.param("kind"));
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  return c.json({ kind, entries: listLibrary(kind) });
});

/** 读单条内容：GET /api/v1/library/:kind/:name 。 */
app.get("/api/v1/library/:kind/:name", (c) => {
  const kind = parseKind(c.req.param("kind"));
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  const name = c.req.param("name");
  try {
    const content = readLibrary(kind, name);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ kind, name, content });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 新增/覆盖：PUT /api/v1/library/:kind/:name  body {content}。 */
app.put("/api/v1/library/:kind/:name", async (c) => {
  const kind = parseKind(c.req.param("kind"));
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  const name = c.req.param("name");
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const content = typeof body?.content === "string" ? body.content : "";
  try {
    const entry = writeLibrary(kind, name, content);
    return c.json({ ok: true, entry });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 删除：DELETE /api/v1/library/:kind/:name 。 */
app.delete("/api/v1/library/:kind/:name", (c) => {
  const kind = parseKind(c.req.param("kind"));
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  const name = c.req.param("name");
  try {
    const removed = deleteLibrary(kind, name);
    return c.json({ ok: true, removed });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 列某项目已安装：GET /api/v1/projects/:id/installed/:kind 。 */
app.get("/api/v1/projects/:id/installed/:kind", (c) => {
  const kind = parseKind(c.req.param("kind"));
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  const id = c.req.param("id");
  try {
    return c.json({ projectId: id, kind, entries: listInstalled(kind, id) });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 安装前预览：GET /api/v1/install-preview?kind=&name=&project= 。 */
app.get("/api/v1/install-preview", (c) => {
  const kind = parseKind(c.req.query("kind"));
  const name = c.req.query("name") || "";
  const project = c.req.query("project") || "";
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  try {
    return c.json(installPreview(kind, name, project));
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 确认安装：POST /api/v1/install  body {kind,name,project,confirmOverwrite?}。 */
app.post("/api/v1/install", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const kind = parseKind(body?.kind);
  if (!kind) return c.json({ error: "kind 必须是 skill 或 kb" }, 400);
  try {
    const res = install(kind, String(body?.name || ""), String(body?.project || ""), {
      confirmOverwrite: body?.confirmOverwrite === true,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 可选角色列表（给聊天下拉）：GET /api/v1/roles 。 */
app.get("/api/v1/roles", (c) => {
  return c.json({
    roles: (["pm", ...WORKER_ROLES] as RoleName[]).map((r) => ({
      id: r,
      prompt: ROLE_PROMPTS[r].slice(0, 120),
    })),
  });
});

/** 列某项目的聊天线程：GET /api/v1/projects/:id/threads 。 */
app.get("/api/v1/projects/:id/threads", (c) => {
  const id = c.req.param("id");
  try {
    return c.json({ projectId: id, threads: listThreads(id) });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 读一个线程完整内容：GET /api/v1/projects/:id/threads/:threadId 。 */
app.get("/api/v1/projects/:id/threads/:threadId", (c) => {
  const id = c.req.param("id");
  const threadId = c.req.param("threadId");
  try {
    const t = readThread(id, threadId);
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json(t);
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 新建线程：POST /api/v1/projects/:id/threads  body {role,title?}。 */
app.post("/api/v1/projects/:id/threads", async (c) => {
  const id = c.req.param("id");
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const role = body?.role as RoleName;
  const validRoles: RoleName[] = ["pm", ...WORKER_ROLES];
  if (!validRoles.includes(role)) return c.json({ error: "非法 role" }, 400);
  try {
    const t = createThread(id, role, typeof body?.title === "string" ? body.title : undefined);
    return c.json(t);
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 删除线程：DELETE /api/v1/projects/:id/threads/:threadId 。 */
app.delete("/api/v1/projects/:id/threads/:threadId", (c) => {
  const id = c.req.param("id");
  const threadId = c.req.param("threadId");
  try {
    return c.json({ ok: true, removed: deleteThread(id, threadId) });
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }
});

/** 单角色聊天（SSE 流）：POST /api/v1/chat  body {role,project,message,threadId?,resume?,accountId?,allowWrite?}。
 *  持久化：把用户消息 + 助手回复 + 工具调用都追加到线程文件；线程不存在则自动新建。
 */
app.post("/api/v1/chat", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const role = body?.role as RoleName;
  const project = String(body?.project || "");
  const message = String(body?.message || "");
  const validRoles: RoleName[] = ["pm", ...WORKER_ROLES];
  if (!validRoles.includes(role)) return c.json({ error: "非法 role" }, 400);
  if (!message.trim()) return c.json({ error: "message 不能为空" }, 400);

  // 线程：给了 threadId 就复用（并加载历史），否则新建一个。
  let thread = null as ReturnType<typeof readThread>;
  let threadId: string = typeof body?.threadId === "string" ? body.threadId : "";
  try {
    if (threadId) thread = readThread(project, threadId);
    if (!thread) {
      thread = createThread(project, role);
      threadId = thread.id;
    }
  } catch (e) {
    return c.json({ error: String(e).slice(0, 200) }, 400);
  }

  const history: ChatMessage[] = thread.messages.slice();
  // 若客户端没传 resume，但线程里存了 sessionId，则用它续接（server 未重启时有效）
  const resume =
    typeof body?.resume === "string" && body.resume
      ? body.resume
      : thread.sessionId;

  // 先落用户消息
  appendMessages(project, threadId, [{ who: "user", text: message, ts: Date.now() }]);

  return streamSSE(c, async (stream): Promise<void> => {
    // 先把 threadId 告诉前端（新建时它才知道往哪存/查）
    await stream.writeSSE({ event: "thread", data: JSON.stringify({ type: "thread", threadId }) });

    let assistantText = "";
    const toolMsgs: ChatMessage[] = [];
    let sessionId: string | undefined;
    try {
      for await (const chunk of chat({
        role,
        projectId: project,
        message,
        history,
        resume: typeof resume === "string" ? resume : undefined,
        accountId: typeof body?.accountId === "string" ? body.accountId : undefined,
        allowWrite: body?.allowWrite === true,
      })) {
        await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
        if (chunk.type === "text") assistantText += chunk.text;
        else if (chunk.type === "tool") toolMsgs.push({ who: "tool", text: `🔧 ${chunk.tool}(${JSON.stringify(chunk.input).slice(0, 120)})`, ts: Date.now() });
        else if (chunk.type === "done") sessionId = chunk.sessionId;
      }
    } catch (e) {
      await stream.writeSSE({ event: "done", data: JSON.stringify({ type: "done", inputTokens: 0, outputTokens: 0, error: String(e).slice(0, 300) }) });
    }

    // 落助手回复 + 工具调用 + 更新 sessionId（持久化，刷新/重启可恢复）
    const toPersist: ChatMessage[] = [...toolMsgs];
    if (assistantText.trim()) toPersist.push({ who: "assistant", text: assistantText, ts: Date.now() });
    try {
      appendMessages(project, threadId, toPersist, { sessionId });
    } catch {}
  });
});

app.get("/api/v1/runs/:runId", async (c) => {
  const runId = c.req.param("runId");
  const live = tracker.get(runId);
  if (live) {
    return c.json({
      runId,
      state: live.state,
      goal: live.goal,
      projectId: live.projectId,
      startedAt: live.startedAt,
      currentRound: live.currentRound,
      totalTokens: live.totalTokens,
      perAccount: live.perAccount,
      perRole: live.perRole,
      doneReason: live.doneReason,
    });
  }
  const evs = await readEventsForRun(runId);
  if (evs.length === 0) return c.json({ error: "not found" }, 404);
  return c.json(rebuildRunFromEvents(runId, evs));
});

app.get("/api/v1/runs/:runId/events", (c) => {
  const runId = c.req.param("runId");
  return streamSSE(c, async (stream): Promise<void> => {
    const onEvent = (e: RunEvent) => {
      if (e.runId !== runId) return;
      void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    };
    tracker.on("event", onEvent);
    while (true) {
      try {
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        await new Promise((r) => setTimeout(r, 15_000));
      } catch {
        tracker.off("event", onEvent);
        return;
      }
    }
  });
});

app.get("/api/v1/stream", (c) => {
  return streamSSE(c, async (stream): Promise<void> => {
    const onEvent = (e: RunEvent) => {
      void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    };
    tracker.on("event", onEvent);
    while (true) {
      try {
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        await new Promise((r) => setTimeout(r, 15_000));
      } catch {
        tracker.off("event", onEvent);
        return;
      }
    }
  });
});

app.get("/api/v1/usage", (c) => {
  const groupBy = (c.req.query("groupBy") || "role") as "role" | "account" | "project";
  const totals = aggregateUsage(groupBy);
  return c.json({ groupBy, totals });
});

// --- UI 行为事件 + 任务清单 ---

/** 前端进度面板一行。读时聚合已有 events.jsonl,不动事件 schema。 */
interface TaskRow {
  taskId: string;
  role: string;
  accountId?: string;
  instruction: string;
  startedAt: number;
  doneAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  exhausted?: boolean;
  status: "running" | "done" | "error";
}

app.post("/api/v1/ui-events", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!sessionId || !action) {
    return c.json({ ok: false, error: "sessionId+action required" }, 400);
  }
  writeUiEvent({
    ts: Number(body?.ts) || Date.now(),
    sessionId,
    action,
    target: typeof body?.target === "string" ? body.target : undefined,
    meta: body?.meta && typeof body.meta === "object" ? body.meta : undefined,
  });
  return c.json({ ok: true });
});

app.get("/api/v1/ui-events", (c) => {
  const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 100));
  return c.json({ events: readUiEvents(limit) });
});

app.get("/api/v1/runs/:runId/tasks", async (c) => {
  const runId = c.req.param("runId");
  const evs = await readEventsForRun(runId);
  const byId = new Map<string, TaskRow>();
  for (const e of evs) {
    if (e.type === "run.task.start") {
      byId.set(e.taskId, {
        taskId: e.taskId,
        role: e.role,
        accountId: e.accountId,
        instruction: e.instruction,
        startedAt: e.ts,
        status: "running",
      });
    } else if (e.type === "run.task.done") {
      const cur = byId.get(e.taskId);
      if (cur) {
        cur.doneAt = e.ts;
        cur.inputTokens = e.inputTokens;
        cur.outputTokens = e.outputTokens;
        cur.exhausted = e.exhausted;
        cur.accountId = cur.accountId ?? e.accountId;
        cur.status = e.exhausted ? "error" : "done";
      } else {
        // 没收到 start 的孤儿 done (极少,兜底)
        byId.set(e.taskId, {
          taskId: e.taskId,
          role: e.role,
          accountId: e.accountId,
          instruction: "",
          startedAt: e.ts,
          doneAt: e.ts,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          exhausted: e.exhausted,
          status: e.exhausted ? "error" : "done",
        });
      }
    } else if (e.type === "run.task.error") {
      const cur = byId.get(e.taskId);
      if (cur) {
        cur.doneAt = e.ts;
        cur.status = "error";
        cur.accountId = cur.accountId ?? e.accountId;
      } else {
        byId.set(e.taskId, {
          taskId: e.taskId,
          role: e.role,
          accountId: e.accountId,
          instruction: "",
          startedAt: e.ts,
          doneAt: e.ts,
          status: "error",
        });
      }
    }
  }
  return c.json({ runId, tasks: Array.from(byId.values()).sort((a, b) => a.startedAt - b.startedAt) });
});

// --- helpers ---

async function readEventsForRun(runId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  const now = new Date();
  for (const offset of [0, -1]) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const f = eventFileForMonth(d.getTime());
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    for (const ln of lines) {
      if (!ln) continue;
      try {
        const e = JSON.parse(ln) as RunEvent;
        if (e.runId === runId) out.push(e);
      } catch {}
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

async function readRunSummaries(projectFilter?: string) {
  const map = new Map<string, { tokens: number; ts: number; projectId: string }>();
  const dir = GLOBAL.eventsDir;
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    for (const ln of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!ln) continue;
      try {
        const e = JSON.parse(ln) as RunEvent;
        if (e.type !== "run.task.done" && e.type !== "run.done" && e.type !== "pm.call") continue;
        if (projectFilter && e.projectId !== projectFilter) continue;
        const cur = map.get(e.runId) ?? { tokens: 0, ts: 0, projectId: e.projectId };
        if (e.type === "run.task.done" || e.type === "pm.call") {
          cur.tokens += e.inputTokens + e.outputTokens;
        }
        if (e.ts > cur.ts) cur.ts = e.ts;
        cur.projectId = e.projectId;
        map.set(e.runId, cur);
      } catch {}
    }
  }
  return Array.from(map.entries())
    .map(([runId, v]) => ({ runId, ...v }))
    .sort((a, b) => b.ts - a.ts);
}

function rebuildRunFromEvents(runId: string, evs: RunEvent[]) {
  let goal = "";
  let projectId = "";
  let startedAt = 0;
  let currentRound = 0;
  let totalTokens = 0;
  let doneReason: string | undefined;
  let state: "running" | "done" | "error" = "done";
  const perAccount: Record<string, number> = {};
  const perRole: Record<string, number> = {};
  for (const e of evs) {
    projectId = e.projectId;
    if (e.type === "run.start") {
      goal = e.goal;
      startedAt = e.ts;
    } else if (e.type === "run.round") {
      currentRound = e.round;
    } else if (e.type === "run.task.done") {
      const t = e.inputTokens + e.outputTokens;
      totalTokens += t;
      perAccount[e.accountId] = (perAccount[e.accountId] ?? 0) + t;
      perRole[e.role] = (perRole[e.role] ?? 0) + t;
    } else if (e.type === "pm.call") {
      // PM 自己的 token 累加（orchestrator 跑完后，server 从 JSONL 重算 totals 时也不能漏）
      const t = e.inputTokens + e.outputTokens;
      totalTokens += t;
      perAccount[e.accountId] = (perAccount[e.accountId] ?? 0) + t;
      perRole["pm"] = (perRole["pm"] ?? 0) + t;
    } else if (e.type === "pm.validate") {
      currentRound = e.round;
    } else if (e.type === "run.done") {
      doneReason = e.reason;
      state = "done";
    }
  }
  return { runId, state, goal, projectId, startedAt, currentRound, totalTokens, perAccount, perRole, doneReason };
}

function aggregateUsage(groupBy: "role" | "account" | "project") {
  const live = tracker.list();
  const out: Record<string, number> = {};
  for (const r of live) {
    if (groupBy === "role") {
      for (const [k, v] of Object.entries(r.perRole)) out[k] = (out[k] ?? 0) + v;
    } else if (groupBy === "account") {
      for (const [k, v] of Object.entries(r.perAccount)) out[k] = (out[k] ?? 0) + v;
    } else {
      out[r.projectId] = (out[r.projectId] ?? 0) + r.totalTokens;
    }
  }
  return out;
}

const PORT = Number(process.env.PORT) || 8787;

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`[server] 管理后台 API 已启动: http://127.0.0.1:${info.port}`);
});
