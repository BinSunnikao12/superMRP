import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, relative, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ACCOUNTS } from "./config.js";
import { runWorker, type Task, type WorkerResult } from "./worker.js";
import { decomposeTask, review, summarizeIteration, validateResults } from "./manager.js";
import type { RoleName } from "./roles.js";
import { writeIterationRecord } from "./iterationLog.js";
import { parseCli, resolveProject, ensureProjectDirs, CLI_HELP } from "./projectPaths.js";
import { log } from "./log.js";
import {
  pickAccount,
  aliveCount,
  allExhausted,
  snapshot as poolSnapshot,
  KEY_FALLBACK,
  PER_KEY_TOKEN_BUDGET,
} from "./accountPool.js";
import { emit as emitEvent } from "./telemetry/eventWriter.js";

/**
 * 主编排循环：PM 拆解 → 账号并行 fan-out → 收集 → PM 审查 → 循环。
 * 四个停止闸门：任务队列空 / 到达时限 / 全局 token 预算耗尽 / 所有 key 都被耗尽。
 */

// —— Slice 2 项目隔离：所有路径都来自 projectPaths，不再硬编码 ——
const CLI = parseCli(process.argv.slice(2));
if (CLI.help) {
  console.log(CLI_HELP);
  process.exit(0);
}
const RESOLVED = resolveProject({ projectId: CLI.projectId, goalArg: CLI.goalArg });
ensureProjectDirs(RESOLVED.paths);

const PROJECT_ID = RESOLVED.id;
const WORKSPACE = RESOLVED.paths.workspaceDir;       // 绝对路径，worker cwd
const GOAL_INPUT = RESOLVED.goalInput;               // 目录或单文件
const ITERATIONS_DIR = RESOLVED.paths.iterationsDir; // 绝对路径，迭代记录落这里
const RUN_REPORT_FILE = RESOLVED.paths.runReportFile;

/**
 * 文件名权重。README/INDEX/AGENTS 等元文档最优先；其次是 DESIGN/REQUIREMENTS/SPEC；
 * 其他 .md 按字典序兜底。数字越大越靠前。
 */
function fileWeight(name: string): number {
  const upper = name.toUpperCase();
  if (/^README(\.|$)/i.test(name)) return 100;
  if (/^INDEX(\.|$)/i.test(name)) return 100;
  if (/^AGENTS(\.|$)/i.test(name)) return 100;
  if (upper === "DESIGN.MD" || upper === "REQUIREMENTS.MD" || upper === "SPEC.MD") return 90;
  if (/^DESIGN-/i.test(name) || /^REQUIREMENTS-/i.test(name) || /^SPEC-/i.test(name)) return 85;
  if (/^NOTES?\./i.test(name) || /^TODO\./i.test(name) || /^HANDOFF\./i.test(name)) return 40;
  if (/^ROUND[-_]?\d+/i.test(name)) return 20; // 历史轮次产物权重最低
  return 50;
}

/**
 * 加载一个目录下的所有目标文档，按权重+文件名排序后拼接。
 * - 顶层 .md 直接读
 * - 一层子目录里的 .md 也并入（用相对路径标记来源）
 * - 单文件传入走原路径，保持向后兼容
 */
function loadGoals(input: string): { goal: string; sourceLabel: string } {
  let stat;
  try {
    stat = statSync(input);
  } catch {
    throw new Error(`目标路径不存在：${input}`);
  }

  if (stat.isFile()) {
    const content = readFileSync(input, "utf8");
    return {
      goal: `# 来源文件: ${basename(input)}\n\n${content}`,
      sourceLabel: input,
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`目标路径既不是文件也不是目录：${input}`);
  }

  const files: { abs: string; rel: string; weight: number; name: string }[] = [];
  for (const entry of readdirSync(input)) {
    const abs = join(input, entry);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isFile() && entry.toLowerCase().endsWith(".md")) {
      files.push({
        abs,
        rel: entry,
        weight: fileWeight(entry),
        name: entry,
      });
    } else if (s.isDirectory()) {
      // 一层子目录里的 .md（例：goals/gym-website/SPEC.md）
      for (const sub of readdirSync(abs)) {
        const subAbs = join(abs, sub);
        let ss;
        try {
          ss = statSync(subAbs);
        } catch {
          continue;
        }
        if (ss.isFile() && sub.toLowerCase().endsWith(".md")) {
          files.push({
            abs: subAbs,
            rel: `${entry}/${sub}`,
            weight: fileWeight(sub),
            name: sub,
          });
        }
      }
    }
  }

  if (files.length === 0) {
    throw new Error(`目录里没找到 .md 文件：${input}`);
  }

  // 权重大的先；同权重按文件名 ASCII 序，确保每次跑结果稳定
  files.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

  const parts = files.map(
    (f) => `# 来源文件: ${f.rel}\n\n${readFileSync(f.abs, "utf8").trim()}`
  );
  log(
    "pm",
    `📚 已聚合 ${files.length} 个目标文档（按权重）：${files.map((f) => f.rel).join(", ")}`
  );

  return {
    goal: parts.join("\n\n---\n\n"),
    sourceLabel: `${input} (${files.length} files)`,
  };
}

const { goal: GOAL_TEXT, sourceLabel: GOAL_SOURCE } = loadGoals(GOAL_INPUT);

const LIMIT_MS = (Number(process.env.LIMIT_MIN) || 600) * 60 * 1000;
const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET) || 8_000_000;
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS) || 20;

function allocateAccounts(batch: Task[]): { task: Task; accountIdx: number }[] {
  const out: { task: Task; accountIdx: number }[] = [];
  let cursor = 0;
  for (const task of batch) {
    const pick = pickAccount(cursor);
    if (!pick) break;
    out.push({ task, accountIdx: pick.index });
    cursor = pick.index + 1;
  }
  return out;
}

/**
 * 根据 blocker 字符串关键字，把 PM validate 出来的"还缺什么"分派到合适的角色。
 * - a11y / 焦点 / 键盘 / 标签 / aria / 测试 / lighthouse → tester
 * - 文案 / 标题 / 标语 / 品牌 / seo → copywriter
 * - 设计 / 颜色 / 字体 / 间距 / 圆角 / 样式 / token → designer
 * - 架构 / 目录结构 / 技术选型 / 接口约定 / 数据模型 → architect
 * - 接口 / api / 后端 / 数据 / 数据库 / 存储 / 服务 → backend
 * - 页面 / 前端 / 布局 / 组件 / 交互 / 响应式 → frontend
 * - 需求 / prd / 用户故事 / 验收 / 功能规划 → product
 * - 默认 → developer（修代码 / 加 README / 修 anchor / 改路径）
 */
function inferRoleForBlocker(blocker: string): RoleName {
  const s = blocker.toLowerCase();
  if (/(a11y|无障碍|焦点|focus|键盘|tab|aria|标签|alt|lighthouse|测试|test-)/.test(s)) return "tester";
  if (/(文案|copy|标题|标语|slogan|品牌|seo|meta)/.test(s)) return "copywriter";
  if (/(设计|颜色|color|字体|font|间距|spacing|圆角|radius|样式|style|token|hero)/.test(s)) return "designer";
  if (/(架构|architecture|目录结构|技术选型|接口约定|数据模型|schema|模块划分)/.test(s)) return "architect";
  if (/(需求|prd|用户故事|user story|验收|acceptance|功能规划|产品)/.test(s)) return "product";
  if (/(接口|api|后端|backend|数据库|database|存储|storage|服务端|server-side|mock 数据)/.test(s)) return "backend";
  if (/(页面|前端|frontend|布局|layout|组件|component|交互|响应式|responsive|样式表)/.test(s)) return "frontend";
  return "developer";
}

async function main() {
  mkdirSync(WORKSPACE, { recursive: true });
  log("pm", `🎯 加载目标：${GOAL_SOURCE}`);
  const goal = GOAL_TEXT;
  const START = Date.now();
  const RUN_ID = `run-${START.toString(36)}-${randomUUID().slice(0, 6)}`;
  let spent = 0;
  let round = 0;
  let stopReason: "completed" | "time_limit" | "token_budget" | "all_keys_exhausted" | "max_rounds" = "completed";

  log(
    "pm",
    `🚀 项目启动 runId=${RUN_ID} | 账号数=${ACCOUNTS.length} | KEY_FALLBACK=${KEY_FALLBACK ? "on" : "off"}` +
      ` | 单key预算=${PER_KEY_TOKEN_BUDGET} | 时限=${LIMIT_MS / 60000}分钟 | 全局预算=${TOKEN_BUDGET} tokens`
  );

  emitEvent({
    type: "run.start",
    ts: Date.now(),
    runId: RUN_ID,
    projectId: PROJECT_ID,
    goal: GOAL_SOURCE,
    accountCount: ACCOUNTS.length,
  });

  let tasks: Task[] = await decomposeTask(goal, ACCOUNTS[0], { runId: RUN_ID, projectId: PROJECT_ID });
  const allResults: WorkerResult[] = [];

  while (tasks.length > 0) {
    const elapsed = Date.now() - START;
    if (elapsed >= LIMIT_MS) {
      log("pm", `⏱️ 到达时限（${Math.round(elapsed / 60000)}分钟），优雅停止`);
      stopReason = "time_limit";
      break;
    }
    if (spent >= TOKEN_BUDGET) {
      log("pm", `💰 全局 token 预算耗尽（${spent}），优雅停止`);
      stopReason = "token_budget";
      break;
    }
    if (KEY_FALLBACK && allExhausted()) {
      log("pm", `🔚 所有 key 的 token 都已耗尽，优雅停止`);
      stopReason = "all_keys_exhausted";
      break;
    }
    if (round >= MAX_ROUNDS) {
      log("pm", `🔁 到达最大轮数 ${MAX_ROUNDS}，停止`);
      stopReason = "max_rounds";
      break;
    }
    round++;

    const planned = allocateAccounts(tasks);
    const batch = planned.map((p) => p.task);
    tasks = tasks.slice(batch.length);
    if (planned.length === 0) break;

    log(
      "pm",
      `🔗 任务→账号绑定 (第 ${round} 轮):\n` +
        planned
          .map(
            (p, i) =>
              `  ${i + 1}) [${p.task.role}] → acct=${ACCOUNTS[p.accountIdx].id} :: ${p.task.instruction}`
          )
          .join("\n")
    );

    log(
      "pm",
      `—— 第 ${round} 轮：计划并行 ${planned.length} 个任务（可用账号=${aliveCount()}/${ACCOUNTS.length}）——`
    );
    emitEvent({
      type: "run.round",
      ts: Date.now(),
      runId: RUN_ID,
      projectId: PROJECT_ID,
      round,
      plannedTasks: planned.length,
      availableAccounts: aliveCount(),
    });

    const results = await Promise.all(
      planned.map(({ task, accountIdx }) =>
        runWorker({
          task,
          account: ACCOUNTS[accountIdx],
          workspace: WORKSPACE,
          ctx: { runId: RUN_ID, projectId: PROJECT_ID },
        }).catch((e): WorkerResult => {
          log(task.role, `❌ 出错：${String(e).slice(0, 200)}`);
          return {
            role: task.role,
            account: "err",
            finalText: `ERROR: ${e}`,
            tokens: 0,
          };
        })
      )
    );

    allResults.push(...results);
    const roundTokens = results.reduce((s, r) => s + r.tokens, 0);
    spent += roundTokens;
    log(
      "pm",
      `本轮累计 tokens≈${spent}（剩余可用 key=${aliveCount()}/${ACCOUNTS.length}），用时 ${Math.round(
        (Date.now() - START) / 60000
      )} 分钟`
    );
    emitEvent({
      type: "run.round.done",
      ts: Date.now(),
      runId: RUN_ID,
      projectId: PROJECT_ID,
      round,
      totalTokens: spent,
      nextTasks: tasks.length,
    });

    if (tasks.length === 0) {
      const next = await review(goal, results, round, ACCOUNTS[0], { runId: RUN_ID, projectId: PROJECT_ID });

      // —— PM 验证（真读 workspace）：必检交付物 / 锚点 / 品牌 / 已知 FAIL ——
      let validate: { checks: { name: string; ok: boolean; note: string }[]; gaps: string[]; blockers: string[]; rawText: string } | null = null;
      try {
        validate = await validateResults(goal, results, round, ACCOUNTS[0], WORKSPACE, {
          runId: RUN_ID,
          projectId: PROJECT_ID,
        });
      } catch (e) {
        log("pm", `⚠️ PM 验证异常：${String(e).slice(0, 120)}`);
      }

      // —— 迭代记录：每轮写一份「做了什么/没做什么/下一步」到 ITERATIONS_DIR ——
      // gaps 优先用 validate 输出的；validate 跑通且给出 gaps 时不调 summarizeIteration
      let gaps = "";
      if (validate && (validate.gaps.length > 0 || validate.blockers.length > 0)) {
        const lines: string[] = [];
        for (const g of validate.gaps) lines.push(`- ${g}`);
        for (const b of validate.blockers) lines.push(`- 🚧 ${b}`);
        gaps = lines.join("\n");
      } else {
        try {
          gaps = await summarizeIteration(goal, results, round, ACCOUNTS[0], { runId: RUN_ID, projectId: PROJECT_ID });
        } catch (e) {
          log("pm", `⚠️ 迭代小结异常：${String(e).slice(0, 120)}`);
        }
      }

      const written = writeIterationRecord(
        {
          iterationsDir: ITERATIONS_DIR,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          round,
          results,
          gaps,
          next,
          roundTokens,
          totalTokens: spent,
          aliveAccounts: aliveCount(),
          totalAccounts: ACCOUNTS.length,
        },
        WORKSPACE
      );
      if (written) {
        log("pm", `🧾 已写第 ${round} 轮迭代记录：${relative(process.cwd(), written.roundPath)}`);
        emitEvent({
          type: "run.iteration",
          ts: Date.now(),
          runId: RUN_ID,
          projectId: PROJECT_ID,
          round,
          recordPath: relative(process.cwd(), written.roundPath),
          latestPath: relative(process.cwd(), written.latestPath),
          nextTasks: next.length + (validate?.blockers.length ?? 0),
          completed: next.length === 0 && (validate?.blockers.length ?? 0) === 0,
          blockers: validate?.blockers.length ?? 0,
        });
      }

      // —— Blocker 兜底：即使 PM 说收工，validate 发现的 blockers 也会强制追加一轮 ——
      // 把每个 blocker 字符串映射到一个角色（关键字启发式），生成 Task 推进修复。
      const blockerTasks: Task[] = (validate?.blockers ?? []).map((b) => ({
        role: inferRoleForBlocker(b),
        instruction: `[PM validate blocker, round ${round + 1}] ${b}`,
      }));
      if (blockerTasks.length > 0) {
        log(
          "pm",
          `🚧 validate 发现 ${blockerTasks.length} 个 blocker，自动追加一轮：` +
            `\n${blockerTasks.map((t, i) => `  ${i + 1}) [${t.role}] :: ${t.instruction}`).join("\n")}`
        );
      }

      tasks.push(...next, ...blockerTasks);
    }
  }

  const report = {
    runId: RUN_ID,
    goal: GOAL_SOURCE,
    rounds: round,
    accounts: ACCOUNTS.length,
    keyFallback: KEY_FALLBACK,
    perKeyBudget: PER_KEY_TOKEN_BUDGET,
    totalTokens: spent,
    minutes: Math.round((Date.now() - START) / 60000),
    stopReason,
    perKeySpent: poolSnapshot(),
    results: allResults.map((r) => ({
      role: r.role,
      account: r.account,
      taskId: r.taskId,
      sessionId: r.sessionId,
      tokens: r.tokens,
      exhausted: r.exhausted,
    })),
  };
  writeFileSync(RUN_REPORT_FILE, JSON.stringify(report, null, 2));

  emitEvent({
    type: "run.done",
    ts: Date.now(),
    runId: RUN_ID,
    projectId: PROJECT_ID,
    totalTokens: spent,
    minutes: Math.round((Date.now() - START) / 60000),
    reason: stopReason,
  });

  log(
    "pm",
    `🏁 结束 runId=${RUN_ID} 共 ${round} 轮，tokens≈${spent}，各 key 用量=${JSON.stringify(poolSnapshot())}，` +
      `stopReason=${stopReason}，报告见 workspace/RUN_REPORT.json`
  );
}

main().catch((e) => {
  console.error("编排器崩溃：", e);
  process.exit(1);
});
