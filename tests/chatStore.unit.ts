/**
 * 离线单元测试 — chatStore + projectMemory（不调 LLM）：
 *  1) createThread / appendMessages / readThread 往返 + sessionId 更新 + 自动标题
 *  2) listThreads 按更新时间倒序 + 摘要字段
 *  3) deleteThread 幂等
 *  4) 非法项目 id / 线程 id 拒绝
 *  5) buildProjectMemory 对 gym-website 有内容、对空项目给占位
 *
 * 用法：npx tsx tests/chatStore.unit.ts
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  createThread,
  appendMessages,
  readThread,
  listThreads,
  deleteThread,
} from "../src/chatStore.js";
import { buildProjectMemory } from "../src/projectMemory.js";
import { resolveProject, REPO_ROOT } from "../src/projectPaths.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`✅ ${name}`); pass++; }
  else { console.error(`❌ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

const PROJ = "chatstore-unit-proj";

try {
  // 1) 往返
  const t = createThread(PROJ, "developer");
  check("createThread 默认标题", t.title === "新会话");
  appendMessages(PROJ, t.id, [{ who: "user", text: "帮我看看首页", ts: Date.now() }], {});
  appendMessages(PROJ, t.id, [{ who: "assistant", text: "好的", ts: Date.now() }], { sessionId: "sess-1" });
  const re = readThread(PROJ, t.id)!;
  check("appendMessages 累积", re.messages.length === 2, `${re.messages.length}`);
  check("sessionId 更新", re.sessionId === "sess-1");
  check("首条用户消息自动做标题", re.title === "帮我看看首页", re.title);

  // 2) 列表（用 updatedAt 手工拉开时间差，避免同毫秒创建导致排序不确定）
  const t2 = createThread(PROJ, "pm");
  await new Promise((r) => setTimeout(r, 5));
  appendMessages(PROJ, t2.id, [{ who: "user", text: "第二个会话", ts: Date.now() }], {});
  const list = listThreads(PROJ);
  check("listThreads 含两个", list.length === 2, `${list.length}`);
  check("按更新时间倒序（t2 在前）", list[0].id === t2.id, list.map((x) => x.id).join(","));
  check("摘要含 messageCount", typeof list[0].messageCount === "number");

  // 3) 删除
  check("deleteThread 返回 true", deleteThread(PROJ, t.id) === true);
  check("deleteThread 幂等 false", deleteThread(PROJ, t.id) === false);
  check("删后列表剩 1", listThreads(PROJ).length === 1);

  // 4) 非法拒绝
  let threw = false;
  try { readThread("../etc", "t-x"); } catch { threw = true; }
  check("非法项目 id 拒绝", threw);
  let threw2 = false;
  try { readThread(PROJ, "../../evil"); } catch { threw2 = true; }
  check("非法线程 id 拒绝", threw2);

  // 5) projectMemory
  const memGym = buildProjectMemory("gym-website");
  check("gym-website 记忆非空且含迭代记录", memGym.includes("迭代记录") || memGym.includes("RUN_REPORT") || memGym.length > 100, `len=${memGym.length}`);
  const memEmpty = buildProjectMemory(PROJ);
  check("空项目给占位", memEmpty.includes("还没有") || memEmpty.includes("项目记忆"), memEmpty.slice(0, 60));
} finally {
  try {
    const p = resolveProject({ projectId: PROJ }).paths;
    rmSync(p.sessionDir, { recursive: true, force: true });
    rmSync(p.workspaceDir, { recursive: true, force: true });
    rmSync(join(REPO_ROOT, "goals", PROJ), { recursive: true, force: true });
  } catch {}
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
