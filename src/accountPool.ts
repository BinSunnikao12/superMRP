import { ACCOUNTS } from "./config.js";
import { log } from "./log.js";

/**
 * 账户池（token-aware round-robin + 耗尽自动换下一个）
 * --------------------------------------------------------------
 * - 每个账号独立追踪本进程内累计 token 用量；
 * - 拿号时按 round-robin 找下一个「未耗尽」账号；所有人都耗尽则返回 null；
 * - 「耗尽」= 已用 token ≥ PER_KEY_TOKEN_BUDGET；
 * - KEY_FALLBACK=off 时退化成「永远用 ACCOUNTS[0]」，跟旧行为完全一致；
 * - 同样支持外部的「硬限额」：如果本轮 error/tokens=0 等异常堆积，调用方可以
 *   调用 markExhausted(accountId) 主动把某个账号标记为不可用。
 *
 * 这是单一可变状态（spentByAccount）来源；orchestrator 和 worker 都用它。
 */

export const KEY_FALLBACK: boolean =
  (process.env.KEY_FALLBACK || "off").toLowerCase() === "on";

export const PER_KEY_TOKEN_BUDGET: number =
  Number(process.env.PER_KEY_TOKEN_BUDGET) || 1_000_000;

// 每个账号已消耗的 token；key = Account.id（"acct1".."acct5"）。
const spentByAccount: Map<string, number> = new Map();

function isExhausted(id: string): boolean {
  return (spentByAccount.get(id) ?? 0) >= PER_KEY_TOKEN_BUDGET;
}

function nextAlive(startIdx: number): { account: typeof ACCOUNTS[number]; index: number } | null {
  const n = ACCOUNTS.length;
  for (let off = 0; off < n; off++) {
    const i = (startIdx + off) % n;
    const a = ACCOUNTS[i];
    if (!isExhausted(a.id)) return { account: a, index: i };
  }
  return null;
}

/** 选下一个可用账号；返回 null 表示所有 key 都耗尽了。 */
export function pickAccount(startIdx = 0): { account: typeof ACCOUNTS[number]; index: number } | null {
  if (!KEY_FALLBACK) {
    // 旧行为：始终用 ACCOUNTS[0]，不去管它是否耗尽（让上层报 429/限额错）。
    return { account: ACCOUNTS[0], index: 0 };
  }
  return nextAlive(startIdx);
}

/** 把刚跑完一轮的 token 用量记到对应账号名下；越界自动封顶在 PER_KEY_TOKEN_BUDGET。 */
export function recordUsage(accountId: string, tokens: number): void {
  const prev = spentByAccount.get(accountId) ?? 0;
  const next = Math.min(prev + Math.max(0, tokens), PER_KEY_TOKEN_BUDGET);
  spentByAccount.set(accountId, next);
  if (next >= PER_KEY_TOKEN_BUDGET) {
    log("pool", `🔚 ${accountId} 已达预算上限 ${PER_KEY_TOKEN_BUDGET}，标记为耗尽`);
  }
}

/** 把某个账号直接踢出可用队列（例如它当前轮次就报 429/insufficient_quota）。 */
export function markExhausted(accountId: string, reason: string): void {
  spentByAccount.set(accountId, PER_KEY_TOKEN_BUDGET);
  log("pool", `⛔ ${accountId} 被强制标记为耗尽：${reason}`);
}

/** 当前还活着的账号数（调试 / 上报用）。 */
export function aliveCount(): number {
  return ACCOUNTS.reduce((n, a) => n + (isExhausted(a.id) ? 0 : 1), 0);
}

/** 所有账号都耗尽了？ */
export function allExhausted(): boolean {
  return ACCOUNTS.every((a) => isExhausted(a.id));
}

/** 取一份快照给 RUN_REPORT.json。 */
export function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of ACCOUNTS) out[a.id] = spentByAccount.get(a.id) ?? 0;
  return out;
}