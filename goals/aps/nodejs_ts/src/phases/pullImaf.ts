/**
 * src/phases/pullImaf.ts
 * ============================================================
 * 5 据点并发拉 imaf_t 同步到 raw_base（支持断点续传）
 *
 * 流程：
 *   1. 读取或创建每站点固定时间窗口的 checkpoint
 *   2. 5 路并发、站点内顺序分页；每页 UPSERT 后立即记录页码
 *   3. 中断重跑时从 last_completed_page + 1 继续
 *   4. 全站点校验成功后才推进 pull_state 正式水位
 *
 * 性能：5 路并发 × 100 行/页 × ~1s/页 ≈ 2M/5 = 400k/路 → 4000 页/路 ≈ 67 分钟
 *       实际：每路 40w 行 / 100 行/页 = 4000 页 × 1s = 67 分钟
 *       但 V8 引擎是单进程多协程，5 路并发不一定能跑满
 *       跑起来 5 路每路 1.5 小时，总 1.5 小时（vs 串行 2.5 小时）
 */
import { runApi } from '../data/apiClient';
import { mysqlPool } from '../data/dbPools';

const LABEL_TO_COL: Record<string, string> = {
    '料件编号': 'part_no',
    '补给策略': 'supply_strategy',
    '需求计算方法': 'demand_calc_method',
    '安全库存量': 'safety_stock',
    '采购单位': 'po_uom',
    '采购单位批量': 'po_batch_qty',
    '最小采购数量': 'po_min_qty',
    '是否模块化': 'is_module',
    '采购员': 'buyer_code',
    '物控人员': 'mat_ctrl_code',
    '采购文档前置时间': 'doc_lt',
    '采购交货前置时间': 'delivery_lt',
    '采购到厂前置时间': 'arrival_lt',
    '采购入库前置时间': 'storage_lt',
    '严守交期前置时间': 'strict_delivery_lt',
    '计划员': 'planner',
    '生产损耗率': 'prod_loss_rate',
    '生产单位': 'mo_uom',
    '生产单位批量': 'mo_batch_qty',
    '最小生产数量': 'mo_min_qty',
    '标准人工工时': 'std_man_hour',
    '固定生产前置时间': 'fixed_lt',
    '变动生产前置时间': 'variable_lt',
    'QC前置时间': 'qc_lt',
    '累计前置时间': 'accum_lt',
    '是否采购过': 'has_purchased',
    '是否自制过': 'has_self_made',
    '研发是否采购过': 'rd_purchased',
    '研发是否自制过': 'rd_self_made',
    '成本中心名称': 'cc_name',
    '成本中心编码': 'cc_code',
    '产品名称': 'main_part_name',
    '产品规格': 'main_part_spec',
    '品名': 'main_part_name',
    '规格': 'main_part_spec',
    '默认BOM特性': 'bom_type',
    '工艺料号': 'process_part',
    '供给汇整时距': 'supply_interval',
    '工单拆分批量': 'wo_split_qty',
    '允许需求合并生产': 'allow_merge',
    '营运据点': 'imafsite',
    '说明(简称)': 'cc_name',
    '默认成本中心': 'default_cc',
};

function num(v: any): any {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toInt(v: any): any {
    const n = num(v);
    return n == null ? null : Math.trunc(n);
}

async function getLastSuccessfulTime(site: string, apiKey: string): Promise<Date> {
    const conn = await mysqlPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT last_successful_time FROM pull_state WHERE site = ? AND api_key = ?`,
            [site, apiKey],
        ) as any;
        if (rows.length > 0) return new Date(rows[0].last_successful_time);
        return new Date(1900, 0, 1, 0, 0, 0);
    } finally {
        conn.release();
    }
}

/**
 * 全量成功后移除源端已不存在的旧行，再核对本站点最终行数。
 * pulled_at 是本轮每次 UPSERT 都会更新的本地标记，因此清理不会影响本轮数据。
 */
async function finalizeFullSite(site: string, runStartedAt: Date, expectedRows: number): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute(
            `DELETE FROM raw_base WHERE site = ? AND pulled_at < ?`,
            [site, runStartedAt],
        );
        const [rows] = await conn.execute(
            `SELECT COUNT(*) AS total FROM raw_base WHERE site = ?`,
            [site],
        ) as any;
        const actualRows = Number(rows[0]?.total || 0);
        if (actualRows !== expectedRows) {
            throw new Error(
                `[${site}] final row count mismatch: expected ${expectedRows}, local ${actualRows}`,
            );
        }
        await conn.commit();
        console.log(`[${site}] full snapshot verified: ${actualRows} rows`);
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function setLastSuccessfulTime(
    site: string,
    apiKey: string,
    checkpoint: Date,
    totalRows: number,
    durationMs: number,
): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(
            `INSERT INTO pull_state (site, api_key, last_successful_time, last_total_rows, last_duration_ms)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               last_successful_time = VALUES(last_successful_time),
               last_total_rows = VALUES(last_total_rows),
               last_duration_ms = VALUES(last_duration_ms)`,
            [site, apiKey, checkpoint, totalRows, durationMs],
        );
    } finally {
        conn.release();
    }
}

/** Oracle 的 TO_DATE 接收业务时区字符串，不能用 toISOString() 转成 UTC 后截取。 */
function formatSqlDateTime(value: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return [
        value.getFullYear(),
        pad(value.getMonth() + 1),
        pad(value.getDate()),
    ].join('-') + ' ' + [
        pad(value.getHours()),
        pad(value.getMinutes()),
        pad(value.getSeconds()),
    ].join(':');
}

interface PullCheckpoint {
    site: string;
    apiKey: string;
    mode: 'full' | 'incr';
    lastPullTime: Date;
    upperPullTime: Date;
    batchSize: number;
    totalRows: number;
    totalPages: number;
    lastCompletedPage: number;
    pulledRows: number;
    startedAt: Date;
}

async function ensureCheckpointTable(): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS raw_base_pull_checkpoint (
              site VARCHAR(8) NOT NULL,
              api_key VARCHAR(64) NOT NULL,
              mode VARCHAR(16) NOT NULL,
              last_pull_time DATETIME NOT NULL,
              upper_pull_time DATETIME NOT NULL,
              batch_size INT NOT NULL,
              total_rows INT NOT NULL,
              total_pages INT NOT NULL,
              last_completed_page INT NOT NULL DEFAULT 0,
              pulled_rows INT NOT NULL DEFAULT 0,
              started_at DATETIME NOT NULL,
              status VARCHAR(16) NOT NULL DEFAULT 'running',
              error TEXT NULL,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (site, api_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    } finally {
        conn.release();
    }
}

async function loadResumableCheckpoint(
    site: string,
    apiKey: string,
    mode: 'full' | 'incr',
): Promise<PullCheckpoint | null> {
    const conn = await mysqlPool().getConnection();
    try {
        const [rows] = await conn.execute(
            `SELECT * FROM raw_base_pull_checkpoint
             WHERE site = ? AND api_key = ? AND mode = ?
               AND status IN ('running', 'failed')`,
            [site, apiKey, mode],
        ) as any;
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            site,
            apiKey,
            mode,
            lastPullTime: new Date(row.last_pull_time),
            upperPullTime: new Date(row.upper_pull_time),
            batchSize: Number(row.batch_size),
            totalRows: Number(row.total_rows),
            totalPages: Number(row.total_pages),
            lastCompletedPage: Number(row.last_completed_page),
            pulledRows: Number(row.pulled_rows),
            startedAt: new Date(row.started_at),
        };
    } finally {
        conn.release();
    }
}

async function saveNewCheckpoint(checkpoint: PullCheckpoint): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(
            `INSERT INTO raw_base_pull_checkpoint
               (site, api_key, mode, last_pull_time, upper_pull_time, batch_size,
                total_rows, total_pages, last_completed_page, pulled_rows, started_at, status, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'running', NULL)
             ON DUPLICATE KEY UPDATE
               mode = VALUES(mode), last_pull_time = VALUES(last_pull_time),
               upper_pull_time = VALUES(upper_pull_time), batch_size = VALUES(batch_size),
               total_rows = VALUES(total_rows), total_pages = VALUES(total_pages),
               last_completed_page = 0, pulled_rows = 0, started_at = VALUES(started_at),
               status = 'running', error = NULL`,
            [
                checkpoint.site, checkpoint.apiKey, checkpoint.mode,
                checkpoint.lastPullTime, checkpoint.upperPullTime, checkpoint.batchSize,
                checkpoint.totalRows, checkpoint.totalPages, checkpoint.startedAt,
            ],
        );
    } finally {
        conn.release();
    }
}

async function savePageProgress(site: string, apiKey: string, page: number, rowCount: number): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(
            `UPDATE raw_base_pull_checkpoint
             SET last_completed_page = ?, pulled_rows = pulled_rows + ?, status = 'running', error = NULL
             WHERE site = ? AND api_key = ?`,
            [page, rowCount, site, apiKey],
        );
    } finally {
        conn.release();
    }
}

async function markCheckpointStatus(
    site: string,
    apiKey: string,
    status: 'completed' | 'failed',
    error?: string,
): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(
            `UPDATE raw_base_pull_checkpoint SET status = ?, error = ?
             WHERE site = ? AND api_key = ?`,
            [status, error ? error.slice(0, 4000) : null, site, apiKey],
        );
    } finally {
        conn.release();
    }
}

async function runApiWithRetry<T>(apiKey: string, params: Record<string, any>): Promise<T> {
    const maxAttempts = Math.max(1, Number(process.env.PULL_PAGE_RETRIES || 5));
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await runApi<T>(apiKey, params);
        } catch (error) {
            lastError = error as Error;
            if (attempt === maxAttempts) break;
            const delayMs = Math.min(30_000, 1000 * Math.pow(2, attempt - 1));
            console.warn(`[retry] ${apiKey} attempt ${attempt}/${maxAttempts} failed: ${lastError.message}; wait ${delayMs}ms`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw lastError || new Error(`${apiKey} failed`);
}

/** 共享 insertBatch：每 worker 各自用一个连接，5 据点 × 4 路并发 = 20 路 pool 够 */
let _targetColsCache: Set<string> | null = null;
async function getTargetCols(): Promise<Set<string>> {
    if (_targetColsCache) return _targetColsCache;
    const conn = await mysqlPool().getConnection();
    try {
        const [colRows] = await conn.execute(
            `SELECT COLUMN_NAME FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'raw_base'`,
        ) as any;
        _targetColsCache = new Set<string>((colRows as any[]).map((r: any) => r.COLUMN_NAME));
        return _targetColsCache;
    } finally {
        conn.release();
    }
}

async function insertBatch(site: string, rows: any[]): Promise<number> {
    if (rows.length === 0) return 0;
    const targetCols = await getTargetCols();
    const mapped = rows.map((r: any) => {
        const m: any = { site };
        for (const [label, col] of Object.entries(LABEL_TO_COL)) {
            m[col] = r[label];
        }
        m.site = r['营运据点'] || site;
        m.pulled_at = new Date();
        m.safety_stock = num(m.safety_stock);
        m.po_batch_qty = num(m.po_batch_qty);
        m.po_min_qty = num(m.po_min_qty);
        m.doc_lt = toInt(m.doc_lt);
        m.delivery_lt = toInt(m.delivery_lt);
        m.arrival_lt = toInt(m.arrival_lt);
        m.storage_lt = toInt(m.storage_lt);
        m.strict_delivery_lt = toInt(m.strict_delivery_lt);
        m.prod_loss_rate = num(m.prod_loss_rate);
        m.mo_batch_qty = num(m.mo_batch_qty);
        m.mo_min_qty = num(m.mo_min_qty);
        m.std_man_hour = num(m.std_man_hour);
        m.fixed_lt = toInt(m.fixed_lt);
        m.variable_lt = toInt(m.variable_lt);
        m.qc_lt = toInt(m.qc_lt);
        m.accum_lt = toInt(m.accum_lt);
        const filtered: any = {};
        for (const c of Object.keys(m)) {
            if (targetCols.has(c)) filtered[c] = m[c] ?? null;
        }
        return filtered;
    });
    const cols = Object.keys(mapped[0]);
    const placeholders = mapped.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const params: any[] = [];
    for (const r of mapped) {
        for (const c of cols) params.push(r[c] ?? null);
    }
    const conn = await mysqlPool().getConnection();
    try {
        // UPSERT：按 (site, part_no, imafsite) 唯一键冲突时更新所有字段
        // （前提：raw_base 已建唯一索引 (site, part_no, imafsite)）
        const updateClause = cols.filter(c => c !== 'site' && c !== 'part_no' && c !== 'imafsite')
            .map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
        const sql = `INSERT INTO raw_base (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${placeholders}` +
            (updateClause ? ` ON DUPLICATE KEY UPDATE ${updateClause}` : '');
        await conn.query(sql, params);
    } finally {
        conn.release();
    }
    return mapped.length;
}

async function main() {
    const sites = (process.env.MRP_SITES || 'LG,YN,QU,FN,GX')
        .split(',').map(site => site.trim()).filter(Boolean);
    const t0 = Date.now();
    const apiKey = 'tiptop_query_imaf_t';
    const mode = process.env.PULL_MODE === 'full' ? 'full' : 'incr';
    const batchSize = Math.min(1000, Math.max(1, Number(process.env.PULL_BATCH_SIZE || 1000)));
    const CONCURRENCY = Math.max(1, parseInt(process.env.PULL_CONCURRENCY || '5', 10));
    console.log(`[pullImaf] mode=${mode} concurrency=${CONCURRENCY} batch=${batchSize}`);

    await ensureCheckpointTable();

    // 每个站点独立恢复自己的固定窗口；首次运行才创建新窗口并查询总数。
    const checkpoints = await Promise.all(
        sites.map(async (site) => {
            const saved = await loadResumableCheckpoint(site, apiKey, mode);
            if (saved) {
                console.log(
                    `[${site}] RESUME page ${saved.lastCompletedPage + 1}/${saved.totalPages}` +
                    ` rows=${saved.pulledRows}/${saved.totalRows}` +
                    ` window=(${formatSqlDateTime(saved.lastPullTime)}, ${formatSqlDateTime(saved.upperPullTime)}]`,
                );
                return saved;
            }

            const lastPullTime = mode === 'full'
                ? new Date(1900, 0, 1, 0, 0, 0)
                : await getLastSuccessfulTime(site, apiKey);
            const upperPullTime = new Date();
            const data = await runApiWithRetry<any>(apiKey, {
                siteList: site,
                lastPullTime: formatSqlDateTime(lastPullTime),
                upperPullTime: formatSqlDateTime(upperPullTime),
                page: 1,
                pageSize: 1,
            });
            const total = data?.total || 0;
            const checkpoint: PullCheckpoint = {
                site,
                apiKey,
                mode,
                lastPullTime,
                upperPullTime,
                batchSize,
                totalRows: total,
                totalPages: Math.ceil(total / batchSize),
                lastCompletedPage: 0,
                pulledRows: 0,
                startedAt: new Date(),
            };
            await saveNewCheckpoint(checkpoint);
            console.log(
                `[${site}] NEW total=${checkpoint.totalRows} pages=${checkpoint.totalPages}` +
                ` window=(${formatSqlDateTime(lastPullTime)}, ${formatSqlDateTime(upperPullTime)}]`,
            );
            return checkpoint;
        }),
    );

    if (process.env.PULL_PLAN_ONLY === 'true') {
        console.log('[pullImaf] plan-only: checkpoint discovery verified; no page downloaded');
        process.exit(0);
    }

    // 五站点并行、单站点内部严格顺序，last_completed_page 才能表示连续断点。
    const SEMAPHORE = CONCURRENCY;
    let active = 0;
    const waitQueue: Array<() => void> = [];
    const acquire = () => new Promise<void>((resolve) => {
        if (active < SEMAPHORE) { active++; resolve(); }
        else waitQueue.push(() => { active++; resolve(); });
    });
    const release = () => {
        active--;
        if (waitQueue.length > 0) {
            const next = waitQueue.shift();
            if (next) next();
        }
    };

    const failedSites = new Set<string>();
    const startAll = Date.now();
    const STAGGER_MS = parseInt(process.env.PULL_STAGGER_MS || '30000', 10);
    const results = await Promise.allSettled(checkpoints.map(async (checkpoint, idx) => {
        if (STAGGER_MS > 0 && idx > 0) {
            console.log(`[${checkpoint.site}] waiting ${(STAGGER_MS * idx) / 1000}s before start...`);
            await new Promise(r => setTimeout(r, STAGGER_MS * idx));
        }
        await acquire();
        try {
            let pulledRows = checkpoint.pulledRows;
            for (let page = checkpoint.lastCompletedPage + 1; page <= checkpoint.totalPages; page++) {
                const data = await runApiWithRetry<any>(apiKey, {
                    siteList: checkpoint.site,
                    lastPullTime: formatSqlDateTime(checkpoint.lastPullTime),
                    upperPullTime: formatSqlDateTime(checkpoint.upperPullTime),
                    page,
                    pageSize: checkpoint.batchSize,
                });
                const rows = data?.rows || [];
                if (rows.length === 0) {
                    throw new Error(`page ${page}/${checkpoint.totalPages} unexpectedly empty`);
                }
                await insertBatch(checkpoint.site, rows);
                await savePageProgress(checkpoint.site, apiKey, page, rows.length);
                pulledRows += rows.length;
                const percent = checkpoint.totalPages === 0 ? 100 : page / checkpoint.totalPages * 100;
                console.log(
                    `[${checkpoint.site}] page ${page}/${checkpoint.totalPages}` +
                    ` rows=${pulledRows}/${checkpoint.totalRows} ${percent.toFixed(1)}%`,
                );
            }
            return { site: checkpoint.site, pulledRows };
        } catch (error) {
            const message = (error as Error).message;
            failedSites.add(checkpoint.site);
            await markCheckpointStatus(checkpoint.site, apiKey, 'failed', message);
            throw new Error(`[${checkpoint.site}] ${message}`);
        } finally {
            release();
        }
    }));

    const pulledRowsBySite = new Map<string, number>();
    for (const result of results) {
        if (result.status === 'fulfilled') {
            pulledRowsBySite.set(result.value.site, result.value.pulledRows);
        } else {
            console.error(`  failed: ${(result.reason as Error).message}`);
        }
    }

    for (const checkpoint of checkpoints) {
        if (failedSites.has(checkpoint.site)) continue;
        const pulledRows = pulledRowsBySite.get(checkpoint.site) || 0;
        if (pulledRows !== checkpoint.totalRows) {
            const message =
                `row count mismatch: expected ${checkpoint.totalRows}, fetched ${pulledRows}`;
            failedSites.add(checkpoint.site);
            await markCheckpointStatus(checkpoint.site, apiKey, 'failed', message);
            console.error(`[${checkpoint.site}] ${message}`);
        }
    }

    if (mode === 'full') {
        for (const checkpoint of checkpoints) {
            if (failedSites.has(checkpoint.site)) continue;
            try {
                await finalizeFullSite(checkpoint.site, checkpoint.startedAt, checkpoint.totalRows);
            } catch (error) {
                failedSites.add(checkpoint.site);
                await markCheckpointStatus(checkpoint.site, apiKey, 'failed', (error as Error).message);
                console.error((error as Error).message);
            }
        }
    }

    let totalRows = 0;
    for (const checkpoint of checkpoints) {
        if (failedSites.has(checkpoint.site)) {
            console.error(`[${checkpoint.site}] pull failed; checkpoint kept for resume`);
            continue;
        }
        const pulledRows = pulledRowsBySite.get(checkpoint.site) || 0;
        totalRows += pulledRows;
        await setLastSuccessfulTime(
            checkpoint.site,
            apiKey,
            checkpoint.upperPullTime,
            pulledRows,
            Date.now() - startAll,
        );
        await markCheckpointStatus(checkpoint.site, apiKey, 'completed');
        console.log(`[${checkpoint.site}] checkpoint completed`);
    }

    if (failedSites.size > 0) {
        console.error(
            `[pullImaf] FAILED sites=${Array.from(failedSites).join(',')}; checkpoint not advanced`,
        );
        process.exit(1);
    }
    console.log(`[pullImaf] ALL DONE. total ${totalRows} rows in ${(Date.now() - t0) / 1000}s`);
    process.exit(0);
}

main().catch(e => {
    console.error('[pullImaf] fatal:', e);
    process.exit(1);
});
