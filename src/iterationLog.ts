import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkerResult, Task } from "./worker.js";
import { emit as emitEvent } from "./telemetry/eventWriter.js";

/**
 * 迭代记录写盘器。
 * 每轮结束把「做了什么 / 什么没做 / 下一步」组装成 Markdown，落到：
 *   <projectDir>/iterations/ROUND-<n>.md   （逐轮存档）
 *   <projectDir>/iterations/LATEST.md       （始终指向最近一轮，覆盖写）
 *
 * 设计要点：
 *  - 纯确定性：入参齐全就一定写得出，不依赖模型「记得」调 Write。
 *  - 「做了什么」直接来自本轮 results（含 worker 收集的 changedFiles）。
 *  - 「什么没做」来自 PM 的 summarizeIteration()（已在上层生成，这里只拼接）。
 *  - 「下一步」来自 review() 返回的 next（空数组=收工）。
 *  - 写失败不抛，但会 emit run.iteration.failed 事件 + console.error，编排器能看见。
 *
 * Slice 2 PM overhaul:
 *  - 返回值从 string | undefined 改为 { roundPath, latestPath } | null。
 *  - 失败时 emit run.iteration.failed（含 phase: "mkdir" | "write"）。
 */

export interface IterationRecordInput {
  iterationsDir: string;   // 迭代记录目录（直接写这里，不再内部 join "iterations"，避免双重拼接）
  projectId: string;
  runId: string;
  round: number;
  results: WorkerResult[]; // 本轮各岗位产出
  gaps: string;            // PM 的「缺口」Markdown（summarizeIteration 结果）
  next: Task[];            // 下一批任务（空=收工）
  roundTokens: number;     // 本轮 tokens
  totalTokens: number;     // 累计 tokens
  aliveAccounts: number;   // 本轮可用账号数
  totalAccounts: number;   // 总账号数
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function relFile(p: string | undefined, workspace?: string): string {
  if (!p) return "";
  if (workspace && p.startsWith(workspace)) return p.replace(workspace, ".");
  return p;
}

/** 组装单轮 Markdown 文本。导出以便单测。 */
export function buildIterationMarkdown(input: IterationRecordInput, workspace?: string): string {
  const {
    projectId, runId, round, results, gaps, next,
    roundTokens, totalTokens, aliveAccounts, totalAccounts,
  } = input;

  const didLines = results.length
    ? results
        .map((r) => {
          const files = (r.changedFiles ?? []).map((f) => relFile(f, workspace)).filter(Boolean);
          const filesPart = files.length ? `（${files.join(", ")}）` : "";
          const note = (r.finalText || "").trim().replace(/\s+/g, " ").slice(0, 160);
          const flag = r.exhausted ? " ⛔账号耗尽" : "";
          return `- [${r.role}/${r.account}] ${note}${filesPart}${flag}`;
        })
        .join("\n")
    : "- （本轮无产出）";

  const nextLines = next.length
    ? next.map((t) => `- [${t.role}] ${t.instruction}`).join("\n")
    : "- ✅ 项目达成，收工";

  return `# 第 ${round} 轮迭代记录 · ${projectId}

- runId: ${runId}
- 时间: ${stamp()}
- 本轮可用账号: ${aliveAccounts} / ${totalAccounts}
- 本轮 tokens≈: ${roundTokens.toLocaleString()}（累计 ${totalTokens.toLocaleString()}）

## ✅ 做了什么
${didLines}

## ⚠️ 什么没做 / 还缺什么
${gaps.trim() || "- （无）"}

## ➡️ 下一步
${nextLines}
`;
}

/**
 * 写盘，成功返回 { roundPath, latestPath }，失败返回 null 并 emit run.iteration.failed。
 * mkdir 和 writeFileSync 各自 try/catch，方便定位是建目录还是写文件出错。
 */
export function writeIterationRecord(
  input: IterationRecordInput,
  workspace?: string
): { roundPath: string; latestPath: string } | null {
  let dir: string;
  try {
    dir = input.iterationsDir;
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = String(err).slice(0, 200);
    console.error("[iterationLog] mkdir 失败：", msg);
    emitEvent({
      type: "run.iteration.failed",
      ts: Date.now(),
      runId: input.runId,
      projectId: input.projectId,
      round: input.round,
      phase: "mkdir",
      error: msg,
    });
    return null;
  }
  try {
    const md = buildIterationMarkdown(input, workspace);
    const roundPath = join(dir, `ROUND-${input.round}.md`);
    const latestPath = join(dir, "LATEST.md");
    writeFileSync(roundPath, md, "utf8");
    writeFileSync(latestPath, md, "utf8");
    return { roundPath, latestPath };
  } catch (err) {
    const msg = String(err).slice(0, 200);
    console.error("[iterationLog] 写迭代记录失败：", msg);
    emitEvent({
      type: "run.iteration.failed",
      ts: Date.now(),
      runId: input.runId,
      projectId: input.projectId,
      round: input.round,
      phase: "write",
      error: msg,
    });
    return null;
  }
}
