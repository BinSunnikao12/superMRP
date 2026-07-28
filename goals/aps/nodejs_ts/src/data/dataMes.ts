/**
 * src/data/dataMes.ts
 * ============================================================
 * 低代码平台 MES 备注（Node.js + TypeScript 复刻版 + 优化）
 *
 * 优化点：
 *   - 走 mysql2 连接池（dbPools.mesPool）
 *   - remark / ryjj 走 LRU 缓存（10 分钟 TTL）
 */
import { mesPool } from './dbPools';
import { cachePool } from '../cache/ttlLru';

export async function remark(): Promise<Map<string, any[]>> {
    if (process.env.SKIP_MES === 'true') return new Map();
    const pool = cachePool.get('__mes__', 'mes');
    return pool.wrap('remark', async () => {
        try {
            const conn = await mesPool().getConnection();
            try {
                const [rows] = await conn.execute(
                    'SELECT gendanM, beizhu, chengnuoJQ FROM diy_Remarks WHERE gendanM IS NOT NULL',
                );
                const map = new Map<string, any[]>();
                for (const i of rows as any[]) map.set(i[0], i);
                return map;
            } finally {
                conn.release();
            }
        } catch (e) {
            console.warn(`[mes] remark 读取失败 (${(e as Error).message})，返回空`);
            return new Map<string, any[]>();
        }
    });
}

export async function ryjj(): Promise<Map<string, string>> {
    if (process.env.SKIP_MES === 'true') return new Map();
    const pool = cachePool.get('__mes__', 'mes');
    return pool.wrap('ryjj', async () => {
        try {
            const conn = await mesPool().getConnection();
            try {
                const [rows] = await conn.execute(
                    `SELECT t0.yuancaiGRY AS 原采购员, t1.Name AS 新采购员
                     FROM diy_handover t0
                     JOIN sys_user t1 ON t0.jieshouRY = t1.Account
                     WHERE t0.isDeleted = false AND t1.IsDeleted = 0 AND t1.ShifouCGY = '是'`,
                );
                const map = new Map<string, string>();
                for (const i of rows as any[]) map.set(i[0], i[1]);
                return map;
            } finally {
                conn.release();
            }
        } catch (e) {
            console.warn(`[mes] ryjj 读取失败 (${(e as Error).message})，返回空`);
            return new Map<string, string>();
        }
    });
}
