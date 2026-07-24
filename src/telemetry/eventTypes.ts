/**
 * Telemetry event types — 后台面板数据源。
 *
 * 设计原则：
 *  1. JSONL append-only,每行一个事件,带 ts + runId。
 *  2. 类型用 union literal,前端可做穷尽 switch。
 *  3. 不存 secret（key 永远不进事件）。
 *  4. PM 和 worker 一样发事件,方便统一面板。
 */

import type { RoleName, AccountId } from "../roles.js";
import { join } from "node:path";
import { GLOBAL } from "../projectPaths.js";

export type RunId = string;
export type ProjectId = string;
export type ProviderId = string;

export interface BaseEvent {
  ts: number;
  runId: RunId;
  projectId: ProjectId;
}

export type RunEvent =
  | (BaseEvent & { type: "run.start"; goal: string; accountCount: number })
  | (BaseEvent & { type: "run.round"; round: number; plannedTasks: number; availableAccounts: number })
  | (BaseEvent & { type: "run.task.start"; taskId: string; role: RoleName; accountId: AccountId; instruction: string })
  | (BaseEvent & { type: "run.task.tool"; taskId: string; role: RoleName; tool: string; input: unknown })
  | (BaseEvent & { type: "run.task.text"; taskId: string; role: RoleName; text: string })
  | (BaseEvent & { type: "run.task.done"; taskId: string; role: RoleName; accountId: AccountId; sessionId?: string; inputTokens: number; outputTokens: number; exhausted: boolean })
  | (BaseEvent & { type: "run.task.error"; taskId: string; role: RoleName; accountId: AccountId; error: string })
  | (BaseEvent & { type: "run.task.mega"; taskId: string; role: RoleName; accountId: AccountId; tokens: number; cap: number })
  | (BaseEvent & { type: "run.round.done"; round: number; totalTokens: number; nextTasks: number })
  | (BaseEvent & { type: "run.iteration"; round: number; recordPath: string; latestPath?: string; nextTasks: number; completed: boolean; blockers?: number })
  | (BaseEvent & { type: "run.iteration.failed"; round: number; phase: "mkdir" | "write"; error: string })
  | (BaseEvent & { type: "run.done"; totalTokens: number; minutes: number; reason: "completed" | "time_limit" | "token_budget" | "all_keys_exhausted" | "max_rounds" })
  | (BaseEvent & { type: "account.exhausted"; accountId: AccountId; reason: string })
  // ---- PM 事件：billing-grade（pm.call）+ observability-grade ----
  | (BaseEvent & { type: "pm.call"; phase: "decompose" | "review" | "summarize" | "validate"; accountId: AccountId; inputTokens: number; outputTokens: number; exhausted: boolean })
  | (BaseEvent & { type: "pm.decompose"; round: number; taskCount: number; accountId: AccountId; inputTokens: number; outputTokens: number })
  | (BaseEvent & { type: "pm.review"; round: number; nextTasks: number; decision: "continue" | "ship"; accountId: AccountId; inputTokens: number; outputTokens: number })
  | (BaseEvent & { type: "pm.iteration"; round: number; accountId: AccountId; summary: string; inputTokens: number; outputTokens: number })
  | (BaseEvent & { type: "pm.validate"; round: number; accountId: AccountId; checks: Array<{ name: string; ok: boolean; note: string }>; gaps: string[]; blockers: string[]; inputTokens: number; outputTokens: number });

export function eventFileForMonth(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  // 绝对路径：telemetry 跨进程，相对 ".admin/events" 一旦从别的 CWD 启动就会错位。
  return join(GLOBAL.eventsDir, `usage-${y}-${m}.jsonl`);
}

export type RunStopReason = "completed" | "time_limit" | "token_budget" | "all_keys_exhausted" | "max_rounds";

export interface LiveRun {
  runId: RunId;
  projectId: ProjectId;
  goal: string;
  startedAt: number;
  currentRound: number;
  totalTokens: number;
  perAccount: Record<AccountId, number>;
  perRole: Record<RoleName, number>;
  state: "running" | "done" | "error";
  doneReason?: RunStopReason;
}

/**
 * 前端 UI 行为事件 — 与 RunEvent 解耦,不进 tracker/liveRuns。
 * 用 .admin/events/ui.jsonl 单独落盘,供看板「用户做了什么」一栏使用。
 */
export interface UiEvent {
  ts: number;
  sessionId: string;
  action: string;            // 'dashboard.open' | 'run.open' | 'run.sse.subscribe' | ...
  target?: string;           // runId / route / 按钮名
  meta?: Record<string, unknown>;
}
