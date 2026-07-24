/**
 * 聊天记录持久化（Slice 3.1）
 * ================================================================
 * 需求：单角色聊天的记录要作为**项目资产**存下来，刷新/重启不丢；
 * 角色要能记得「这个项目做过什么」。
 *
 * 存储模型：
 *  - 一个「会话线程」= 一个 JSON 文件，落在 .admin/sessions/<projectId>/chats/<threadId>.json。
 *  - 线程里存：id、projectId、role、title、创建/更新时间、SDK sessionId（用于 resume）、消息数组。
 *  - 消息 = { who: user|assistant|tool, text, ts }。
 *
 * 为什么放 .admin/sessions/<id>/chats：
 *  - 与 Slice 2 的项目隔离一致（每个项目自己的目录）。
 *  - .admin 已 gitignore，聊天记录不进版本库但持久在磁盘。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { resolveProject, isValidProjectId, REPO_ROOT } from "./projectPaths.js";
import type { RoleName } from "./roles.js";

export type ChatWho = "user" | "assistant" | "tool";

export interface ChatMessage {
  who: ChatWho;
  text: string;
  ts: number;
}

export interface ChatThread {
  id: string;
  projectId: string;
  role: RoleName;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** SDK 侧的 session_id，用于跨请求 resume（可能随每轮更新）。 */
  sessionId?: string;
  messages: ChatMessage[];
}

/** 线程摘要（列表用，不含全部消息）。 */
export interface ChatThreadSummary {
  id: string;
  projectId: string;
  role: RoleName;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage?: string;
}

/** 线程 id：时间戳 + 随机，仅小写字母数字与连字符。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertInsideRoot(p: string, label: string): void {
  const abs = isAbsolute(p) ? p : join(REPO_ROOT, p);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} 越出仓库根目录，拒绝：${p}`);
  }
}

/** 某项目的聊天线程目录（绝对）。 */
function chatsDir(projectId: string): string {
  if (!isValidProjectId(projectId)) throw new Error(`非法项目 id：${projectId}`);
  return join(resolveProject({ projectId }).paths.sessionDir, "chats");
}

function threadFile(projectId: string, threadId: string): string {
  if (!ID_RE.test(threadId)) throw new Error(`非法线程 id：${threadId}`);
  const f = join(chatsDir(projectId), `${threadId}.json`);
  assertInsideRoot(f, "聊天线程");
  return f;
}

/** 生成一个新线程 id（依赖时间 + 随机；仅在服务运行时调用，故可用 Date/Math）。 */
export function newThreadId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 列出某项目的所有线程摘要（按更新时间倒序）。 */
export function listThreads(projectId: string): ChatThreadSummary[] {
  const dir = chatsDir(projectId);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ChatThreadSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as ChatThread;
      const last = t.messages[t.messages.length - 1];
      out.push({
        id: t.id,
        projectId: t.projectId,
        role: t.role,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        messageCount: t.messages.length,
        lastMessage: last ? last.text.slice(0, 80) : undefined,
      });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读一个线程完整内容（不存在返回 null）。 */
export function readThread(projectId: string, threadId: string): ChatThread | null {
  const f = threadFile(projectId, threadId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ChatThread;
  } catch {
    return null;
  }
}

function writeThread(t: ChatThread): void {
  const dir = chatsDir(t.projectId);
  mkdirSync(dir, { recursive: true });
  const f = threadFile(t.projectId, t.id);
  writeFileSync(f, JSON.stringify(t, null, 2), "utf8");
}

/** 新建一个空线程。 */
export function createThread(projectId: string, role: RoleName, title?: string): ChatThread {
  const now = Date.now();
  const t: ChatThread = {
    id: newThreadId(),
    projectId,
    role,
    title: title?.trim() || "新会话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeThread(t);
  return t;
}

/** 往线程追加若干消息（并可更新 sessionId / title）。返回更新后的线程。 */
export function appendMessages(
  projectId: string,
  threadId: string,
  msgs: ChatMessage[],
  opts: { sessionId?: string; title?: string } = {}
): ChatThread {
  let t = readThread(projectId, threadId);
  if (!t) {
    // 容错：线程不存在则新建一个用这个 id
    const now = Date.now();
    t = {
      id: threadId,
      projectId,
      role: (msgs.find((m) => m.who !== "user")?.who as any) || "developer",
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }
  t.messages.push(...msgs);
  if (opts.sessionId) t.sessionId = opts.sessionId;
  if (opts.title) t.title = opts.title;
  // 首条用户消息自动做标题
  if (t.title === "新会话") {
    const firstUser = t.messages.find((m) => m.who === "user");
    if (firstUser) t.title = firstUser.text.slice(0, 30);
  }
  t.updatedAt = Date.now();
  writeThread(t);
  return t;
}

/** 删除一个线程（幂等）。 */
export function deleteThread(projectId: string, threadId: string): boolean {
  const f = threadFile(projectId, threadId);
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}
