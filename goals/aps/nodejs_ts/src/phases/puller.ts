/**
 * src/phases/puller.ts
 * ============================================================
 * APS MRP 阶段 1：拉数据（pull）
 *
 * 流程（按你的要求）：
 *   1. **不一次性全查** — 每个接口都按 pageSize=1000 拉，循环到 lastPage
 *   2. **串行调接口** — V8 引擎不支持并发（"non-concurrent collections"），拉一个跑完再下一个
 *   3. **每个基地每个接口一条 pull_log**，记录开始/结束/耗时/总行数
 *   4. **每页直接 bulk insert 到 raw_* 表**（label/物理列名混合 → DB ASCII 列名映射）
 *
 * 入口：
 *   - 命令行：node dist/phases/puller.js LG         （拉一个基地）
 *   - 命令行：node dist/phases/puller.js LG,YN,QU   （多个基地）
 *   - 命令行：node dist/phases/puller.js all         （5 个基地全跑）
 */
import { runApi, type ApiRunParam } from '../data/apiClient';
import { mysqlPool } from '../data/dbPools';
import { config } from '../config';

// -----------------------------------------------------------------------------
// 拉取任务定义：每个接口 → 目标表 + 分页大小 + label→DB 列映射
// -----------------------------------------------------------------------------
type Row = Record<string, any>;

interface PullTask {
    apiKey: string;
    targetTable: string;
    pageSize: number;          // 每次拉多少
    /** 把 row 的 key 从 API 返回（label 或 物理列名）映射到 raw_* 表的 ASCII 列名 */
    mapRow: (row: Row) => Row;
    /** 同一张 Raw 表存在多个逻辑数据集时，只替换本数据集。 */
    scope?: { column: string; value: string };
    /** 传给 LowCode 接口的固定参数。 */
    params?: ApiRunParam;
    /** 快速模式下本任务的上限；共享表用它分摊 1000 条预算。 */
    sampleLimit?: number;
}

const LABEL_TO_COL: Record<string, string> = Object.assign({
    // raw_base
    '料件编号': 'part_no', '补给策略': 'supply_strategy', '需求计算方法': 'demand_calc_method',
    '安全库存量': 'safety_stock', '采购单位': 'po_uom', '采购单位批量': 'po_batch_qty',
    '最小采购数量': 'po_min_qty', '是否模块化': 'is_module', '采购员': 'buyer',
    '物控人员': 'mat_ctrl_code', '采购文档前置时间': 'doc_lt', '采购交货前置时间': 'delivery_lt',
    '采购到厂前置时间': 'arrival_lt', '采购入库前置时间': 'storage_lt',
    '严守交期前置时间': 'strict_delivery_lt', '计划员': 'planner', '生产损耗率': 'prod_loss_rate',
    '生产单位': 'mo_uom', '生产单位批量': 'mo_batch_qty', '最小生产数量': 'mo_min_qty',
    '标准人工工时': 'std_man_hour', '固定生产前置时间': 'fixed_lt',
    '变动生产前置时间': 'variable_lt', 'QC前置时间': 'qc_lt', '累计前置时间': 'accum_lt',
    '是否采购过': 'has_purchased', '是否自制过': 'has_self_made',
    '研发是否采购过': 'rd_purchased', '研发是否自制过': 'rd_self_made',
    '默认成本中心': 'default_cc', '成本中心名称': 'cc_name',
    '产品名称': 'main_part_name', '产品规格': 'main_part_spec',
    '成本中心编码': 'cc_code', '默认BOM特性': 'bom_type', '工艺料号': 'process_part',
    '供给汇整时距': 'supply_interval', '工单拆分批量': 'wo_split_qty',
    '允许需求合并生产': 'allow_merge', '营运据点': 'site',

    // raw_bom（label "主件" / "主件料号" 都映射到 main_part；"用量" / "组成用量" 都映射到 qty）
    '主件': 'main_part', '元件料号': 'sub_part', '用量': 'qty', '组成用量': 'qty',
    '主件类别': 'main_type', '元件类别': 'sub_type',
    '发料单位': 'issue_uom', '项次': 'seq',

    // raw_need (sf)
    '工单单号': 'doc_no', '预计开工日期': 'plan_start', '工单状态': 'status',
    '预计完工日期': 'plan_end', '主件料号': 'main_part', '主件需求数量': 'qty',
    '来源单号': 'src_doc',
    '包材未确认': 'package_pending',
    // raw_need (xmdd)
    '销售订单号': 'doc_no', '订单项次': 'sfbaseq', '可交货数量': 'qty', '客户': 'customer',

    // raw_remain / raw_cj / raw_in_transit / raw_testfunc
    '料号': 'part_no', '现有数量': 'qty', '在途数量': 'qty',
    '在验料号': 'part_no', '在验数量': 'qty', '在验量': 'qty',
    '在制数量': 'qty', '在制件号': 'sfba006', '在制数量_': 'qty',
    // 销售订单 / 工单的 字段重复定义在 raw_need 区域（line 54+），不重复
    // raw_buyer 的 采购员/供应商 已在 imaf_t 区域定义（同 key），此处不再重复

    // raw_outsourcing_type / raw_items
    'OOCQL004': 'outsource_type', 'IMAA130': 'material',
    'IMAAL001': 'part_no', 'IMAAL003': 'name', 'IMAAL004': 'spec',

    // raw_safetystock
    'IMAF001': 'part_no', 'IMAF026': 'qty', 'IMAF053': 'uom',

    // raw_production_supply
    'SFAC001': 'part_no', 'SFAC003': 'issued', 'SFAC005': 'received',

    // raw_cj (WIP)
    'SFBA006': 'sfba006', 'QPA分子': 'qpa_num', 'QPA分母': 'qpa_den',
    'SFBA013': 'sfba013', 'SFBA014': 'sfba014', 'SFBADOCNO': 'sfbadocno',

    // raw_purchase_order
    'PMDO001': 'pmdo001', 'ZTNUM': 'ztnum', 'ZTNUM2': 'ztnum2', 'PMDL004': 'pmdl004',
    'PMAAL003': 'pmaal003', 'CGD': 'cgd', 'CGD2': 'cgd2',
    'PMDLDOCDT': 'pmdldocdt', 'PMDO013': 'pmdo013', 'CJRQ': 'cjrq',
    'PMDLSTUS': 'pmdlstus', 'OOAG011': 'ooag011',
    '客户型号': 'customer_model', '公司型号': 'company_model',

    // raw_substitute
    'BMEA001': 'bmea001', 'BMEA003': 'bmea003', 'BMEA008': 'bmea008',
    'BMEA011': 'bmea011', 'BMEA012': 'bmea012', 'BMEA016': 'bmea016',
    'BMEA007': 'bmea007', 'BMEA015': 'bmea015',

    // raw_gd01
    'GD01数量': 'qty',
    // raw_gd_bom 复用 main_part / qty（已定义）
    '工单号': 'doc_no', '未交量': 'qty', '发料料号': 'sub_part',
    '用量比例': 'qpa',
});

/** 把一行 row 的 key 翻译成 raw_* 表的 ASCII 列名 */
function mapRow(labelToCol: Record<string, string>, row: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
        const col = labelToCol[k] || k;   // label 命中就用 ASCII；没命中保持原 key（多数是物理列名）
        out[col] = v;
    }
    return out;
}

/** 把 row 中的日期字符串转 Date，invalid → null（MySQL 接受 null） */
function toDate(v: any): Date | null {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

/** 把字符串转 number，invalid → null（避免 DECIMAL/VARCHAR 类型冲突） */
function toNum(v: any): number | null {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

/** 对 raw_* 表里的 DECIMAL 列做 toNum 转换（防止字符串塞进数字列） */
const DECIMAL_COLS: Record<string, string[]> = {
    raw_base: ['safety_stock', 'po_batch_qty', 'po_min_qty', 'doc_lt', 'delivery_lt',
               'arrival_lt', 'storage_lt', 'strict_delivery_lt', 'prod_loss_rate',
               'mo_batch_qty', 'mo_min_qty', 'std_man_hour', 'fixed_lt',
               'variable_lt', 'qc_lt', 'accum_lt'],
    raw_bom: ['qty'],
    raw_need: ['qty', 'qpa_num', 'qpa_den'],
    raw_remain: ['qty'],
    raw_in_transit: ['qty'],
    raw_purchase_order: ['ztnum', 'ztnum2'],
    raw_production_supply: ['issued', 'received', 'qty'],
    raw_buyer: [],
    raw_testfunc: ['qty'],
    raw_outsourcing_type: [],
    raw_items: [],
    raw_safetystock: ['qty'],
    raw_substitute: ['bmea016', 'bmea015'],
    raw_cj: ['qpa_num', 'qpa_den', 'sfba013', 'qty'],
    raw_gd01: ['qty'],
    raw_gd_bom: ['qty', 'qpa'],
    raw_special_supply: ['qty'],
};

/** 把 row 中所有日期字段归一化 */
function normalizeDates(row: Row, dateCols: string[]): Row {
    for (const c of dateCols) {
        if (c in row) row[c] = toDate(row[c]);
    }
    return row;
}

const PULL_TASKS: Record<string, Omit<PullTask, 'apiKey'>> = {
    imaf: {
        targetTable: 'raw_base',
        pageSize: 1000,   // 平台硬上限 1000
        mapRow: r => {
            // imaf_t 拉一次 site=ALL 即可拿全 5 据点 + ALL 的全集（81w 料号，每料号 5 行）
            // 入库时把 imafsite 当 site（不丢 5 据点分布）
            const m = mapRow(LABEL_TO_COL, r);
            if (m.imafsite) m.site = m.imafsite;
            delete m.imafsite;
            return m;
        },
    },
    sfaa: {
        targetTable: 'raw_need',
        pageSize: 1000,
        mapRow: r => {
            const m = mapRow(LABEL_TO_COL, r);
            m.source = 'sf';
            return normalizeDates(m, ['plan_start', 'plan_end', 'sfaaua002', 'sfaaua003', 'docdt']);
        },
        scope: { column: 'source', value: 'sf' },
        sampleLimit: 500,
    },
    sfba: {
        targetTable: 'raw_cj',
        pageSize: 1000,
        mapRow: r => ({
            part_no: r['SFBA006'] ?? r['料号'],
            qty: r['QTY'] ?? r['在制数量'],
        }),
    },
    xmdd: {
        targetTable: 'raw_need',
        pageSize: 1000,
        mapRow: r => {
            const m = mapRow(LABEL_TO_COL, r);
            m.source = 'xmdd';
            return normalizeDates(m, ['plan_start', 'docdt']);
        },
        scope: { column: 'source', value: 'xmdd' },
        sampleLimit: 500,
    },
    inag: {
        targetTable: 'raw_remain',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    in_transit: {
        targetTable: 'raw_in_transit',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    sfac: {
        targetTable: 'raw_production_supply',
        pageSize: 1000,
        mapRow: r => ({
            part_no: r['SFAC001'] ?? r['料号'],
            qty: r['QTY'] ?? r['工单供给'],
        }),
    },
    pmdn: {
        targetTable: 'raw_buyer',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    pmdt: {
        targetTable: 'raw_testfunc',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    purchase_order: {
        targetTable: 'raw_purchase_order',
        pageSize: 500,           // 这表大（万级），pageSize 小一些防 502
        mapRow: r => normalizeDates(mapRow(LABEL_TO_COL, r), ['pmdldocdt', 'pmdo013']),
    },
    bom: {
        targetTable: 'raw_bom',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    imaal: {
        targetTable: 'raw_items',
        pageSize: 1000,
        mapRow: r => {
            const m = mapRow(LABEL_TO_COL, r);
            m.lang = 'zh_CN';
            return m;
        },
        scope: { column: 'lang', value: 'zh_CN' },
        params: { lang: 'zh_CN' },
        sampleLimit: 500,
    },
    imaal_vi: {
        targetTable: 'raw_items',
        pageSize: 1000,
        mapRow: r => {
            const m = mapRow(LABEL_TO_COL, r);
            m.lang = 'vi_VN';
            return m;
        },
        scope: { column: 'lang', value: 'vi_VN' },
        params: { lang: 'vi_VN' },
        sampleLimit: 500,
    },
    imaa_oocql: {
        targetTable: 'raw_outsourcing_type',
        pageSize: 100,           // 这表 40w 行，必须小 pageSize
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    bmea: {
        targetTable: 'raw_substitute',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    gd01: {
        targetTable: 'raw_gd01',
        pageSize: 500,
        mapRow: r => ({
            part_no: r['SFAA010'] ?? r['主件'],
            qty: r['QTY'] ?? r['GD01数量'],
        }),
    },
    gd_bom: {
        targetTable: 'raw_gd_bom',
        pageSize: 500,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    safetystock: {
        targetTable: 'raw_safetystock',
        pageSize: 1000,
        mapRow: r => mapRow(LABEL_TO_COL, r),
    },
    special_supply: {
        targetTable: 'raw_special_supply',
        pageSize: 1000,
        mapRow: r => ({ part_no: r['ITEM_NO'], qty: r['QTY'] }),
    },
};

/** API key → task 短名 */
const API_KEY_TO_TASK: Record<string, keyof typeof PULL_TASKS> = {
    tiptop_query_imaf_t: 'imaf',
    tiptop_query_sfaa_t: 'sfaa',
    tiptop_query_sfba_t: 'sfba',
    tiptop_query_xmdd_t: 'xmdd',
    tiptop_query_inag_t: 'inag',
    tiptop_query_in_transit: 'in_transit',
    tiptop_query_sfac_t: 'sfac',
    tiptop_query_pmdn_t: 'pmdn',
    tiptop_query_pmdt_t: 'pmdt',
    tiptop_query_purchase_order: 'purchase_order',
    tiptop_query_bom: 'bom',
    tiptop_query_imaal_t: 'imaal',
    tiptop_query_imaa_oocql: 'imaa_oocql',
    tiptop_query_bmea_t: 'bmea',
    tiptop_query_gd01: 'gd01',
    tiptop_query_gd_bom: 'gd_bom',
    tiptop_query_safetystock: 'safetystock',
    tiptop_query_special_supply: 'special_supply',
};

interface PullJob { apiKey: string; taskName?: keyof typeof PULL_TASKS }

const PULL_ORDER: PullJob[] = [
    { apiKey: 'tiptop_query_bom' },
    { apiKey: 'tiptop_query_sfaa_t' },
    { apiKey: 'tiptop_query_sfba_t' },
    { apiKey: 'tiptop_query_xmdd_t' },
    { apiKey: 'tiptop_query_inag_t' },
    { apiKey: 'tiptop_query_in_transit' },
    { apiKey: 'tiptop_query_sfac_t' },
    { apiKey: 'tiptop_query_pmdn_t' },
    { apiKey: 'tiptop_query_pmdt_t' },
    { apiKey: 'tiptop_query_purchase_order' },
    { apiKey: 'tiptop_query_imaal_t', taskName: 'imaal' },
    { apiKey: 'tiptop_query_imaal_t', taskName: 'imaal_vi' },
    { apiKey: 'tiptop_query_safetystock' },
    { apiKey: 'tiptop_query_bmea_t' },
    { apiKey: 'tiptop_query_imaa_oocql' },
    { apiKey: 'tiptop_query_special_supply' },
    { apiKey: 'tiptop_query_gd01' },
    { apiKey: 'tiptop_query_gd_bom' },
];

/** 只跑指定 apiKey 列表（逗号分隔），用于单表验证 */
const ONLY_API: string[] = (process.env.PULL_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
if (ONLY_API.length > 0) {
    for (let i = PULL_ORDER.length - 1; i >= 0; i--) {
        if (!ONLY_API.includes(PULL_ORDER[i].apiKey)) PULL_ORDER.splice(i, 1);
    }
    console.log(`[pull] PULL_ONLY 过滤后仅跑：${PULL_ORDER.map(x => x.apiKey).join(', ')}`);
}

// -----------------------------------------------------------------------------
// 拉一个接口：分页循环 + 写入 + 写 pull_log
// -----------------------------------------------------------------------------
async function pullOne(site: string, apiKey: string, taskOverride?: keyof typeof PULL_TASKS): Promise<{ rows: number; pages: number; durationMs: number; error?: string }> {
    const taskName = taskOverride || API_KEY_TO_TASK[apiKey];
    if (!taskName) {
        return { rows: 0, pages: 0, durationMs: 0, error: `unknown apiKey: ${apiKey}` };
    }
    const task = { apiKey, ...PULL_TASKS[taskName] };
    const startedAt = new Date();
    const startTs = Date.now();

    const conn = await mysqlPool().getConnection();
    let logId: number | null = null;
    let totalRows = 0;
    let pageCount = 0;
    let errMsg: string | undefined;
    let targetCols: Record<string, number> = {};
    try {
        // 0) 先查目标表的列（用于过滤无效字段）
        const [colRows] = await conn.execute(
            `SELECT COLUMN_NAME AS c, ORDINAL_POSITION AS p
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ?`,
            [config.mysql.database, task.targetTable],
        );
        for (const r of colRows as any[]) {
            targetCols[r.c] = r.p;
        }

        // 1) 写 pull_log (status=running)
        const [r] = await conn.execute(
            `INSERT INTO pull_log (site, api_key, started_at, status) VALUES (?, ?, ?, 'running')`,
            [site, apiKey, startedAt],
        );
        logId = (r as any).insertId;

        // 2) 新批次先追加写入；全部成功后才清理旧批次，失败时旧数据仍可用。
        let page = 1;
        let expectedTotal: number | null = null;
        const configuredLimit = Number(process.env.PULL_ROW_LIMIT || 0);
        const rowLimit = configuredLimit > 0
            ? Math.min(configuredLimit, task.sampleLimit || configuredLimit)
            : null;
        while (true) {
            const remaining = rowLimit == null
                ? task.pageSize
                : Math.min(task.pageSize, rowLimit - totalRows);
            if (remaining <= 0) break;
            const param: ApiRunParam = { site, page, pageSize: remaining, ...(task.params || {}) };

            const data = await runApi<any>(apiKey, param);
            const rows: Row[] = (data?.rows as Row[]) || [];
            const pageTotal = Number(data?.total);
            if (Number.isFinite(pageTotal)) {
                if (expectedTotal == null) expectedTotal = pageTotal;
                else if (rowLimit == null && pageTotal !== expectedTotal) {
                    throw new Error(`source total changed while paging: ${expectedTotal} -> ${pageTotal}`);
                }
            }
            if (rows.length === 0) break;
            pageCount++;

            // 4) 映射 + 写库
            // 只保留 raw_* 表里实际存在的列（label→ascii col 翻译；没命中跳过）
            // 同时强制补 pulled_at
            const decCols = new Set(DECIMAL_COLS[task.targetTable] || []);
            const mappedRows = rows.map(r => {
                const m: Row = task.mapRow(r);
                const filtered: Row = { site };
                for (const [k, v] of Object.entries(m)) {
                    if (k === 'site') continue;
                    if (!(k in targetCols)) continue;
                    // DECIMAL 列：字符串转 number
                    if (decCols.has(k)) {
                        filtered[k] = toNum(v);
                    } else {
                        filtered[k] = v;
                    }
                }
                filtered.pulled_at = startedAt;
                return filtered;
            });
            if (mappedRows.length === 0) {
                // 没有有效列，仍然写一条 pulled_at 占位（保证 pull_log 闭合）
                await conn.execute(
                    `INSERT INTO ${task.targetTable} (site, pulled_at) VALUES (?, ?)`,
                    [site, startedAt],
                );
                break;
            }
            const cols = Object.keys(mappedRows[0]);
            const phs = Array.from({ length: mappedRows.length }, () => `(${cols.map(() => '?').join(', ')})`).join(', ');
            const updateSql = cols.filter(c => c !== 'site')
                .map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');
            const sql = `INSERT INTO ${task.targetTable} (${cols.map(c => `\`${c}\``).join(', ')}) VALUES ${phs}` +
                (updateSql ? ` ON DUPLICATE KEY UPDATE ${updateSql}` : '');
            const flat: any[] = [];
            for (const row of mappedRows) {
                for (const c of cols) {
                    const v = (row as any)[c];
                    if (v instanceof Date) flat.push(v);
                    else if (v === undefined) flat.push(null);
                    else flat.push(v);
                }
            }
            await conn.query(sql, flat);

            totalRows += rows.length;
            console.log(`    [${apiKey}] page ${page} got ${rows.length} rows (total ${totalRows})`);

            // 5) 最后一页
            if (rowLimit != null && totalRows >= rowLimit) break;
            if (rows.length < remaining) break;
            page++;
            const maxPages = Math.max(1, Number(process.env.PULL_MAX_PAGES || 10000));
            if (page > maxPages) {
                throw new Error(`exceeded PULL_MAX_PAGES=${maxPages}; endpoint pagination may not advance`);
            }
        }

        const expectedRows = expectedTotal == null
            ? null
            : (rowLimit == null ? expectedTotal : Math.min(expectedTotal, rowLimit));
        if (expectedRows != null && totalRows !== expectedRows) {
            throw new Error(`row count mismatch: expected ${expectedRows}, fetched ${totalRows}`);
        }

        // 3) 新批次完整落库后，再原子地清理该接口范围内的旧批次。
        if (task.scope) {
            await conn.execute(
                `DELETE FROM ${task.targetTable} WHERE site = ? AND \`${task.scope.column}\` = ? AND pulled_at < ?`,
                [site, task.scope.value, startedAt],
            );
        } else {
            await conn.execute(
                `DELETE FROM ${task.targetTable} WHERE site = ? AND pulled_at < ?`,
                [site, startedAt],
            );
        }
    } catch (e) {
        errMsg = (e as Error).message;
        console.error(`    [${apiKey}] FAILED: ${errMsg}`);
        // 本轮失败只撤销本轮已写数据，不破坏上一轮可用快照。
        try {
            if (task.scope) {
                await conn.execute(
                    `DELETE FROM ${task.targetTable} WHERE site = ? AND \`${task.scope.column}\` = ? AND pulled_at = ?`,
                    [site, task.scope.value, startedAt],
                );
            } else {
                await conn.execute(
                    `DELETE FROM ${task.targetTable} WHERE site = ? AND pulled_at = ?`,
                    [site, startedAt],
                );
            }
        } catch { /* 保留原始错误 */ }
    } finally {
        // 6) 更新 pull_log
        const finishedAt = new Date();
        const durationMs = Date.now() - startTs;
        if (logId != null) {
            try {
                await conn.execute(
                    `UPDATE pull_log
                     SET finished_at = ?, duration_ms = ?, page_count = ?, total_rows = ?, status = ?, error = ?
                     WHERE id = ?`,
                    [finishedAt, durationMs, pageCount, totalRows, errMsg ? 'failed' : 'ok', errMsg || null, logId],
                );
            } catch { /* swallow */ }
        }
        conn.release();
    }
    return { rows: totalRows, pages: pageCount, durationMs: Date.now() - startTs, error: errMsg };
}

// -----------------------------------------------------------------------------
// 拉一个基地所有接口
// -----------------------------------------------------------------------------
async function pullSite(site: string): Promise<void> {
    const lockConn = await mysqlPool().getConnection();
    const lockName = `aps:pull:modules:${site}`;
    const [lockRows] = await lockConn.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number((lockRows as any[])[0]?.acquired) !== 1) {
        lockConn.release();
        throw new Error(`基地 ${site} 已有模块同步任务运行，拒绝并发执行`);
    }
    try {
    console.log(`\n========== 基地 ${site} 开始拉取 ==========`);
    const t0 = Date.now();
    const summary: { apiKey: string; rows: number; pages: number; ms: number; err?: string }[] = [];

    for (const job of PULL_ORDER) {
        const r = await pullOne(site, job.apiKey, job.taskName);
        const displayKey = job.taskName ? `${job.apiKey}:${job.taskName}` : job.apiKey;
        summary.push({ apiKey: displayKey, rows: r.rows, pages: r.pages, ms: r.durationMs, err: r.error });
    }

    console.log(`\n========== 基地 ${site} 拉取完毕（${(Date.now() - t0) / 1000}s）==========`);
    console.log('API Key                          Rows   Pages  Duration');
    console.log('-----------------------------------------------------------------');
    for (const s of summary) {
        const ok = s.err ? `FAIL(${s.err.slice(0, 20)})` : 'OK';
        console.log(
            `${s.apiKey.padEnd(32)} ${String(s.rows).padStart(7)} ${String(s.pages).padStart(6)}  ${String(s.ms).padStart(6)}ms  ${ok}`,
        );
    }
    const failed = summary.filter(item => item.err);
    if (failed.length > 0) {
        throw new Error(`${failed.length} interface(s) failed: ${failed.map(item => item.apiKey).join(', ')}`);
    }
    } finally {
        try { await lockConn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* ignore */ }
        lockConn.release();
    }
}

// -----------------------------------------------------------------------------
// CLI 入口
// -----------------------------------------------------------------------------
export { pullSite, pullOne };

async function ensureModuleSchema(): Promise<void> {
    const conn = await mysqlPool().getConnection();
    try {
        await conn.execute(`CREATE TABLE IF NOT EXISTS raw_special_supply (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            site VARCHAR(8) NOT NULL,
            pulled_at DATETIME(3) NOT NULL,
            part_no VARCHAR(64),
            qty DECIMAL(20,6),
            KEY idx_site_pulled (site, pulled_at),
            KEY idx_part_no (part_no)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const additions: Array<[string, string, string]> = [
            ['raw_need', 'sfba006', 'VARCHAR(64)'],
            ['raw_need', 'qpa_num', 'DECIMAL(20,6)'],
            ['raw_need', 'qpa_den', 'DECIMAL(20,6)'],
            ['raw_need', 'sfba014', 'VARCHAR(16)'],
            ['raw_need', 'package_pending', 'VARCHAR(32)'],
            ['raw_cj', 'part_no', 'VARCHAR(64)'],
            ['raw_cj', 'qty', 'DECIMAL(20,6)'],
            ['raw_production_supply', 'qty', 'DECIMAL(20,6)'],
            ['raw_safetystock', 'uom', 'VARCHAR(16)'],
            ['raw_gd_bom', 'sub_part', 'VARCHAR(64)'],
            ['raw_gd_bom', 'qpa', 'DECIMAL(20,10)'],
            ['raw_gd_bom', 'issue_uom', 'VARCHAR(16)'],
            ['raw_gd_bom', 'seq', 'VARCHAR(32)'],
        ];
        for (const [table, column, type] of additions) {
            const [rows] = await conn.execute(
                `SELECT 1 FROM information_schema.columns
                 WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
                [config.mysql.database, table, column],
            );
            if ((rows as any[]).length === 0) {
                await conn.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
            }
        }
    } finally {
        conn.release();
    }
}

async function main(): Promise<void> {
    await ensureModuleSchema();
    const args = process.argv.slice(2);
    const arg = (args[0] || 'all').trim();
    let sites: string[];
    if (arg === 'all') sites = config.sites;
    else sites = arg.split(',').map(s => s.trim()).filter(Boolean);

    console.log(`[pull] 准备拉取 ${sites.length} 个基地：${sites.join(', ')}`);

    let failedSites = 0;
    for (const site of sites) {
        try {
            await pullSite(site);
        } catch (e) {
            failedSites++;
            console.error(`[pull] 基地 ${site} 失败:`, (e as Error).message);
        }
    }

    // 统计
    const [log] = await mysqlPool().query(
        `SELECT site, COUNT(*) as jobs, SUM(status='ok') as ok, SUM(status='failed') as failed,
                SUM(total_rows) as total_rows, SUM(duration_ms) as total_ms
         FROM pull_log
         WHERE started_at >= NOW() - INTERVAL 1 HOUR
         GROUP BY site`,
    );
    console.log('\n[pull] 1 小时内汇总:', JSON.stringify(log, null, 2));

    process.exit(failedSites > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
