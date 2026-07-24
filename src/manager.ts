import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, envFor, type Account } from "./config.js";
import { ROLE_PROMPTS, type RoleName, WORKER_ROLES } from "./roles.js";
import { log } from "./log.js";
import { recordUsage, markExhausted } from "./accountPool.js";
import { emit as emitEvent } from "./telemetry/eventWriter.js";
import type { Task, WorkerResult } from "./worker.js";

/**
 * PM 角色：用一次 LLM 调用做纯文本推理（不碰文件），返回严格 JSON。
 * 关键变化（Slice 2 PM overhaul）：
 *  - askPM 现在返回 { text, inputTokens, outputTokens, sessionId, quotaError, quotaErrorMsg }
 *    调用方拿到 token 后调 recordUsage 把 PM 自己的开销记到 account 上（之前永远是 0）。
 *  - 默认 tools:[]（decompose/review/summarize 用）。validate 阶段传 tools 启用文件访问。
 *  - 用收紧的 quota 正则（避免 "429 users signed up today" 这种 false positive）。
 */
export type PmPhase = "decompose" | "review" | "summarize" | "validate";

export interface AskPmOpts {
  tools?: readonly string[];          // 默认 []；validate 阶段传 ["Read","Bash","Glob","Grep"]
  cwd?: string;                       // 工具 cwd；validate 阶段传 workspace
  phase?: PmPhase;                    // 事件分类（pm.call / pm.validate 等）
  runId?: string;
  projectId?: string;
}

export interface AskPmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
  quotaError: boolean;
  quotaErrorMsg: string;
}

async function askPM(prompt: string, account: Account, opts: AskPmOpts = {}): Promise<AskPmResult> {
  const tools = opts.tools ?? [];
  const phase: PmPhase = opts.phase ?? "decompose";
  // validate 阶段 PM 必须多步调工具（Read → 检文件 → Bash 跑 grep → 总结输出 JSON），
  // 1 turn 不够；其他阶段只要纯文本 maxTurns=1 就行。
  const maxTurns = phase === "validate" ? 8 : 1;

  const q = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: ROLE_PROMPTS.pm,
      tools: [...tools],
      cwd: opts.cwd,
      permissionMode: "bypassPermissions",
      // SDK 强制要求：bypassPermissions 必须显式确认。
      allowDangerouslySkipPermissions: true,
      maxTurns,
      env: envFor(account.key),
    },
  });
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | undefined;
  let quotaError = false;
  let quotaErrorMsg = "";
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "assistant" && m.message?.content) {
      for (const b of m.message.content) if (b.type === "text") text += b.text;
    }
    if (m.type === "result" && m.result) text = m.result;
    if (m.type === "result") {
      sessionId = m.session_id;
      const u = m.usage || {};
      inputTokens = u.input_tokens || 0;
      outputTokens = u.output_tokens || 0;
      // 收紧的 quota 正则：只看 result 字符串，避免 JSON dump 里误匹配 "quota"/"exceeded"
      const qText = (m.result || "").toString().toLowerCase();
      if (
        m.is_error === true &&
        (qText.includes("insufficient_quota") ||
          qText.includes("rate_limit") ||
          qText.includes("status 429") ||
          qText.includes("status: 429"))
      ) {
        quotaError = true;
        quotaErrorMsg = (m.result || "quota/rate limit").toString().slice(0, 200);
      }
    }
  }

  // PM 自己的 token 入账（之前这块漏掉，所以 RUN_REPORT 里 pm 永远 0）
  const tokens = inputTokens + outputTokens;
  if (quotaError) {
    markExhausted(account.id, quotaErrorMsg.slice(0, 120));
    emitEvent({
      type: "account.exhausted",
      ts: Date.now(),
      runId: opts.runId ?? "unknown",
      projectId: opts.projectId ?? "unknown",
      accountId: account.id,
      reason: `pm.${phase}: ${quotaErrorMsg}`.slice(0, 200),
    });
  } else if (tokens > 0) {
    recordUsage(account.id, tokens);
  }

  // pm.call 是 billing-grade 事件；fileTracker 用它累加 perRole.pm / perAccount[acct1]
  if (opts.runId && opts.projectId) {
    emitEvent({
      type: "pm.call",
      ts: Date.now(),
      runId: opts.runId,
      projectId: opts.projectId,
      phase,
      accountId: account.id,
      inputTokens,
      outputTokens,
      exhausted: quotaError,
    });
  }

  return { text, inputTokens, outputTokens, sessionId, quotaError, quotaErrorMsg };
}

/**
 * 从模型输出里稳妥地抠出「任务对象数组」。
 * MiniMax-M2 会 thinking 吃预算，长 JSON 常被截尾 —— 所以不整体 JSON.parse，
 * 而是用平衡括号扫描逐个提取完整的 {...} 对象；被截断的最后一个对象直接丢弃，永不崩。
 */
function extractObjects(text: string): any[] {
  const raw = text.replace(/```(?:json)?/g, "").replace(/```/g, "");
  const objs: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          /* 跳过坏对象 */
        }
        start = -1;
      }
    }
  }
  return objs;
}

const VALID_ROLES: readonly RoleName[] = WORKER_ROLES;

/**
 * 容忍 PM 在不同字段名之间漂移：instruction / task / desc / description 都接受。
 * 之前 review() 用 task 字段被静默丢弃（bug #2）。
 */
function normalizeTask(raw: any): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role;
  const instr = raw.instruction ?? raw.task ?? raw.desc ?? raw.description;
  const instruction = typeof instr === "string" ? instr.trim() : "";
  if (!role || !instruction) return null;
  if (!VALID_ROLES.includes(role)) return null;
  return { role, instruction };
}

/** 拆解：把项目目标拆成一批可并行的任务。 */
export async function decomposeTask(
  goal: string,
  account: Account,
  ctx: { runId: string; projectId: string }
): Promise<Task[]> {
  const prompt = `项目目标如下：
---
${goal}
---
请把它拆解成一批可以并行执行的具体任务（建议 4~8 条，尽量铺满并行团队）。可用岗位仅限：${VALID_ROLES.join(", ")}。

并行团队编排原则：
- 首轮优先派 1 个 architect 定技术选型/目录结构/前后端接口约定，为并行开工打地基。
- 把开发拆成多个可并行的 frontend / backend 任务（按页面/模块/接口切分），让多个开发者同时干，尽快清空这一轮。
- 首轮可派 product 产出 PRD；product 空闲时安排它协助验证功能并提出新功能/优化。
- 宁可多拆几条颗粒度小的并行任务，也不要一条 mega-task 堵住一个开发者。

每条任务的 instruction 必须：
- 明确产出 1 个文件 / 1 个验证步骤，禁止"做完所有页面""跑全套测试"这种 mega-task。
- 估算 token 用量（简单 ≤80k；含浏览器验证 ≤150k）。单任务超 250k tokens 即视为不达标。
- 引用具体 SPEC 条款编号（如 "实现 SPEC §3 的 9 个锚点区块"）。

严格只输出一个 JSON 数组，每个元素形如：
{"role": "frontend", "instruction": "非常具体的一句话任务，说明要产出什么文件"}
字段名是 "instruction"，不要用 "task" / "desc" 之类的同义词。
不要输出任何解释、不要用 markdown 代码围栏。`;

  const res = await askPM(prompt, account, { phase: "decompose", runId: ctx.runId, projectId: ctx.projectId });
  const tasks = extractObjects(res.text).map(normalizeTask).filter((t): t is Task => t !== null);
  // 兼容坏字段时给 PM 看一眼（不影响归一化结果）
  const raw = extractObjects(res.text);
  const fallback = raw.filter((r) => r && r.role && (r.task || r.desc || r.description) && !r.instruction).length;
  if (fallback > 0) {
    log("pm", `⚠️ PM 拆解阶段有 ${fallback} 条用了非 instruction 字段，已自动归一化`);
  }
  log("pm", `📋 拆解出 ${tasks.length} 个任务（pm.in=${res.inputTokens} pm.out=${res.outputTokens}）`);
  if (tasks.length > 0) {
    const lines = tasks.map((t, i) => `  ${i + 1}) [${t.role}] :: ${t.instruction}`);
    log("pm", `📝 任务清单:\n${lines.join("\n")}`);
  } else {
    log("pm", `📝 任务清单: (空)`);
  }
  if (tasks.length === 0) {
    log("pm", `⚠️ PM 原始输出：${res.text.slice(0, 300)}`);
  }
  emitEvent({
    type: "pm.decompose",
    ts: Date.now(),
    runId: ctx.runId,
    projectId: ctx.projectId,
    round: 0, // orchestrator 在调完会把 round 写到 run.round；这里没有 round 上下文
    taskCount: tasks.length,
    accountId: account.id,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });
  return tasks;
}

/** 审查：看完成的产出，决定还要不要补做/返工，返回下一批任务（空数组=收工）。 */
export async function review(
  goal: string,
  results: WorkerResult[],
  round: number,
  account: Account,
  ctx: { runId: string; projectId: string }
): Promise<Task[]> {
  const summary = results
    .map((r) => {
      const mega = r.mega ? ` [⚠️ MEGA: tokens=${r.tokens.toLocaleString()} 超出 cap，PM 需把这种 mega-task 拆细]` : "";
      return `- [${r.role}/${r.account}] ${r.finalText.slice(0, 300)}${mega}`;
    })
    .join("\n");

  const megaWarnings = results.filter((r) => r.mega).map((r) =>
    `[mega warning] taskId=${r.taskId ?? "?"} role=${r.role} tokens=${r.tokens.toLocaleString()} > cap`
  );
  const megaSection = megaWarnings.length > 0
    ? `\n\n【⚠️ Mega-task 警告】本轮有 ${megaWarnings.length} 个任务超过单任务 token 上限（MEGA_TASK_TOKEN_CAP）。这类"做完所有页面 / 跑全套测试"的 mega-task 必须拆成多条小任务，每条 ≤80k tokens。\n${megaWarnings.join("\n")}\n`
    : "";

  const prompt = `项目目标：
${goal}
${megaSection}
这是第 ${round} 轮，各岗位刚完成的工作摘要：
${summary}

请判断项目是否已经完整达成目标。
- 如果还有明显缺失或需要返工，输出下一批任务（JSON 数组，格式同前，岗位限 ${VALID_ROLES.join(", ")}）。
- 优先把剩余工作拆成多条可并行的 frontend / backend 任务铺满账号；product 空闲则安排它验证功能或提出优化。
- 如果已经足够完整，输出空数组 []。

字段名严格用 "instruction"，不要用 "task" / "desc" / "description"。
严格只输出 JSON 数组，不要解释、不要代码围栏。`;

  const res = await askPM(prompt, account, { phase: "review", runId: ctx.runId, projectId: ctx.projectId });
  const raw = extractObjects(res.text);
  const next = raw.map(normalizeTask).filter((t): t is Task => t !== null);
  const fallback = raw.filter((r) => r && r.role && (r.task || r.desc || r.description) && !r.instruction).length;
  if (fallback > 0) {
    log("pm", `⚠️ PM 审查阶段有 ${fallback} 条用了非 instruction 字段，已自动归一化`);
  }
  log("pm", `🔍 第 ${round} 轮审查原文:\n${res.text.trim()}`);
  log(
    "pm",
    `🔎 第 ${round} 轮审查：${next.length ? `还需 ${next.length} 个任务` : "项目达成，收工"}（pm.in=${res.inputTokens} pm.out=${res.outputTokens}）`
  );
  if (next.length > 0) {
    const lines = next.map((t, i) => `  ${i + 1}) [${t.role}] :: ${t.instruction}`);
    log("pm", `📝 追加任务清单:\n${lines.join("\n")}`);
  }
  emitEvent({
    type: "pm.review",
    ts: Date.now(),
    runId: ctx.runId,
    projectId: ctx.projectId,
    round,
    nextTasks: next.length,
    decision: next.length === 0 ? "ship" : "continue",
    accountId: account.id,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });
  return next;
}

/**
 * 迭代小结：让 PM 用一次纯文本调用，产出本轮「还缺什么 / 什么没做」的 Markdown 分析。
 * - 与 review() 分开：review 出 JSON（下一批任务），这里出人类可读的缺口说明。
 * - 只负责「⚠️ 缺口」这一段（做了什么由 orchestrator 从 results 拼、下一步由 next 拼）。
 * - 兜底：模型输出为空/异常时返回一句占位，保证每轮必有内容、绝不抛错。
 */
export async function summarizeIteration(
  goal: string,
  results: WorkerResult[],
  round: number,
  account: Account,
  ctx: { runId: string; projectId: string }
): Promise<string> {
  const summary = results
    .map((r) => `- [${r.role}/${r.account}] ${r.finalText.slice(0, 300)}`)
    .join("\n");

  const prompt = `现在做【迭代记录】。项目目标：
${goal}

这是第 ${round} 轮，各岗位刚完成的工作摘要：
${summary}

请只用中文写「本轮还缺什么 / 什么没做 / 有什么风险」的要点，3~6 条，每条一行以「- 」开头。
只输出这些要点本身，不要标题、不要 JSON、不要代码围栏、不要客套话。若本轮看起来已无明显缺口，就输出一行「- 本轮无明显缺口」。`;

  let res;
  try {
    res = await askPM(prompt, account, { phase: "summarize", runId: ctx.runId, projectId: ctx.projectId });
  } catch (e) {
    log("pm", `⚠️ 迭代小结生成失败，用兜底：${String(e).slice(0, 120)}`);
    return "- （本轮 PM 未给出缺口说明）";
  }
  // 去掉可能混入的代码围栏
  let text = res.text.replace(/```(?:markdown|md)?/gi, "").replace(/```/g, "").trim();
  if (!text) {
    return "- （本轮 PM 未给出缺口说明）";
  }
  emitEvent({
    type: "pm.iteration",
    ts: Date.now(),
    runId: ctx.runId,
    projectId: ctx.projectId,
    round,
    accountId: account.id,
    summary: text,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });
  return text;
}

// =========================================================================
// 【Step 4 PM overhaul】validateResults：PM 真验证
// =========================================================================

export interface ValidationCheck {
  name: string;
  ok: boolean;
  note: string;
}

export interface ValidationResult {
  checks: ValidationCheck[];
  gaps: string[];
  blockers: string[];
  /** PM 验证自己失败 / 输出解析失败时的兜底文本，给 orchestrator / UI 可见 */
  rawText: string;
}

/**
 * PM 内置的"真验证"阶段 —— 唯一被授权使用文件/命令工具的 PM 子调用。
 *
 * 设计要点：
 *  - tools: ["Read","Bash","Glob","Grep"] + cwd=workspace，所以 PM 能直接打开 index.html、
 *    跑 lighthouse-audit.sh、grep 品牌名。
 *  - 不读 SPEC 之外的文件（worker.ts 的 cwd 边界）。
 *  - 返回 JSON {checks, gaps, blockers}，缺字段时给空数组兜底，orchestrator 不会崩。
 *  - 异常（quota / SDK error）返回 {checks:[], gaps:[], blockers:[], rawText}，
 *    orchestrator 会 fallback 到 summarizeIteration 走原路径。
 */
export async function validateResults(
  goal: string,
  results: WorkerResult[],
  round: number,
  account: Account,
  workspace: string,
  ctx: { runId: string; projectId: string }
): Promise<ValidationResult> {
  // 收集 worker 的实际产出文件列表（路径）
  const changedPaths = Array.from(
    new Set(
      results
        .flatMap((r) => r.changedFiles ?? [])
        .map((p) => p.replace(workspace, "."))
        .filter(Boolean)
    )
  );

  const prompt = `项目目标：
${goal}

这是第 ${round} 轮，各岗位已报告：
${results.map((r) => `- [${r.role}/${r.account}] 改了: ${(r.changedFiles ?? []).map((f) => f.replace(workspace, ".")).join(", ") || "（无）"}\n  摘要: ${r.finalText.slice(0, 200)}`).join("\n")}

工作目录是：${workspace}（即 .）

【请用 Read/Bash/Glob/Grep 工具实际去看 workspace/】
必检清单（每项必须给 ok=true/false + 一句话 note）：
  1. SPEC 明确列出的交付物（README.md, index.html, assets/logo.svg, assets/products/, assets/sources/, assets/badges/）是否全部存在？
  2. index.html 是否包含 SPEC 列出的全部锚点区块？（用 grep 检 #hero/#story/#sources/#products/#quality/#sustainability/#news/#contact/#footer）
  3. 品牌名是否一致？（SPEC/REQUIREMENTS/DESIGN 写的品牌 vs. 实际 index.html / content/ 写的品牌）
  4. 已知 FAIL 是否仍存在？（focus outline 是否 2px #2D8B3D；关闭状态下菜单链接是否还能 Tab；768px 导航是否被裁；表单 email 错误是否可见）
  5. tester 是否输出 test-report.md 且有 PASS/FAIL 判定？
  6. README.md 是否存在且不含 <TBD>/<TODO> 等占位符？

输出严格 JSON（不要 markdown 围栏、不要解释）：
{"checks":[{"name":"...","ok":true,"note":"..."}], "gaps":["..."], "blockers":["..."]}

- gaps：本轮没做完、可下一轮补的不足。
- blockers：阻断项目收工的关键缺失（例如「README.md 完全不存在」「index.html 没有任何锚点」）。
即使你之后在 review() 决定收工，orchestrator 也会自动用 blockers 强制追加一轮。`;

  let res;
  try {
    res = await askPM(prompt, account, {
      phase: "validate",
      tools: ["Read", "Bash", "Glob", "Grep"],
      cwd: workspace,
      runId: ctx.runId,
      projectId: ctx.projectId,
    });
  } catch (e) {
    log("pm", `⚠️ PM 验证异常：${String(e).slice(0, 120)}`);
    return { checks: [], gaps: [], blockers: [], rawText: String(e).slice(0, 200) };
  }

  // 解析 JSON 输出
  const rawText = res.text.trim();
  const cleaned = rawText.replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
  let parsed: any = null;
  try {
    // 先尝试整段 parse，失败再退化为 extractObjects（截断容错）
    parsed = JSON.parse(cleaned);
  } catch {
    const objs = extractObjects(cleaned);
    // 找包含 checks/gaps/blockers 的那个对象
    parsed = objs.find((o) => o && (Array.isArray(o.checks) || Array.isArray(o.gaps) || Array.isArray(o.blockers))) ?? null;
  }

  const checks: ValidationCheck[] = Array.isArray(parsed?.checks)
    ? (parsed.checks as any[])
        .filter((c) => c && typeof c === "object" && typeof c.name === "string")
        .map((c) => ({
          name: String(c.name),
          ok: !!c.ok,
          note: typeof c.note === "string" ? c.note : "",
        }))
    : [];

  const gaps: string[] = Array.isArray(parsed?.gaps)
    ? (parsed.gaps as any[]).filter((g) => typeof g === "string" && g.trim()).map(String)
    : [];

  const blockers: string[] = Array.isArray(parsed?.blockers)
    ? (parsed.blockers as any[]).filter((b) => typeof b === "string" && b.trim()).map(String)
    : [];

  if (!parsed) {
    log("pm", `⚠️ PM 验证输出解析失败，原文前 200 字：${rawText.slice(0, 200)}`);
  }

  // PM 验证日志
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  log(
    "pm",
    `🔍 第 ${round} 轮 VALIDATE 完成：${passed}/${checks.length} 项通过，` +
      `${failed} 项失败，${gaps.length} 个 gap，${blockers.length} 个 blocker` +
      `（pm.in=${res.inputTokens} pm.out=${res.outputTokens}）`
  );
  if (checks.length > 0) {
    for (const c of checks) {
      log("pm", `   ${c.ok ? "✅" : "❌"} ${c.name} :: ${c.note}`);
    }
  }
  if (blockers.length > 0) {
    log("pm", `🚧 BLOCKERS:\n${blockers.map((b) => `   - ${b}`).join("\n")}`);
  }

  emitEvent({
    type: "pm.validate",
    ts: Date.now(),
    runId: ctx.runId,
    projectId: ctx.projectId,
    round,
    accountId: account.id,
    checks,
    gaps,
    blockers,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });

  return { checks, gaps, blockers, rawText };
}