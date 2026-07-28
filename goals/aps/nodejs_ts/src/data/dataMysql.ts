/**
 * src/data/dataMysql.ts
 * ============================================================
 * MySQL 配置 + 结果回写（Node.js + TypeScript 复刻版 + 优化）
 *
 * 关键约定：
 *   - 数据库列名是 ASCII（拼音/英文），APS 端数据用中文 key
 *   - 两个数组 COLS_MRP / COLS_ZJ / COLS_CG 既定义 INSERT 的列名顺序，
 *     也是"中文 key → ASCII 列名"的双向映射（同一索引位置对应）
 *
 * 优化点：
 *   1. mysql2 改连接池（dbPools.mysqlPool）
 *   2. leadtime / holiday 查询走 LRU 缓存（10 分钟 TTL）
 *   3. mysqlLoad 改用 prepared statement + 单次 multi-values 批量
 *   4. 连接失败时优雅降级（SKIP_MYSQL=true 或连不上）
 */
import { mysqlPool } from './dbPools';
import { cachePool } from '../cache/ttlLru';
import type { Row } from './dataOracle';

/**
 * 中文 key → ASCII 列名（顺序 1:1）
 * 列名顺序对应 initdb/01-schema.sql 里的列定义
 */
const COLS_MRP: { key: string; col: string }[] = [
    { key: '预计开工日期',       col: 'plan_start_date' },
    { key: '预计完工日期',       col: 'plan_end_date' },
    { key: '客户订单号',         col: 'customer_order_no' },
    { key: '成品工单号',          col: 'finished_work_order' },
    { key: '成品工单状态',        col: 'finished_wo_status' },
    { key: '父跟单码',           col: 'parent_track_no' },
    { key: '跟单码',             col: 'track_no' },
    { key: '主件',               col: 'main_part' },
    { key: '主件料名',            col: 'main_part_name' },
    { key: '主件规格',            col: 'main_part_spec' },
    { key: '主件成本中心',         col: 'main_cost_center' },
    { key: '下阶',               col: 'sub_part' },
    { key: '下阶料名',            col: 'sub_part_name' },
    { key: '下阶规格',            col: 'sub_part_spec' },
    { key: '下阶成本中心',         col: 'sub_cost_center' },
    { key: 'BOM用量',            col: 'bom_qty' },
    { key: '毛需求',             col: 'gross_demand' },
    { key: '总库存',             col: 'total_stock' },
    { key: '总在制',             col: 'total_wip' },
    { key: '总采购在途',           col: 'total_in_transit' },
    { key: '总工单供给',           col: 'total_wo_supply' },
    { key: '总在验',             col: 'total_inspecting' },
    { key: '可用库存',            col: 'avail_stock' },
    { key: '可用在制',            col: 'avail_wip' },
    { key: '净需求',             col: 'net_demand' },
    { key: '合计欠料',            col: 'total_shortage' },
    { key: '补给策略',            col: 'supply_strategy' },
    { key: '计划员',             col: 'planner' },
    { key: '采购物控人员',          col: 'buyer' },
    { key: '最近采购供应商',         col: 'recent_supplier' },
    { key: '最近采购供应商编码',       col: 'recent_supplier_code' },
    { key: '采购单位批量',          col: 'po_batch_qty' },
    { key: '最小采购数量',          col: 'po_min_qty' },
    { key: '采购单位',            col: 'po_uom' },
    { key: '生产单位批量',          col: 'mo_batch_qty' },
    { key: '最小生产数量',          col: 'mo_min_qty' },
    { key: '生产单位',            col: 'mo_uom' },
    { key: '生产损耗率',           col: 'prod_loss_rate' },
    { key: '固定生产前置时间',        col: 'fixed_lead_time' },
    { key: '变动生产前置时间',        col: 'variable_lead_time' },
    { key: 'QC前置时间',          col: 'qc_lead_time' },
    { key: '累计前置时间',          col: 'accum_lead_time' },
    { key: '来源单号',            col: 'source_order' },
    { key: '需求计算方式',          col: 'demand_calc_method' },
    { key: '齐套数',             col: 'kit_qty' },
    { key: '越南主件料名',          col: 'vn_main_name' },
    { key: '越南主件规格',          col: 'vn_main_spec' },
    { key: '越南下阶料名',          col: 'vn_sub_name' },
    { key: '越南下阶规格',          col: 'vn_sub_spec' },
    { key: 'version',            col: 'version' },
    { key: 'site',               col: 'site' },
    { key: '使用库存',            col: 'used_stock' },
    { key: '文件前置时间',          col: 'doc_lead_time' },
    { key: '人工工时',            col: 'man_hours' },
    { key: '最短采购前置时间',        col: 'min_po_lead_time' },
    { key: '到厂前置时间',          col: 'arrival_lead_time' },
    { key: '成本中心集',           col: 'cost_center_set' },
    { key: '交货前置时间',          col: 'delivery_lead_time' },
    { key: '入库前置时间',          col: 'storage_lead_time' },
    { key: '主件单位',            col: 'main_uom' },
    { key: '下阶单位',            col: 'sub_uom' },
    { key: '下阶成本中心编码',        col: 'sub_cc_code' },
    { key: '承诺交期',            col: 'promise_delivery' },
    { key: '采购回复',            col: 'purchase_reply' },
];

const COLS_ZJ: { key: string; col: string }[] = [
    { key: 'site',          col: 'site' },
    { key: 'version',       col: 'version' },
    { key: '齐套数总和',      col: 'kit_total' },
    { key: '预计完工日期',     col: 'plan_end_date' },
    { key: '总工单供给',      col: 'total_wo_supply' },
    { key: '工单供给',       col: 'wo_supply' },
    { key: '净需求总和',      col: 'net_demand_total' },
    { key: '人工工时',       col: 'man_hours' },
    { key: '下阶规格',       col: 'sub_part_spec' },
    { key: '下阶料名',       col: 'sub_part_name' },
    { key: '下阶成本中心',     col: 'sub_cost_center' },
    { key: '下阶',          col: 'sub_part' },
    { key: '跟单码',         col: 'track_no' },
    { key: '下阶成本中心编码',   col: 'sub_cc_code' },
    { key: '喷涂料名',       col: 'spray_part_name' },
    { key: '主件成本中心',     col: 'main_cost_center' },
];

const COLS_CG: { key: string; col: string }[] = [
    { key: 'site',          col: 'site' },
    { key: 'version',       col: 'version' },
    { key: '要求到货日期',     col: 'require_arrive_date' },
    { key: '下阶',          col: 'sub_part' },
    { key: '下阶料名',       col: 'sub_part_name' },
    { key: '下阶规格',       col: 'sub_part_spec' },
    { key: '需求',          col: 'demand' },
    { key: '总采购在途',      col: 'total_in_transit' },
    { key: '总库存',         col: 'total_stock' },
    { key: '总在制',         col: 'total_wip' },
    { key: '总在验',         col: 'total_inspecting' },
    { key: '未处理请购数',     col: 'pending_pr_qty' },
    { key: '采购物控人员',     col: 'buyer' },
    { key: '跟单码',         col: 'track_no' },
    { key: '采购单',         col: 'po_no' },
    { key: '单据日期',       col: 'po_doc_date' },
    { key: '采购单要求交期',    col: 'po_require_date' },
    { key: '请购创建日期',     col: 'pr_create_date' },
    { key: '供应商',        col: 'supplier' },
    { key: '外购类型',       col: 'outsource_type' },
    { key: '客户订单号',      col: 'customer_order_no' },
    { key: '公司型号',       col: 'company_model' },
    { key: '客户型号',       col: 'customer_model' },
];

/** (site, cost_center) → 提前期（天） */
export async function leadtimeFunc(): Promise<Map<string, number>> {
    if (process.env.SKIP_MYSQL === 'true') return new Map();
    const pool = cachePool.get('__global__', 'mysql');
    return pool.wrap('leadtime', async () => {
        try {
            const conn = await mysqlPool().getConnection();
            try {
                const [rows] = await conn.execute('SELECT site, cost_center, days FROM leadtime_conf');
                const map = new Map<string, number>();
                for (const i of rows as any[]) map.set(`${i.site}|${i.cost_center}`, i.days);
                return map;
            } finally {
                conn.release();
            }
        } catch (e) {
            console.warn(`[mysql] leadtime 读取失败 (${(e as Error).message})，返回空 Map`);
            return new Map<string, number>();
        }
    });
}

/** 基地节假日清单：[(startday, endday), ...] */
export async function holidayFunc(site: string): Promise<[string, string][]> {
    if (process.env.SKIP_MYSQL === 'true') return [];
    const pool = cachePool.get(site, 'mysql');
    return pool.wrap('holiday', async () => {
        try {
            const conn = await mysqlPool().getConnection();
            try {
                const [rows] = await conn.execute(
                    `SELECT DATE_FORMAT(startday, '%Y-%m-%d') AS startday, DATE_FORMAT(endday, '%Y-%m-%d') AS endday
                     FROM holiday WHERE site = ?`,
                    [site],
                );
                return (rows as any[]).map(i => [i.startday, i.endday] as [string, string]);
            } finally {
                conn.release();
            }
        } catch (e) {
            console.warn(`[mysql] holiday 读取失败 (${(e as Error).message})，返回空`);
            return [] as [string, string][];
        }
    });
}

/**
 * 把 APS 中文 dict 列表按 COLS_* 顺序转成 [v1, v2, ...]，特殊值归一化
 * 返回扁平数组，方便用 sql.query 一行参数 = 一行数据的 multi-values 形式
 */
function rowsForTable(data: Row[], cols: { key: string; col: string }[], site: string, version: string): any[] {
    const out: any[] = [];
    for (const i of data) {
        i['site'] = site;
        i['version'] = version;
        if (i['齐套数'] === Number.POSITIVE_INFINITY) i['齐套数'] = 0;
        if (typeof i['齐套数总和'] === 'number' && !Number.isFinite(i['齐套数总和'])) i['齐套数总和'] = 0;
        for (const c of cols) {
            const v = i[c.key];
            out.push(v === undefined || v === null ? '' : v);
        }
    }
    return out;
}

/** 一次性插入（multi-values）— 用 query() 而不是 execute()，避开 prepared statement 限制 */
async function bulkInsert(conn: any, table: string, cols: { col: string }[], data: Row[], site: string, version: string): Promise<number> {
    if (data.length === 0) return 0;
    const rows = rowsForTable(data, cols as any, site, version);
    const colNames = cols.map(c => `\`${c.col}\``).join(', ');
    const rowPH = `(${cols.map(() => '?').join(', ')})`;
    const ph = Array.from({ length: data.length }, () => rowPH).join(', ');
    const sql = `INSERT INTO \`${table}\` (${colNames}) VALUES ${ph}`;
    await conn.query(sql, rows);
    return data.length;
}

/**
 * 结果回写到 MySQL（mrp 库）
 */
export async function mysqlLoad(
    data: Row[],
    site: string,
    version: string,
    cgData: Row[] | null = null,
    zjData: Row[] | null = null,
): Promise<void> {
    if (process.env.SKIP_MYSQL === 'true') {
        console.log(`[mysql] SKIP_MYSQL=true，跳过写入 (site=${site})`);
        return;
    }
    let conn;
    try {
        conn = await mysqlPool().getConnection();
    } catch (e) {
        console.warn(`[mysql] 连接失败 (${(e as Error).message})，跳过写入`);
        return;
    }
    try {
        // 1) mrp 表（一次插全，不分批；1000 行 INSERT 仍很快）
        if (data.length > 0) {
            const n = await bulkInsert(conn, 'mrp', COLS_MRP, data, site, version);
            console.log(`[mysql] mrp 表写入 ${n} 行`);
        }

        // 2) zj_data 表
        if (zjData != null && zjData.length > 0) {
            const n = await bulkInsert(conn, 'zj_data', COLS_ZJ, zjData, site, version);
            console.log(`[mysql] zj_data 表写入 ${n} 行`);
        }

        // 3) cg_data 表
        if (cgData != null && cgData.length > 0) {
            const n = await bulkInsert(conn, 'cg_data', COLS_CG, cgData, site, version);
            console.log(`[mysql] cg_data 表写入 ${n} 行`);
        }

        // 4) 写 mrp_version
        await conn.query(
            'INSERT INTO mrp_version (site, version) VALUES (?, ?) ON DUPLICATE KEY UPDATE version = VALUES(version)',
            [site, version],
        );

        // 5) 清理老版本
        await conn.query(
            `DELETE FROM mrp WHERE site = ? AND version != ?
             AND version NOT IN (SELECT version FROM (
                SELECT DISTINCT version FROM mrp WHERE site = ?
                ORDER BY version DESC LIMIT 3) AS a)`,
            [site, version, site],
        );
        await conn.query('DELETE FROM cg_data WHERE site = ? AND version != ?', [site, version]);
        await conn.query('DELETE FROM zj_data WHERE site = ? AND version != ?', [site, version]);
    } finally {
        conn.release();
    }
}
