/**
 * 单角色聊天（Slice 3）
 * ================================================================
 * 在后台里对**单个角色**发起一次性对话（不走完整 orchestrator 编排）。
 * 用途：调试某个岗位的 prompt、让某角色单独干一件小事、快速问答。
 *
 * 与 worker.runWorker 的区别：
 *  - runWorker 是编排循环里的一次任务，产出真实文件、记 token 到账号池。
 *  - chat 是交互式、流式、面向 UI：以 async generator 逐块吐 text/tool/done，
 *    供 server 用 SSE 转发给前端。
 *
 * 安全：默认只读工具（Read/Glob/Grep），cwd 限定在项目 workspace；
 * 不给 Write/Edit/Bash，避免聊天里误改文件。调用方可显式放开。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, envFor, ACCOUNTS, type Account } from "./config.js";
import { ROLE_PROMPTS, type RoleName } from "./roles.js";
import { resolveProject } from "./projectPaths.js";
import { listInstalled, readLibrary } from "./skillStore.js";
import { buildProjectMemory } from "./projectMemory.js";
import type { ChatMessage } from "./chatStore.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatOptions {
  role: RoleName;
  projectId: string;
  message: string;
  /** 续接上一轮的 session（多轮对话）。 */
  resume?: string;
  /** 指定账号；默认用第一个可用账号。 */
  accountId?: string;
  /** 放开写工具（默认只读）。 */
  allowWrite?: boolean;
  /** 之前的对话历史（持久化恢复用）。当 resume 失效（如 server 重启）时用它重建上下文。 */
  history?: ChatMessage[];
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; input: unknown }
  | { type: "done"; sessionId?: string; inputTokens: number; outputTokens: number; error?: string };

function pickAccountById(accountId?: string): Account {
  if (accountId) {
    const found = ACCOUNTS.find((a) => a.id === accountId);
    if (found) return found;
  }
  return ACCOUNTS[0];
}

/**
 * 组装系统提示 = 角色 prompt + 项目记忆（做过什么）+ 已安装 skills/kb。
 * 让角色既懂自己的岗位，又「记得」这个项目的历史资产。
 */
function buildSystemPrompt(role: RoleName, projectId: string): string {
  let sys = ROLE_PROMPTS[role];
  const parts: string[] = [];

  // 项目记忆：迭代记录 + RUN_REPORT + 产出文件树。这是「你们对项目做了什么」的答案来源。
  try {
    const memory = buildProjectMemory(projectId);
    if (memory) parts.push(`## 本项目记忆（你应当据此回答"这个项目做过什么"）\n\n${memory}`);
  } catch {}

  try {
    const skills = listInstalled("skill", projectId);
    for (const s of skills.slice(0, 10)) {
      const content = readLibrary("skill", s.name); // 库版本；项目版本一般一致
      // 优先读项目内已安装版本
      const paths = resolveProject({ projectId }).paths;
      let body = content ?? "";
      try {
        body = readFileSync(join(paths.skillsDir, `${s.name}.md`), "utf8");
      } catch {}
      if (body) parts.push(`### 技能：${s.name}\n${body.slice(0, 2000)}`);
    }
  } catch {}

  try {
    const kb = listInstalled("kb", projectId);
    const paths = resolveProject({ projectId }).paths;
    for (const k of kb.slice(0, 10)) {
      let body = "";
      try {
        body = readFileSync(join(paths.kbDir, `${k.name}.md`), "utf8");
      } catch {}
      if (body) parts.push(`### 知识：${k.name}\n${body.slice(0, 2000)}`);
    }
  } catch {}

  if (parts.length) {
    sys += `\n\n---\n以下是本项目的上下文，供你参考：\n\n${parts.join("\n\n")}`;
  }
  return sys;
}

/**
 * 把历史消息拼进 prompt（当没有 SDK resume 或 resume 可能失效时用）。
 * 只在没有 resume 时启用——有 resume 说明 SDK 侧还留着上下文，无需重放。
 */
function buildPromptWithHistory(message: string, history?: ChatMessage[]): string {
  if (!history || history.length === 0) return message;
  const lines = history
    .filter((m) => m.who === "user" || m.who === "assistant")
    .map((m) => `${m.who === "user" ? "用户" : "你（助手）"}：${m.text}`);
  if (!lines.length) return message;
  return (
    `以下是我们之前的对话记录（供你保持上下文连续）：\n\n${lines.join("\n\n")}\n\n` +
    `---\n现在用户的新消息是：\n${message}`
  );
}

/**
 * 发起一次单角色对话，流式产出。用法：
 *   for await (const chunk of chat({ role, projectId, message })) { ... }
 */
export async function* chat(opts: ChatOptions): AsyncGenerator<ChatChunk> {
  const { role, projectId, message, resume, accountId, allowWrite, history } = opts;
  const account = pickAccountById(accountId);
  const paths = resolveProject({ projectId }).paths;
  const systemPrompt = buildSystemPrompt(role, projectId);

  const tools = allowWrite
    ? ["Read", "Write", "Edit", "Glob", "Grep"]
    : ["Read", "Glob", "Grep"];

  // 有 resume → SDK 侧还留着上下文，只发新消息；
  // 无 resume（如 server 重启后从磁盘恢复的线程）→ 把历史重放进 prompt，保证连续性。
  const prompt = resume ? message : buildPromptWithHistory(message, history);

  const q = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt,
      cwd: paths.workspaceDir,
      tools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      env: envFor(account.key),
      ...(resume ? { resume } : {}),
    },
  });

  let sessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  try {
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "assistant" && m.message?.content) {
        for (const b of m.message.content) {
          if (b.type === "text" && b.text) {
            yield { type: "text", text: b.text };
          } else if (b.type === "tool_use") {
            yield { type: "tool", tool: b.name, input: b.input };
          }
        }
      }
      if (m.type === "result") {
        sessionId = m.session_id;
        const u = m.usage || {};
        inputTokens = u.input_tokens || 0;
        outputTokens = u.output_tokens || 0;
        if (m.is_error) error = (m.result || "error").toString().slice(0, 300);
      }
    }
  } catch (e) {
    error = String(e).slice(0, 300);
  }

  yield { type: "done", sessionId, inputTokens, outputTokens, error };
}
