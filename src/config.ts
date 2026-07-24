import "dotenv/config";

/**
 * 配置层：读取 .env 里的 5 个 MiniMax 账号 key，导出账号数组和 envFor()。
 * - 只填了几个 key 也没关系：空值会被过滤，用几个账号就并行几个。
 * - envFor() 是多账号的命门：每个 worker 用它把不同 key 注入到自己那次 query() 的 env。
 */

export const BASE_URL =
  process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/anthropic";
export const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2";

export interface Account {
  id: string;
  key: string;
}

export const ACCOUNTS: Account[] = [1, 2, 3, 4, 5]
  .map((i) => process.env[`MINIMAX_KEY_${i}`])
  .filter((k): k is string => !!k && k.trim().length > 0 && !k.includes("xxxx"))
  .map((key, i) => ({ id: `acct${i + 1}`, key: key.trim() }));

if (ACCOUNTS.length === 0) {
  throw new Error(
    "没有可用账号：请在 .env 里填入至少一个 MINIMAX_KEY_1（参考 .env.example）"
  );
}

/**
 * 单 worker 任务的 token 软上限。超过会 emit run.task.mega，
 * orchestrator 把这个 warning 喂给下轮 PM review，让 PM 下次把 tester/tester 等
 * "big-bang" 任务拆细。默认 250k tokens（≈ 含浏览器验证 + lighthouse 的合理上限）。
 * 设 0 表示禁用。
 */
export const MEGA_TASK_TOKEN_CAP: number =
  Number(process.env.MEGA_TASK_TOKEN_CAP) || 250_000;

/**
 * 为某个账号构造 query() 用的 env。
 * 关键点（见 GitHub issue #144 的教训）：
 *  1) 必须 merge ...process.env，否则子进程丢失 PATH/HOME 等，Bash/git 都会挂。
 *  2) 用 ANTHROPIC_AUTH_TOKEN（第三方兼容网关认这个），不要只设 ANTHROPIC_API_KEY。
 *  3) 需 SDK >= 0.2.73，否则 options.env 会被 ~/.claude/settings.json 覆盖。
 */
export function envFor(key: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    // 清掉可能干扰的官方 key，避免网关侧优先级混乱
    ANTHROPIC_API_KEY: "",
  };
}
