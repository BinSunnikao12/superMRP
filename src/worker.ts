import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, envFor, type Account, MEGA_TASK_TOKEN_CAP } from "./config.js";
import { ROLE_PROMPTS, type RoleName } from "./roles.js";
import { log, logMessage } from "./log.js";
import { recordUsage, markExhausted } from "./accountPool.js";
import { emit as emitEvent } from "./telemetry/eventWriter.js";

export interface Task {
  role: RoleName;
  instruction: string;
}

export interface WorkerResult {
  role: RoleName;
  account: string;
  sessionId?: string;
  finalText: string;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  exhausted?: boolean; // 这一轮直接把账号标记成耗尽了（quota error）
  taskId?: string;
  changedFiles?: string[]; // 本轮 Write/Edit 改动的文件路径（用于迭代记录「做了什么」）
  mega?: boolean; // 单任务 tokens > MEGA_TASK_TOKEN_CAP（orchestrator 用它提示 PM 下轮拆细）
}

export interface RunWorkerCtx {
  runId?: string;
  projectId?: string;
}

/**
 * 跑一个 worker：一次 query()，绑定某个账号的 key（通过 env）。
 * 这是"用满 5 个账号"的核心——每次调用用不同 account.key。
 *
 * 兜底：如果模型返回 quota / 429 之类的限流错误，会自动调用 markExhausted
 * 把这个账号踢出可用队列，结果里 exhausted=true 告知调用方「这轮白做了」。
 */
export async function runWorker(opts: {
  task: Task;
  account: Account;
  workspace: string;
  resume?: string;
  ctx?: RunWorkerCtx;
}): Promise<WorkerResult> {
  const { task, account, workspace, resume, ctx } = opts;
  const role = task.role;
  const taskId = (ctx?.runId ? `${ctx.runId}-${role}-${Date.now().toString(36)}` : undefined);
  // 完整 instruction 落日志,PM 一眼能看见派给 worker 的「活」。
  log(role, `▶️ 启动 (账号=${account.id}) taskId=${taskId ?? "—"}:`);
  // 多行 instruction 缩进展示,避免与时间戳头撞行
  for (const line of task.instruction.split(/\r?\n/)) {
    log(role, `   | ${line}`);
  }

  if (ctx?.runId && taskId) {
    emitEvent({
      type: "run.task.start",
      ts: Date.now(),
      runId: ctx.runId,
      projectId: ctx.projectId ?? "default",
      taskId,
      role,
      accountId: account.id,
      instruction: task.instruction.slice(0, 500),
    });
  }

  const q = query({
    prompt: task.instruction,
    options: {
      model: MODEL,
      systemPrompt: ROLE_PROMPTS[role],
      cwd: workspace,
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      // SDK 强制要求：用 bypassPermissions 时必须显式声明跳过权限确认。
      allowDangerouslySkipPermissions: true,
      maxTurns: 200,
      env: envFor(account.key),
      ...(resume ? { resume } : {}),
    },
  });

  let sessionId: string | undefined;
  let finalText = "";
  let tokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let quotaError = false;
  let quotaErrorMsg = "";
  // 收集本轮 worker 真实改动的文件路径,只用于收尾日志(便于 PM/用户在日志里看到产出)
  const changedFiles = new Set<string>();

  for await (const m of q as AsyncIterable<any>) {
    logMessage(role, m);
    if (m.type === "assistant" && m.message?.content) {
      for (const b of m.message.content) {
        if (b.type === "text") {
          finalText += b.text;
          if (ctx?.runId && taskId && b.text?.trim()) {
            emitEvent({
              type: "run.task.text",
              ts: Date.now(),
              runId: ctx.runId,
              projectId: ctx.projectId ?? "default",
              taskId,
              role,
              text: b.text.slice(0, 500),
            });
          }
        } else if (b.type === "tool_use" && ctx?.runId && taskId) {
          emitEvent({
            type: "run.task.tool",
            ts: Date.now(),
            runId: ctx.runId,
            projectId: ctx.projectId ?? "default",
            taskId,
            role,
            tool: b.name,
            input: b.input,
          });
          // 抓取 Write/Edit 的目标路径,挂到本轮收尾的「files=」日志里
          if (b.name === "Write" || b.name === "Edit") {
            const p = (b.input as any)?.file_path;
            if (typeof p === "string") changedFiles.add(p);
          } else if (b.name === "MultiEdit") {
            for (const e of ((b.input as any)?.edits ?? []) as Array<{ file_path?: string }>) {
              if (typeof e?.file_path === "string") changedFiles.add(e.file_path);
            }
          }
        }
      }
    }
    if (m.type === "result") {
      sessionId = m.session_id;
      const u = m.usage || {};
      inputTokens = u.input_tokens || 0;
      outputTokens = u.output_tokens || 0;
      tokens = inputTokens + outputTokens;
      if (m.result) finalText = m.result;
      // 收紧的 quota 正则：只看 result 字符串，避免 JSON dump 里误匹配 "quota"/"exceeded"
      const qText = (m.result || "").toString().toLowerCase();
      if (
        m.is_error === true &&
        (qText.includes("insufficient_quota") ||
          qText.includes("rate_limit") ||
          qText.includes("status 429") ||
          qText.includes("status: 429"))
      ) {
        quotaError = true;
        quotaErrorMsg = m.result || "quota/rate limit";
      }
    }
  }

  // Mega-task 检测：单 worker 任务超 cap 时 emit run.task.mega，
  // 让下轮 PM review 看到这个 warning，迫使其把"做完所有页面"之类的任务拆细。
  if (
    !quotaError &&
    MEGA_TASK_TOKEN_CAP > 0 &&
    tokens > MEGA_TASK_TOKEN_CAP &&
    ctx?.runId &&
    taskId
  ) {
    emitEvent({
      type: "run.task.mega",
      ts: Date.now(),
      runId: ctx.runId,
      projectId: ctx.projectId ?? "default",
      taskId,
      role,
      accountId: account.id,
      tokens,
      cap: MEGA_TASK_TOKEN_CAP,
    });
    log(
      role,
      `⚠️ [mega] taskId=${taskId} tokens=${tokens.toLocaleString()} > cap=${MEGA_TASK_TOKEN_CAP.toLocaleString()} ` +
        `（下轮 PM review 会看到这个 warning，请把这种 mega-task 拆细）`
    );
  }

  if (quotaError) {
    markExhausted(account.id, quotaErrorMsg.slice(0, 120));
    if (ctx?.runId && taskId) {
      emitEvent({
        type: "run.task.done",
        ts: Date.now(),
        runId: ctx.runId,
        projectId: ctx.projectId ?? "default",
        taskId,
        role,
        accountId: account.id,
        sessionId,
        inputTokens,
        outputTokens,
        exhausted: true,
      });
      emitEvent({
        type: "account.exhausted",
        ts: Date.now(),
        runId: ctx.runId,
        projectId: ctx.projectId ?? "default",
        accountId: account.id,
        reason: quotaErrorMsg.slice(0, 200),
      });
    }
    return {
      role,
      account: account.id,
      sessionId,
      finalText,
      tokens,
      inputTokens,
      outputTokens,
      exhausted: true,
      taskId,
      changedFiles: Array.from(changedFiles),
    };
  }

  // 正常情况：把本轮 token 记到该账号名下
  if (tokens > 0) recordUsage(account.id, tokens);

  // 最终汇总写一行——任务派发者(PM/看板)从这里读 in/out tokens、files、taskId
  const filesArr = Array.from(changedFiles);
  log(
    role,
    `✅ 完成 taskId=${taskId ?? "—"} session=${sessionId ?? "—"}` +
      ` in≈${inputTokens} out≈${outputTokens}` +
      (filesArr.length ? ` files=[${filesArr.map((f) => f.replace(workspace, ".")).join(", ")}]` : " files=[]") +
      (finalText ? ` summary="${finalText.slice(0, 200).replace(/\s+/g, " ")}"` : "")
  );

  if (ctx?.runId && taskId) {
    emitEvent({
      type: "run.task.done",
      ts: Date.now(),
      runId: ctx.runId,
      projectId: ctx.projectId ?? "default",
      taskId,
      role,
      accountId: account.id,
      sessionId,
      inputTokens,
      outputTokens,
      exhausted: false,
    });
  }

  return {
    role,
    account: account.id,
    sessionId,
    finalText,
    tokens,
    inputTokens,
    outputTokens,
    taskId,
    changedFiles: filesArr,
    mega: tokens > MEGA_TASK_TOKEN_CAP && MEGA_TASK_TOKEN_CAP > 0,
  };
}
