/**
 * 项目记忆（Slice 3.1）
 * ================================================================
 * 需求：单角色聊天时，角色要能回答「你们对这个项目做了什么」。
 * 这些信息其实已经作为项目资产散落在磁盘上：
 *   - goals/<id>/iterations/LATEST.md + ROUND-*.md  ← PM 每轮迭代记录（做了什么/没做什么/下一步）
 *   - workspace/<id>/RUN_REPORT.json                ← 编排总报告（轮数、token、各角色产出）
 *   - workspace/<id>/**                             ← 真实产出文件树
 * 本模块把它们汇总成一段紧凑文本，注入 chat 的 system prompt，让角色「有记忆」。
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveProject } from "./projectPaths.js";

/** 递归列 workspace 文件树（限深度/数量，避免撑爆 prompt）。 */
function listTree(root: string, maxEntries = 60, maxDepth = 3): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (out.length >= maxEntries || depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (out.length >= maxEntries) return;
      if (e.startsWith(".")) continue;
      const abs = join(dir, e);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(root, abs);
      if (s.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs, depth + 1);
      } else {
        out.push(`${rel} (${s.size}B)`);
      }
    }
  }
  walk(root, 1);
  return out;
}

/**
 * 汇总某项目的「做过什么」记忆。
 * 返回一段 Markdown；无任何资产时返回简短占位。
 */
export function buildProjectMemory(projectId: string): string {
  const paths = resolveProject({ projectId }).paths;
  const parts: string[] = [];

  // 1) 最近一轮迭代记录（最能概括「做了什么/还缺什么/下一步」）
  const latest = join(paths.iterationsDir, "LATEST.md");
  if (existsSync(latest)) {
    try {
      parts.push(`#### 最近一轮迭代记录（LATEST.md）\n${readFileSync(latest, "utf8").slice(0, 3000)}`);
    } catch {}
  }

  // 2) 历史迭代记录清单（只列文件名，给角色一个「做了几轮」的概念）
  try {
    const rounds = readdirSync(paths.iterationsDir)
      .filter((f) => /^ROUND-\d+\.md$/i.test(f))
      .sort((a, b) => {
        const na = Number(a.match(/\d+/)?.[0] ?? 0);
        const nb = Number(b.match(/\d+/)?.[0] ?? 0);
        return na - nb;
      });
    if (rounds.length) {
      parts.push(`#### 迭代历史\n共 ${rounds.length} 轮：${rounds.join(", ")}`);
    }
  } catch {}

  // 3) RUN_REPORT.json 摘要
  if (existsSync(paths.runReportFile)) {
    try {
      const rep = JSON.parse(readFileSync(paths.runReportFile, "utf8"));
      const roleTokens = (rep.results ?? []).reduce((acc: Record<string, number>, r: any) => {
        acc[r.role] = (acc[r.role] ?? 0) + (r.tokens ?? 0);
        return acc;
      }, {});
      parts.push(
        `#### 编排总报告（RUN_REPORT.json）\n` +
          `- 共 ${rep.rounds ?? "?"} 轮，累计 ${(rep.totalTokens ?? 0).toLocaleString()} tokens，用时 ${rep.minutes ?? "?"} 分钟，停止原因=${rep.stopReason ?? "?"}\n` +
          `- 各角色 token：${Object.entries(roleTokens).map(([k, v]) => `${k}=${v}`).join(", ") || "（无）"}`
      );
    } catch {}
  }

  // 4) workspace 产出文件树
  const tree = listTree(paths.workspaceDir);
  if (tree.length) {
    parts.push(`#### 当前产出文件（workspace/${projectId === "gym-website" ? "" : projectId}）\n${tree.join("\n")}`);
  }

  if (!parts.length) {
    return `#### 项目记忆\n（这个项目还没有迭代记录、编排报告或产出文件——可能尚未开始正式编排。）`;
  }
  return parts.join("\n\n");
}
