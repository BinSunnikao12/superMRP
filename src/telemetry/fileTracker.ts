/**
 * 从 .admin/events/*.jsonl 实时 tail 重建 live runs。
 * 关键点：server 和 orchestrator 是两个独立进程,不能共享内存 bus,
 * 所以用文件作为事件真相来源。orch 写 → server 读。
 *
 * 实现：用 fs.watch 监听 .admin/events/ 目录,每次新增字节就读
 * 新行,广播到 SSE 客户端。本地内存维护 liveRun map。
 */

import { watch, readFileSync, existsSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { RunEvent, LiveRun, RunId } from "./eventTypes.js";
import type { RoleName, AccountId } from "../roles.js";
import { emptyRoleTokens } from "../roles.js";
import { GLOBAL } from "../projectPaths.js";

// 绝对路径：server 可能从别的 CWD 启动，相对 ".admin/events" 会读不到 orchestrator 写的事件。
const EVENTS_DIR = GLOBAL.eventsDir;

class LiveRunTracker extends EventEmitter {
  private liveRuns = new Map<RunId, LiveRun>();
  private fileOffsets = new Map<string, number>(); // path -> bytes read
  private watched = false;
  private scanTimer: NodeJS.Timeout | null = null;

  ensureWatching() {
    if (this.watched) return;
    this.watched = true;
    // 若目录还不存在（server 先于任何 run 启动），先建出来再 watch，
    // 否则 watched=true 后永远不会再进来，server 起来后第一个 run 的事件就丢了。
    try {
      mkdirSync(EVENTS_DIR, { recursive: true });
    } catch (e) {
      console.error("[tracker] 建事件目录失败：", e);
    }
    // 1) 启动时回放当月全部事件（让 server 起来就有历史 live 状态）
    this.replayAll().catch((e) => console.error("[tracker] replay 失败：", e));
    // 2) 之后开始 tail 新写入
    try {
      watch(EVENTS_DIR, { persistent: true }, () => this.scan());
    } catch (e) {
      console.error("[tracker] watch 失败：", e);
    }
    // 3) 兜底轮询
    this.scanTimer = setInterval(() => this.scan(), 1000);
  }

  /** 启动时回放当月所有事件,让 tracker 一上来就同步状态。 */
  private async replayAll() {
    if (!existsSync(EVENTS_DIR)) return;
    const files = (await readdir(EVENTS_DIR)).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const full = join(EVENTS_DIR, f);
      let st;
      try { st = await stat(full); } catch { continue; }
      const text = readFileSync(full, "utf8");
      this.fileOffsets.set(full, st.size);
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as RunEvent;
          this.apply(e);
        } catch {}
      }
    }
    console.error(`[tracker] 回放完成，${this.liveRuns.size} 个 live run`);
  }

  private async scan() {
    if (!existsSync(EVENTS_DIR)) return;
    const files = (await readdir(EVENTS_DIR)).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const full = join(EVENTS_DIR, f);
      let st;
      try { st = await stat(full); } catch { continue; }
      const lastOffset = this.fileOffsets.get(full) ?? 0;
      if (st.size <= lastOffset) continue; // 没新内容
      const fd = readFileSync(full, "utf8");
      const slice = fd.slice(lastOffset);
      this.fileOffsets.set(full, st.size);
      for (const line of slice.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as RunEvent;
          this.apply(e);
          this.emit("event", e);
        } catch {}
      }
    }
  }

  private apply(e: RunEvent) {
    let r = this.liveRuns.get(e.runId);
    if (!r) {
      r = {
        runId: e.runId,
        projectId: e.projectId,
        goal: "",
        startedAt: e.ts,
        currentRound: 0,
        totalTokens: 0,
        perAccount: {},
        perRole: emptyRoleTokens(),
        state: "running",
      };
      this.liveRuns.set(e.runId, r);
    }
    switch (e.type) {
      case "run.start": r.goal = e.goal; break;
      case "run.round": r.currentRound = e.round; break;
      case "run.task.done": {
        const t = e.inputTokens + e.outputTokens;
        r.totalTokens += t;
        r.perAccount[e.accountId as AccountId] = (r.perAccount[e.accountId as AccountId] ?? 0) + t;
        r.perRole[e.role] = (r.perRole[e.role] ?? 0) + t;
        break;
      }
      // PM 自己的开销累加（之前漏掉，所以 perRole.pm 永远是 0）
      case "pm.call": {
        const t = e.inputTokens + e.outputTokens;
        r.totalTokens += t;
        r.perAccount[e.accountId] = (r.perAccount[e.accountId] ?? 0) + t;
        r.perRole["pm"] = (r.perRole["pm"] ?? 0) + t;
        if (e.exhausted) r.state = "error"; // PM 撞限等同 run 异常
        break;
      }
      case "pm.validate": {
        r.currentRound = e.round;
        break;
      }
      case "run.done":
        r.state = "done";
        r.doneReason = e.reason;
        // 历史 run 保留 30 分钟,然后清掉
        setTimeout(() => this.liveRuns.delete(e.runId), 30 * 60_000);
        break;
      case "run.task.error":
      case "account.exhausted":
      case "run.task.start":
      case "run.task.text":
      case "run.task.tool":
      case "run.task.mega":
      case "run.round.done":
      case "run.iteration":
      case "run.iteration.failed":
      case "pm.decompose":
      case "pm.review":
      case "pm.iteration":
        break;
    }
  }

  list(): LiveRun[] {
    return Array.from(this.liveRuns.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(runId: RunId): LiveRun | undefined {
    return this.liveRuns.get(runId);
  }
}

export const tracker = new LiveRunTracker();
tracker.ensureWatching();
