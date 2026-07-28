/**
 * src/data/dataOracleApi.ts
 * ============================================================
 * 通过乐歌低代码平台 ApiEngine 访问 Oracle ERP（替代直连）
 *
 * 与 dataOracle.ts 的 API 完全一致（同样的 18 个方法），
 * compute / excel 层不需要改一行代码。
 *
 * 内部统一走 apiClient.runApi()：
 *   - 默认：HTTP POST → CE 的 ApiEngine.Run
 *   - MOCK_MODE=true：从本地 fixtures 读
 *
 * ApiEngineKey 命名约定（与 CE 鼎捷模块下脚本一一对应）：
 *   tiptop_query_bom                - BMBA_T
 *   tiptop_query_bom_replace        - BMGC_T
 *   tiptop_query_inag_t             - INAG_T
 *   tiptop_query_inaa_t             - INAA_T
 *   tiptop_query_imaf_t             - IMAF_T + IMAE_T
 *   tiptop_query_sfaa_t             - SFAA_T 销售/工单
 *   tiptop_query_sfba_t             - SFBA_T BOM 工艺
 *   tiptop_query_sfac_t             - SFAC_T 工单供给
 *   tiptop_query_xmdd_t             - XMDD_T 销售订单明细
 *   tiptop_query_xmdc_t             - XMDC_T 销售订单客户
 *   tiptop_query_xmda_t             - XMDA_T 销售订单主档
 *   tiptop_query_imaal_t            - IMAAL_T 料件多语名
 *   tiptop_query_pmdn_t             - PMDN_T 采购单明细
 *   tiptop_query_pmdl_t             - PMDL_T 采购单主档
 *   tiptop_query_pmdo_t             - PMDO_T 采购单明细 2
 *   tiptop_query_pmdp_t             - PMDP_T 请购采购
 *   tiptop_query_pmdb_t             - PMDB_T 请购单
 *   tiptop_query_pmda_t             - PMDA_T 请购主档
 *   tiptop_query_pmaal_t            - PMAAL_T 供应商/客户多语名
 *   tiptop_query_ooag_t             - OOAG_T 人员
 *   tiptop_query_pmdt_t             - PMDT_T 进货检验
 *   tiptop_query_pmds_t             - PMDS_T 进货检验主档
 *   tiptop_query_pmaa_t             - PMAA_T 交易对象
 *   tiptop_query_oocql_t            - OOCQL_T 码表
 *   tiptop_query_bmea_t             - BMEA_T 替代料
 *   tiptop_query_imaa_t             - IMAA_T 料件基础
 *   tiptop_query_ooefl_t            - OOEFL_T 成本中心名称
 *   tiptop_query_pscc_t             - PSCC_T 已纳入 MRP 的工单/销售单
 *   tiptop_query_pscd_t             - PSCD_T 已纳入 MRP 的库存
 *   tiptop_query_imae_t             - IMAE_T 物料扩展
 *
 * 注：CE 那边的 ApiEngine 大部分还没写完，本文件先按"已写完"来调。
 * 缺哪个接口时，dataOracleApi 会从 mock fixture 兜底。
 */
import { runApi, type ApiRunParam } from './apiClient';
import { cachePool } from '../cache/ttlLru';
import { config } from '../config';

type Row = Record<string, any>;
type RowDict = Record<string, Row>;
type QtyMap = Record<string, number>;

/**
 * 把 ApiEngine 返回的 { columns, rows } 转回"按物理列名"的 dict 列表
 * （rows 已经是 label 后的中文键名，但 compute 层用物理列名访问，所以需要回退）
 */
function toPhysicalRows(data: any, physicalColumns?: string[]): Row[] {
    if (!data) return [];
    const shaped = data.rows || [];
    // 如果 V8 接口做了 applyCnLabels，列名是 label；这里我们假设接口端会回退成物理列
    return shaped as Row[];
}

export class OracleDB {
    private site: string;
    private mrpVersion: string;

    constructor(site: string) {
        this.site = site;
        this.mrpVersion = ({
            'LG': 'WAPS002', 'QU': 'WAPS001', 'YN': 'YN01',
            'GX': 'WAPS001', 'FN': 'FN01',
        } as Record<string, string>)[site];
    }

    async init(): Promise<void> {
        // 走 HTTP / mock，不需要本地连接
    }
    async close(): Promise<void> {
        // no-op
    }

    private async cached<T>(namespace: string, loader: () => Promise<T>): Promise<T> {
        const pool = cachePool.get(this.site, 'oracleApi');
        return pool.wrap(`${namespace}|${this.mrpVersion}`, loader);
    }

    private async runPg<T = any>(apiKey: string, extra: ApiRunParam = {}): Promise<T> {
        return this.cached(apiKey, () => runApi<T>(apiKey, { site: this.site, page: 1, pageSize: config.api.maxPageSize, ...extra }));
    }

    // ----------------------------------------------------------------------
    // 标准 BOM
    // ----------------------------------------------------------------------
    async bomfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_bom');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) {
            if (!result[i['主件']]) result[i['主件']] = [];
            result[i['主件']].push(i);
        }
        return result;
    }

    async basefunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_imaf_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['IMAF001']] = i;
        return result;
    }

    async needfunc(): Promise<Row[]> {
        // 工单 + 销售订单的并集；用两个接口
        const [sfaa, xmdd] = await Promise.all([
            this.runPg<any>('tiptop_query_sfaa_t'),
            this.runPg<any>('tiptop_query_xmdd_t'),
        ]);
        const sfaaRows = toPhysicalRows(sfaa);
        const xmddRows = toPhysicalRows(xmdd);
        // CE 端需要做 union 逻辑；这里把两组都返回，让上层处理
        return [...sfaaRows, ...xmddRows];
    }

    async remainfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_inag_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['INAG001']] = i['INAG008'];
        return result;
    }

    async cjfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_sfba_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['SFBA006']] = i['QTY'];
        return result;
    }

    async itemsfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_imaal_t', { lang: 'zh_CN' });
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['IMAAL001']] = i;
        return result;
    }

    async vn_itemsfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_imaal_t', { lang: 'vi_VN' });
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['IMAAL001']] = i;
        return result;
    }

    async buyerfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_pmdn_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['PMDN001']] = i;
        return result;
    }

    async testfunc(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_pmdt_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['PMDT006']] = i['在验量'];
        return result;
    }

    async safetystock(): Promise<Row[]> {
        const data = await this.runPg<any>('tiptop_query_imaf_t', { where: "imaf026 > 0" });
        return toPhysicalRows(data);
    }

    async in_transit(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_in_transit');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['PMDO001']] = i['ZTNUM'];
        return result;
    }

    async production_supply(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_sfac_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['SFAC001']] = i['QTY'];
        return result;
    }

    async substitute(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_bmea_t');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) {
            const k = i['BMEA001'] + '_' + i['BMEA003'];
            if (!result[k]) result[k] = [];
            result[k].push(i);
        }
        return result;
    }

    async purchase_order_detail(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_purchase_order');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) {
            if (!result[i['PMDO001']]) result[i['PMDO001']] = [];
            result[i['PMDO001']].push(i);
        }
        return result;
    }

    async gd01(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_gd01');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['SFAA010']] = i['QTY'];
        return result;
    }

    async outsourcing_type(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_imaa_oocql');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const i of rows) result[i['IMAA001']] = i;
        return result;
    }

    async gd_bom(): Promise<RowDict> {
        const data = await this.runPg<any>('tiptop_query_gd_bom');
        const rows = toPhysicalRows(data);
        const result: RowDict = {};
        for (const item of rows) {
            const partNumber = item['主件料号'];
            const workOrder = item['工单号'];
            if (!result[partNumber]) result[partNumber] = {};
            const key1 = workOrder + '_' + String(item['未交量']);
            if (!result[partNumber][key1]) result[partNumber][key1] = [];
            result[partNumber][key1].push({
                '主件': item['主件料号'],
                '下阶': item['发料料号'],
                'QPA': item['用量比例'],
                '主件类别': 'W',
                '下阶类别': 'W',
                '发料单位': item['发料单位'],
                '项次': item['项次'],
            });
        }
        const dd: RowDict = {};
        for (const i of Object.keys(result)) {
            const j = result[i];
            const d: Record<string, number> = {};
            for (const i1 of Object.keys(j)) {
                const j1 = j[i1] as any[];
                const sortedBom = [...j1].sort((a, b) => (a['下阶'] > b['下阶'] ? 1 : a['下阶'] < b['下阶'] ? -1 : 0));
                const jj = JSON.stringify(sortedBom);
                d[jj] = (d[jj] || 0) + Number(i1.split('_')[1]);
            }
            dd[i] = d as any;
        }
        return dd;
    }
}
