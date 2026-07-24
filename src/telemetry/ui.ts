/**
 * UI 事件旁路写入器:append-only 落 .admin/events/ui.jsonl。
 *
 * 与 eventWriter 故意分开:
 *  - 不进 RunEvent 联合,tracker 不会重建 liveRuns。
 *  - 不依赖 key/runId,纯用户行为记录。
 *  - 写入失败静默吞,不影响主流程。
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UiEvent } from "./eventTypes.js";
import { GLOBAL } from "../projectPaths.js";

// 绝对路径：与 eventFileForMonth 一致，避免从别的 CWD 启动 server 时读写错位。
const FILE = join(GLOBAL.eventsDir, "ui.jsonl");

/**
 * 追加一条 UI 事件。ts 由调用方传,避免 orchestrator 之外禁止 Date.now 的脚本式约束。
 */
export function writeUiEvent(e: UiEvent): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(e) + "\n", "utf8");
  } catch (err) {
    // 静默吞:UI 事件不该搞挂页面
    console.error("[ui-event] 落盘失败:", String(err).slice(0, 200));
  }
}

/**
 * 读尾部 N 条(默认 100)。返回按 ts 升序,便于看板直接展示。
 */
export function readUiEvents(limit = 100): UiEvent[] {
  if (!existsSync(FILE)) return [];
  let raw = "";
  try {
    raw = readFileSync(FILE, "utf8");
  } catch {
    return [];
  }
  const out: UiEvent[] = [];
  for (const ln of raw.split("\n")) {
    if (!ln) continue;
    try {
      out.push(JSON.parse(ln) as UiEvent);
    } catch {
      /* 跳过坏行 */
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-limit);
}
