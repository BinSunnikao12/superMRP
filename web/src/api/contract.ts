/**
 * RunDetail 页面专用类型集合 —— 让 RunDetail.tsx 单文件自包含。
 * 复用 client.ts 里的 api fetch 工具;类型在这里集中维护。
 *
 * SSE 事件名（来自 src/telemetry/eventTypes.ts RunEvent 联合类型）:
 *   - worker: run.start | run.round | run.task.start | run.task.text |
 *             run.task.tool | run.task.done | run.task.error |
 *             run.task.mega | run.round.done | run.iteration |
 *             run.iteration.failed | run.done | account.exhausted
 *   - pm:     pm.call | pm.decompose | pm.review | pm.iteration | pm.validate
 *
 * StreamedEvent 是开放对象（[k: string]: unknown），新增字段无需改这里。
 */
import { api } from "./client";

export interface RunDetailData {
  runId: string;
  state: "running" | "done" | "error";
  goal: string;
  projectId: string;
  startedAt: number;
  currentRound: number;
  totalTokens: number;
  perAccount: Record<string, number>;
  perRole: Record<string, number>;
  doneReason?: string;
}

export interface StreamedEvent {
  ts: number;
  type: string;
  runId: string;
  [k: string]: unknown;
}

/** pm.validate 事件里的单条 check（PM 验证一项） */
export interface PmValidateCheck {
  name: string;
  ok: boolean;
  note: string;
}

export interface UiEvent {
  ts: number;
  sessionId: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

export interface TaskRow {
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

export { api };
