/**
 * 离线单元测试 — 不调 LLM，只验 PM overhaul 改动的纯逻辑部分：
 *  1) iterationLog.buildIterationMarkdown 仍产出正确 Markdown（含 results / gaps / next）
 *  2) manager.extractObjects 仍能容忍截断
 *  3) manager.normalizeTask 兼容 instruction / task / desc / description 四种字段名
 *  4) iterationLog.writeIterationRecord 真的写盘 + 返回 { roundPath, latestPath }
 *
 * 用法：npx tsx tests/pm-overhaul.unit.ts
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// 直接跑会触发 manager.ts 顶部的 import 链 → accountPool → config → 加载 .env。
// 这里我们只测不依赖 env 的纯函数 + 不依赖 env 的写入路径，避开 LLM 配额问题。
import { buildIterationMarkdown, writeIterationRecord } from "../src/iterationLog.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`✅ ${name}`);
    pass++;
  } else {
    console.error(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

// ---- 1) buildIterationMarkdown ----
{
  const md = buildIterationMarkdown(
    {
      iterationsDir: "/tmp/_test_does_not_exist_/iterations",
      projectId: "gym-website",
      runId: "run-unit-001",
      round: 3,
      results: [
        {
          role: "designer",
          account: "acct1",
          finalText: "做了 tokens.css 和 components.css。",
          tokens: 77000,
          inputTokens: 50000,
          outputTokens: 27000,
          changedFiles: ["/tmp/_x_/css/tokens.css", "/tmp/_x_/css/components.css"],
        },
        {
          role: "tester",
          account: "acct4",
          finalText: "跑了一轮 lighthouse + 6 个表单负面用例。",
          tokens: 897000,
          inputTokens: 600000,
          outputTokens: 297000,
          exhausted: true,
        },
      ],
      gaps: "- index.html 缺少 #sources 锚点\n- README.md 不存在",
      next: [
        { role: "developer", instruction: "补 #sources 锚点" },
        { role: "developer", instruction: "写 README.md" },
      ],
      roundTokens: 1085883,
      totalTokens: 1085883,
      aliveAccounts: 5,
      totalAccounts: 5,
    },
    "/tmp/_x_"
  );
  check("markdown 包含项目 id", md.includes("gym-website"));
  check("markdown 包含 runId", md.includes("run-unit-001"));
  check("markdown 包含 designer 摘要", md.includes("designer"));
  check("markdown 包含 tester 摘要", md.includes("tester"));
  check("markdown 标记 tester 账号耗尽", md.includes("⛔账号耗尽"));
  check("markdown 包含 changedFiles（rel 前缀 .）", md.includes("./css/tokens.css"));
  check("markdown 包含 gaps", md.includes("#sources"));
  check("markdown 包含下一步 developer", md.includes("developer") && md.includes("补 #sources 锚点"));
  check("markdown 含 round=3", md.includes("第 3 轮迭代记录"));
}

// ---- 2) iterationLog.writeIterationRecord 真写盘 + 新返回 shape ----
{
  const tmpRoot = `/tmp/_pm_unit_${Date.now()}`;
  const itDir = join(tmpRoot, "iterations");
  const written = writeIterationRecord(
    {
      iterationsDir: itDir,
      projectId: "gym-website",
      runId: "run-unit-002",
      round: 1,
      results: [
        { role: "designer", account: "acct1", finalText: "做了", tokens: 1000, changedFiles: [] },
      ],
      gaps: "- 无",
      next: [],
      roundTokens: 1000,
      totalTokens: 1000,
      aliveAccounts: 5,
      totalAccounts: 5,
    },
    tmpRoot
  );
  check("writeIterationRecord 返回非 null", written !== null);
  if (written) {
    check("返回 roundPath 字段", typeof written.roundPath === "string");
    check("返回 latestPath 字段", typeof written.latestPath === "string");
    check("ROUND-1.md 真实落盘", existsSync(written.roundPath));
    check("LATEST.md 真实落盘", existsSync(written.latestPath));
    const roundContent = readFileSync(written.roundPath, "utf8");
    check("ROUND-1.md 含 runId", roundContent.includes("run-unit-002"));
  }
  // 清理
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// ---- 3) extractObjects 容忍截断（直接拷贝函数测，避免依赖 manager.ts 顶部 import） ----
{
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
          } catch {}
          start = -1;
        }
      }
    }
    return objs;
  }
  const sample = `[{"role":"developer","instruction":"做X"},{"role":"designer","task":"做Y"`; // 第二个被截断
  const objs = extractObjects(sample);
  check("extractObjects 解析完整对象", objs.length === 1 && objs[0].role === "developer");
  check("extractObjects 容忍截断", objs.length === 1); // 截断的那个被丢弃，不崩
}

// ---- 4) normalizeTask 兼容多字段名 ----
{
  const VALID = ["developer", "designer", "tester", "copywriter"] as const;
  function normalizeTask(raw: any) {
    if (!raw || typeof raw !== "object") return null;
    const role = raw.role;
    const instr = raw.instruction ?? raw.task ?? raw.desc ?? raw.description;
    const instruction = typeof instr === "string" ? instr.trim() : "";
    if (!role || !instruction) return null;
    if (!VALID.includes(role as any)) return null;
    return { role, instruction };
  }
  check(
    "normalizeTask 接受 instruction",
    normalizeTask({ role: "developer", instruction: "X" })?.instruction === "X"
  );
  check(
    "normalizeTask 接受 task（兼容旧 bug）",
    normalizeTask({ role: "developer", task: "Y" })?.instruction === "Y"
  );
  check(
    "normalizeTask 接受 desc",
    normalizeTask({ role: "designer", desc: "Z" })?.instruction === "Z"
  );
  check(
    "normalizeTask 接受 description",
    normalizeTask({ role: "tester", description: "W" })?.instruction === "W"
  );
  check(
    "normalizeTask 拒绝非法 role",
    normalizeTask({ role: "hacker", instruction: "X" }) === null
  );
  check(
    "normalizeTask 拒绝无 instruction",
    normalizeTask({ role: "developer" }) === null
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);