/**
 * src/phases/pullImaf.ts
 * ============================================================
 * 5 据点并发拉 imaf_t 同步到 raw_base（增量同步）
 *
 * 流程：
 *   1. 读 pull_state（每 site last_successful_time）
 *   2. 5 路并发：每 site 一路 worker
 *      worker 内部：DELETE site=this → 分页拉 imaf_t(siteList=site) → INSERT
 *   3. 每路拉完：UPDATE pull_state.last_successful_time = NOW()
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
        return new Date('1900-01-01T00:00:00Z');
    } finally {
        conn.release();
    }
}

async function setLastSuccessfulTime(site: string, apiKey: string, totalRows: number, durationMs: number): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(
            `INSERT INTO pull_state (site, api_key, last_successful_time, last_total_rows, last_duration_ms)
             VALUES (?, ?, DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'), ?, ?)
             ON DUPLICATE KEY UPDATE
               last_successful_time = DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'),
               last_total_rows = VALUES(last_total_rows),
               last_duration_ms = VALUES(last_duration_ms)`,
            [site, apiKey, totalRows, durationMs],
        );
    } finally {
        conn.release();
    }
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

async function pullOneSite(site: string, lastPullTime: Date, batchSize: number = 1000): Promise<{ rows: number; durationMs: number }> {
    const BATCH = batchSize;  // 可从外部传（env 控制），默认 1000
    const t0 = Date.now();

    // 1) 获取 raw_base 实际列（避免对不存在的列 INSERT）
    let targetCols: Set<string>;
    const metaConn = await mysqlPool().getConnection();
    try {
        const [colRows] = await metaConn.execute(
            `SELECT COLUMN_NAME FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'raw_base'`,
        ) as any;
        targetCols = new Set<string>((colRows as any[]).map((r: any) => r.COLUMN_NAME));
    } finally {
        metaConn.release();
    }

    const lastPullTimeStr = lastPullTime.toISOString().slice(0, 19).replace('T', ' ');

    // 2) 覆盖式：清空该 site 数据（拉增量是 diff 语义，简化用 REPLACE）
    const delConn = await mysqlPool().getConnection();
    try {
        await delConn.query('DELETE FROM raw_base WHERE site = ?', [site]);
    } finally {
        delConn.release();
    }

    // 3) 分页拉取
    let totalInserted = 0;
    let page = 1;
    while (true) {
        const data = await runApi<any>('tiptop_query_imaf_t', {
            siteList: site,
            lastPullTime: lastPullTimeStr,
            page,
            pageSize: BATCH,
        });
        const rows = data?.rows || [];
        if (rows.length === 0) break;
        console.log(`[${site}] page ${page} got ${rows.length} rows`);

        // 4) 映射 + 写库
        const mapped = rows.map((r: any) => {
            const m: any = {};
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

        const insertConn = await mysqlPool().getConnection();
        try {
            const cols = Object.keys(mapped[0]);
            const placeholders = mapped.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
            const params: any[] = [];
            for (const r of mapped) {
                for (const c of cols) params.push(r[c] ?? null);
            }
            await insertConn.query(
                `INSERT INTO raw_base (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${placeholders}`,
                params,
            );
            totalInserted += rows.length;
        } finally {
            insertConn.release();
        }

        console.log(`  inserted ${rows.length}, total ${totalInserted}`);
        if (rows.length < BATCH) break;
        page++;
        if (page > 5000) {
            console.log(`[${site}] hit 5000-page safety limit`);
            break;
        }
    }
    return { rows: totalInserted, durationMs: Date.now() - t0 };
}

async function main() {
    const sites = (process.env.MRP_SITES || 'LG,YN,QU,FN,GX').split(',');
    const t0 = Date.now();
    const apiKey = 'tiptop_query_imaf_t';

    // 20 路并发：5 site × 4 worker = 20
    //  - 探每 site total（5 路并发）→ 计算总页数
    //  - 每 site 拆 4 个 page 区间（worker 0..3）
    //  - 20 worker 并发跑
    const CONCURRENCY = parseInt(process.env.PULL_CONCURRENCY || '20', 10);
    const PER_SITE = Math.max(1, Math.floor(CONCURRENCY / sites.length));
    console.log(`[pullImaf] concurrency=${CONCURRENCY} per_site=${PER_SITE}`);

    // 第一步：5 路并发探每 site total
    const totalPerSite = await Promise.all(
        sites.map(async (site) => {
            const lastPullTime = await getLastSuccessfulTime(site, apiKey);
            const data = await runApi<any>('tiptop_query_imaf_t', {
                siteList: site,
                lastPullTime: lastPullTime.toISOString().slice(0, 19).replace('T', ' '),
                page: 1,
                pageSize: 1,
            });
            const total = data?.total || 0;
            const BATCH_SIZE = 1000;
            const pages = Math.ceil(total / BATCH_SIZE);
            console.log(`[${site}] total=${total} pages≈${pages} (batch=${BATCH_SIZE})`);
            return { site, lastPullTime, total, pages };
        }),
    );

    // 第二步：拆分任务 (5 site × 4 worker = 20)
    interface Task { site: string; workerId: number; startPage: number; endPage: number; }
    const tasks: Task[] = [];
    for (const info of totalPerSite) {
        const { site, pages } = info;
        const perTask = Math.max(1, Math.ceil(pages / PER_SITE));
        for (let w = 0; w < PER_SITE; w++) {
            const startPage = w * perTask + 1;
            const endPage = Math.min((w + 1) * perTask, pages);
            if (startPage > endPage) continue;
            tasks.push({ site, workerId: w, startPage, endPage });
        }
    }
    console.log(`[pullImaf] total tasks: ${tasks.length}`);

    // 第三步：UPSERT 不需要 DELETE（unique key 冲突时直接更新）
    console.log(`[pullImaf] using UPSERT (no DELETE needed)`);

    // 第四步：限 CONCURRENCY 路并发拉 + 写
    //   imaf_t 测试：2 路并发 OK，5 路并发 OK，20 路并发 V8 直接卡死
    //   经验值：CE 平台 V8 引擎最多同时处理 ~5 个 HTTP 请求
    //   我们用 CONCURRENCY 路全局信号量限流（默认 5）
    const SEMAPHORE = parseInt(process.env.PULL_CONCURRENCY || '5', 10);
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

    let totalRows = 0;
    const startAll = Date.now();
    // 错峰启动：每路间隔 STAGGER_MS（默认 30s）— 让 V8 单线程不被打爆
    const STAGGER_MS = parseInt(process.env.PULL_STAGGER_MS || '30000', 10);
    await Promise.allSettled(tasks.map(async (task, idx) => {
        if (STAGGER_MS > 0 && idx > 0) {
            console.log(`[${task.site}/w${task.workerId}] waiting ${(STAGGER_MS * idx) / 1000}s before start (stagger)...`);
            await new Promise(r => setTimeout(r, STAGGER_MS * idx));
        }
        await acquire();
        try {
            const t0 = Date.now();
            const info = totalPerSite.find(i => i.site === task.site)!;
            const lastPullTimeStr = info.lastPullTime.toISOString().slice(0, 19).replace('T', ' ');
            let inserted = 0;
            for (let page = task.startPage; page <= task.endPage; page++) {
                const data = await runApi<any>('tiptop_query_imaf_t', {
                    siteList: task.site,
                    lastPullTime: lastPullTimeStr,
                    page,
                    pageSize: 1000,
                });
                const rows = data?.rows || [];
                if (rows.length === 0) break;
                await insertBatch(task.site, rows);
                inserted += rows.length;
                // 每 100 页打进度 log
                if (page % 100 === 0) {
                    console.log(`  [${task.site}/w${task.workerId}] page ${page}/${task.endPage} inserted ${inserted}`);
                }
            }
            const elapsed = (Date.now() - t0) / 1000;
            console.log(`[${task.site}/w${task.workerId}] pages ${task.startPage}-${task.endPage} done: ${inserted} rows in ${elapsed}s`);
            return inserted;
        } finally {
            release();
        }
    })).then(results => {
        for (const r of results) {
            if (r.status === 'fulfilled') totalRows += r.value;
            else console.error(`  failed: ${(r.reason as Error).message}`);
        }
    });

    // 第五步：更新 state
    for (const info of totalPerSite) {
        const siteRows = tasks
            .filter(t => t.site === info.site)
            .reduce((s, t) => s + 1, 0);  // 占位
        await setLastSuccessfulTime(info.site, apiKey, totalRows / sites.length, Date.now() - startAll);
    }

    console.log(`[pullImaf] ALL DONE. total ${totalRows} rows in ${(Date.now() - t0) / 1000}s`);
    process.exit(0);
}

main().catch(e => {
    console.error('[pullImaf] fatal:', e);
    process.exit(1);
});
