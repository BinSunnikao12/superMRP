/**
 * 离线单元测试 — skillStore 纯逻辑（不调 LLM）：
 *  1) writeLibrary / readLibrary / listLibrary / deleteLibrary 往返
 *  2) installPreview 的 new / overwrite / identical 三态
 *  3) install 的 overwrite 守卫（无 confirm 抛错、有 confirm 成功）
 *  4) 条目名 / 项目 id 的路径穿越拒绝
 *
 * 用法：npx tsx tests/skillStore.unit.ts
 * 注意：会在 library/ 与 skills/kb 下建临时条目，跑完自动清理。
 */
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  writeLibrary,
  readLibrary,
  listLibrary,
  deleteLibrary,
  installPreview,
  install,
  listInstalled,
  isValidEntryName,
} from "../src/skillStore.js";
import { REPO_ROOT, resolveProject } from "../src/projectPaths.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`✅ ${name}`); pass++; }
  else { console.error(`❌ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

const NAME = "unit-test-skill";
const PROJ = "unit-test-proj";

try {
  // 1) 库往返
  writeLibrary("skill", NAME, "v1 content");
  check("readLibrary 返回写入内容", readLibrary("skill", NAME) === "v1 content");
  check("listLibrary 含新条目", listLibrary("skill").some((e) => e.name === NAME));

  // 2) preview: new
  let pv = installPreview("skill", NAME, PROJ);
  check("preview new", pv.action === "new", pv.action);

  // 3) install new
  let r = install("skill", NAME, PROJ);
  check("install new 成功", r.action === "new");
  check("listInstalled 含条目", listInstalled("skill", PROJ).some((e) => e.name === NAME));

  // 4) preview identical
  pv = installPreview("skill", NAME, PROJ);
  check("preview identical", pv.action === "identical", pv.action);

  // 5) 改库内容 → preview overwrite
  writeLibrary("skill", NAME, "v2 content CHANGED");
  pv = installPreview("skill", NAME, PROJ);
  check("preview overwrite", pv.action === "overwrite", pv.action);
  check("preview 带 targetContent", pv.targetContent === "v1 content");

  // 6) install overwrite 无 confirm 抛错
  let threw = false;
  try { install("skill", NAME, PROJ); } catch { threw = true; }
  check("install overwrite 无 confirm 抛错", threw);

  // 7) install overwrite 带 confirm 成功
  r = install("skill", NAME, PROJ, { confirmOverwrite: true });
  check("install overwrite 带 confirm 成功", r.action === "overwrite");

  // 8) 路径穿越拒绝
  check("isValidEntryName 拒绝 ..", !isValidEntryName("../x"));
  check("isValidEntryName 拒绝 /", !isValidEntryName("a/b"));
  let threw2 = false;
  try { readLibrary("skill", "../../etc/passwd"); } catch { threw2 = true; }
  check("readLibrary 拒绝穿越名", threw2);

  // 9) 删除
  check("deleteLibrary 返回 true", deleteLibrary("skill", NAME) === true);
  check("deleteLibrary 幂等 false", deleteLibrary("skill", NAME) === false);
} finally {
  // 清理
  try { rmSync(join(REPO_ROOT, "library", "skills", `${NAME}.md`), { force: true }); } catch {}
  try {
    const p = resolveProject({ projectId: PROJ }).paths;
    rmSync(p.skillsDir, { recursive: true, force: true });
    rmSync(p.workspaceDir, { recursive: true, force: true });
    rmSync(p.sessionDir, { recursive: true, force: true });
    rmSync(join(REPO_ROOT, "goals", PROJ), { recursive: true, force: true });
  } catch {}
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);