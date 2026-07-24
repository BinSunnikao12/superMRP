/**
 * 事件写入器：append-only JSONL 落盘 + EventEmitter 总线。
 *
 * 用法：
 *  import { emit } from "./telemetry/eventWriter.js";
 *  emit({ type: "run.task.done", ts, runId, projectId, taskId, role, accountId, inputTokens, outputTokens, exhausted });
 *
 * 订阅（后台 SSE 用）：
 *  import { bus } from "./telemetry/eventWriter.js";
 *  bus.on("event", (e) => { ... });
 *
 * 设计要点：
 *  - 写入失败不抛：try/catch 静默,避免 6 小时跑到一半被磁盘满炸掉。
 *  - 进程内总线无背压：SSE 客户端慢不会阻塞 orchestrator。
 *  - key 不出现在事件里。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { eventFileForMonth, type RunEvent } from "./eventTypes.js";

class TypedBus extends EventEmitter {
  emitEvent(e: RunEvent) {
    this.emit("event", e);
  }
}

export const bus = new TypedBus();
bus.setMaxListeners(50);

export function emit(event: RunEvent): void {
  // 1) 落盘（最好努力）
  try {
    const file = eventFileForMonth(event.ts);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  } catch (err) {
    // 故意吞掉 —— telemetry 不该搞挂主流程
    console.error("[telemetry] 事件落盘失败：", String(err).slice(0, 200));
  }
  // 2) 推总线（异步语义无关,EventEmitter 同步）
  bus.emitEvent(event);
}
