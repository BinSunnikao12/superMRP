import { ACCOUNTS } from "./config.js";
import { runWorker } from "./worker.js";
import { pickAccount } from "./accountPool.js";
import { parseCli, resolveProject, ensureProjectDirs } from "./projectPaths.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 冒烟测试：用 1 个账号跑 1 个最小 developer 任务，验证：
 *  - env 注入生效（tokens > 0）
 *  - 能在 workspace 写文件（并实际检查文件落盘）
 *  - 日志落盘
 * 用法：npx tsx src/smoke.ts            （legacy 项目，根 workspace/）
 *      npx tsx src/smoke.ts --project foo（隔离项目 foo，workspace/foo）
 */
const CLI = parseCli(process.argv.slice(2));
const RESOLVED = resolveProject({ projectId: CLI.projectId, goalArg: CLI.goalArg });
ensureProjectDirs(RESOLVED.paths);
const WORKSPACE = RESOLVED.paths.workspaceDir;
const HELLO = join(WORKSPACE, "hello.html");

async function main() {
  // 清掉上一次的 hello.html，避免误判
  try { if (existsSync(HELLO)) await import("node:fs").then(fs => fs.promises.unlink(HELLO)); } catch {}

  mkdirSync(WORKSPACE, { recursive: true });
  const pick = pickAccount(0);
  if (!pick) {
    console.error("⚠️ 所有 key 都已耗尽，先调大 PER_KEY_TOKEN_BUDGET 再冒烟。");
    process.exit(1);
  }
  const account = pick.account;
  console.log(`发现 ${ACCOUNTS.length} 个账号：${ACCOUNTS.map((a) => a.id).join(", ")}；冒烟用 ${account.id}（项目=${RESOLVED.id}）`);
  const r = await runWorker({
    task: {
      role: "developer",
      instruction:
        "在当前目录创建一个 hello.html，内容是一个写着「多Agent冒烟测试成功」的居中标题页面。完成后简述你做了什么。",
    },
    account,
    workspace: WORKSPACE,
    ctx: { projectId: RESOLVED.id },
  });
  console.log("\n===== 冒烟结果 =====");
  console.log(`角色=${r.role} 账号=${r.account} tokens=${r.tokens} 耗尽=${!!r.exhausted}`);
  console.log(`session=${r.sessionId}`);

  if (r.tokens === 0) {
    console.error("⚠️ tokens=0：env 可能没生效，检查 SDK 版本和 key。");
    process.exit(1);
  }
  if (r.exhausted) {
    console.error("⚠️ 这次调用被识别为配额/限流错误，请检查 key 余额。");
    process.exit(1);
  }
  if (!existsSync(HELLO)) {
    console.error(`⚠️ ${HELLO} 没生成，worker 没真正写文件。`);
    process.exit(1);
  }
  console.log(`✅ 冒烟通过：${HELLO} 存在，logs/developer.md 有流水。`);
}

main().catch((e) => {
  console.error("冒烟失败：", e);
  process.exit(1);
});
