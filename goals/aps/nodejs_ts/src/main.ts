/**
 * main.ts
 * ============================================================
 * APS MRP 入口（Node.js + TypeScript 复刻版 + 优化）
 *
 * 5 个基地并发跑：
 *   - 原来按站点串行：总耗时 = Σ(t_i)
 *   - 改成 Promise.allSettled：总耗时 ≈ max(t_i)
 *
 * 跑完所有基地后启动 HTTP 下载服务（httpServer.ts）：
 *   - 浏览器打开 http://localhost:8080/ 看所有报告
 *   - 或 curl /api/files 看清单
 *
 * 与 python/main.py 一一对应，逻辑完全一致。
 *
 * 使用方式：
 *   cd nodejs_ts
 *   npm install
 *   npm run build
 *   npm start
 */
import { f as excelF } from './excel/excel';
import { config } from './config';
import { shutdownAllPools, initOraclePool } from './data/dbPools';
import { cachePool } from './cache/ttlLru';
import { startHttpServer } from './httpServer';

async function main(): Promise<void> {
    const start = Date.now();
    console.log('[main] 启动 APS MRP');
    console.log('[main] 待处理基地:', config.sites.join(', '));
    console.log('[main] Oracle 数据源:', process.env.MRP_ORACLE_SOURCE || 'api',
        `(mock=${config.api.mockMode}, baseUrl=${config.api.baseUrl})`);

    // 初始化 Oracle 池（仅 direct 模式才需要）
    if ((process.env.MRP_ORACLE_SOURCE || 'api') === 'direct') {
        await initOraclePool();
    }

    // 并发跑 5 个基地，allSettled 保证一个失败不影响其他
    const results = await Promise.allSettled(
        config.sites.map(async site => {
            const t0 = Date.now();
            console.log(`[${site}] 开始`);
            await excelF(site);
            console.log(`[${site}] 完成  耗时 ${(Date.now() - t0) / 1000}s`);
            return site;
        }),
    );

    for (const r of results) {
        if (r.status === 'rejected') {
            console.error(`基地处理失败: ${(r.reason as Error).message}`);
        }
    }

    // 缓存命中统计
    const stats = cachePool.allStats();
    const totalHits = Object.values(stats).reduce((a, s) => a + s.hits, 0);
    const totalMisses = Object.values(stats).reduce((a, s) => a + s.misses, 0);
    const total = totalHits + totalMisses;
    console.log(`[main] 缓存命中率: ${total === 0 ? 0 : ((totalHits / total) * 100).toFixed(1)}% (${totalHits}/${total})`);

    console.log(`[main] 全部完成 总耗时 ${(Date.now() - start) / 1000}s`);

    // ----- 启动 HTTP 下载服务（常驻）-----
    // 输出目录 = env 优先，否则相对项目根的 ./output
    const outputDir = process.env.APS_OUTPUT_DIR || `${process.cwd()}/output`;
    const httpServer = startHttpServer(outputDir);

    // 优雅关闭
    const shutdown = async (signal: string) => {
        console.log(`[main] 收到 ${signal}，开始关闭`);
        httpServer.close();
        await shutdownAllPools();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 容器内如果有 K8s liveness probe，可以探测 /health
    // 否则就一直 keep alive
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
