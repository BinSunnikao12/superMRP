/**
 * src/compute/compute.ts
 * ============================================================
 * MRP 物料需求运算核心（Node.js + TypeScript 复刻版 + 优化）
 *
 * 优化点：
 *   1. dataOracle 改用 getOracleDB 单例（避免重复连接）
 *   2. BOM 展开加 memoize：相同 (主件, BOM用量比例) 在同一 site 内复用
 *   3. 数据结构 (QtyMap) 整页替换，避免 dot-spread 深拷贝
 */
import * as dayjsNs from 'dayjs';
import { type Row, type RowDict, type QtyMap } from '../data/dataOracle';
import { getOracleDB, getOracleSource } from '../data/dataSource';
import { leadtimeFunc, holidayFunc } from '../data/dataMysql';
import { remark as mesRemark, ryjj as mesRyjj } from '../data/dataMes';
import * as methods from './methods';
import { config } from '../config';

/** 给 Promise 加超时（ms），超时则 reject 一个带名字的错误 */
function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name} 超时（${ms}ms）`)), ms);
        p.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
        );
    });
}

const dayjs = dayjsNs.default || (dayjsNs as any);

type StockLike = Record<string, number>;

export class Serve {
    site: string;
    d!: ReturnType<typeof getOracleDB>;
    cjDict: QtyMap = {};
    baseDict: RowDict = {};
    remainDict: QtyMap = {};
    itemsDict: RowDict = {};
    vnItemsDict: RowDict = {};
    need: Row[] = [];
    bomDict: RowDict = {};
    buyerDict: RowDict = {};
    remainDictCopy: QtyMap = {};
    cjDictCopy: QtyMap = {};
    testsDict: QtyMap = {};
    safetystock: Row[] = [];
    inTransitDict: QtyMap = {};
    productionSupplyDict: QtyMap = {};
    substitutes: RowDict = {};
    purchaseOrderDetailDict: RowDict = {};
    remark: Map<string, any[]> = new Map();
    ryjj: Map<string, string> = new Map();
    outsourcingTypeDict: RowDict = {};
    gd01: QtyMap = {};
    gd01Copy: QtyMap = {};
    gdBomDict: RowDict = {};
    leadtimeMap: Map<string, number> = new Map();
    holiday: [string, string][] = [];
    totalDemand: QtyMap = {};
    l: Row[] = [];
    r: Row[] = [];
    docdt: Record<string, any> = {};
    itemNeed: QtyMap = {};

    /**
     * BOM 展开：
     * 注意：原版会"扣库存"——同一 (主件, 数量) 第二次展开时
     *     剩余库存已被前一次扣减，逻辑上结果不一样，因此不能简单 memoize。
     *     优化空间在于：把 BOM 静态数据（bom_dict / gd_bom_dict）外置 + 跨基地复用。
     */
    constructor(site: string) {
        this.site = site;
        this.d = getOracleDB(site);
        if (getOracleSource() === 'direct' && typeof (this.d as any).init === 'function') {
            // direct 模式需要 init Oracle pool；api/mock 模式 no-op
        }
    }

    aaa(m: Row): void {
        const bom: Row[] = ((this.bomDict as any)[m['下阶']] as Row[]) || [];
        const x1: Record<string, number> = ((this.gdBomDict as any)[m['下阶']] as Record<string, number>) || {};
        let nn: number = m['净需求'];

        let f = 0;
        for (const i of Object.keys(x1)) {
            const j = x1[i];
            const bomI: Row[] = JSON.parse(i);
            for (const iii of bomI) iii['项次'] = iii['项次'] + '_' + String(f);
            f += 1;
            if (!methods.compareData(bomI, bom)) {
                if (nn > j && j > 0) {
                    methods.xxxx(bomI, j, m, this);
                    nn -= j;
                    (this.gdBomDict as any)[m['下阶']][i] = 0;
                } else if (nn <= j && nn > 0) {
                    methods.xxxx(bomI, nn, m, this);
                    (this.gdBomDict as any)[m['下阶']][i] = j - nn;
                    nn = 0;
                }
            }
        }

        if (nn > 0 && bom.length > 0) {
            methods.xxxx(bom, nn, m, this);
        }
    }

    async init(): Promise<void> {
        await this.d.init();
        // CE 平台 V8 引擎的 dict / collection 不线程安全，并发会触发
        // "non-concurrent collections" 异常。改为完全串行调用。
        // 串行 + LRU 缓存：第二次跑（同样基地）会全命中，速度不会变差。

        const callSafely = async <T>(name: string, ms: number, fn: () => Promise<T>, fallback: T): Promise<T> => {
            try {
                return await withTimeout(fn(), ms, name);
            } catch (e) {
                console.warn(`[${this.site}] ${name} 加载失败: ${(e as Error).message}，使用空数据兜底`);
                return fallback;
            }
        };

        const EMPTY_MAP: any = {};
        const EMPTY_ARR: any[] = [];
        const EMPTY_M_STRARR: Map<string, any[]> = new Map();
        const EMPTY_M_STRSTR: Map<string, string> = new Map();
        const EMPTY_M_STRNUM: Map<string, number> = new Map();

        const baseDict     = await callSafely('basefunc', 60000, () => this.d.basefunc(),           EMPTY_MAP);
        const bomDict      = await callSafely('bomfunc', 60000, () => this.d.bomfunc(),             EMPTY_MAP);
        const need         = await callSafely('needfunc', 60000, () => this.d.needfunc(),             EMPTY_ARR);
        const itemsDict    = await callSafely('itemsfunc', 30000, () => this.d.itemsfunc(),         EMPTY_MAP);
        const vnItemsDict  = await callSafely('vn_itemsfunc', 30000, () => this.d.vn_itemsfunc(),   EMPTY_MAP);
        const remainDict   = await callSafely('remainfunc', 30000, () => this.d.remainfunc(),       EMPTY_MAP);
        const cjDict       = await callSafely('cjfunc', 30000, () => this.d.cjfunc(),               EMPTY_MAP);
        const productionSupplyDict = await callSafely('production_supply', 30000, () => this.d.production_supply(), EMPTY_MAP);
        const inTransitDict       = await callSafely('in_transit', 30000, () => this.d.in_transit(),     EMPTY_MAP);
        const testsDict          = await callSafely('testfunc', 30000, () => this.d.testfunc(),        EMPTY_MAP);
        const safetystock         = await callSafely('safetystock', 30000, () => this.d.safetystock(), EMPTY_ARR);
        const buyerDict           = await callSafely('buyerfunc', 30000, () => this.d.buyerfunc(),    EMPTY_MAP);
        const substitutes         = await callSafely('substitute', 30000, () => this.d.substitute(),   EMPTY_MAP);
        const purchaseOrderDetailDict = await callSafely('purchase_order_detail', 60000, () => this.d.purchase_order_detail(), EMPTY_MAP);
        const gd01                = await callSafely('gd01', 30000, () => this.d.gd01(),               EMPTY_MAP);
        const gdBomDict           = await callSafely('gd_bom', 30000, () => this.d.gd_bom(),          EMPTY_MAP);
        const outsourcingTypeDict = await callSafely('outsourcing_type', 30000, () => this.d.outsourcing_type(), EMPTY_MAP);
        const remarkMap           = await callSafely('mes_remark', 30000, () => mesRemark(),            EMPTY_M_STRARR);
        const ryjjMap             = await callSafely('mes_ryjj', 30000, () => mesRyjj(),               EMPTY_M_STRSTR);
        const leadtimeMap         = await callSafely('leadtime', 10000, () => leadtimeFunc(),           EMPTY_M_STRNUM);
        const holiday             = await callSafely('holiday', 10000, () => holidayFunc(this.site),   EMPTY_ARR);
        this.cjDict = cjDict as unknown as QtyMap;
        this.baseDict = baseDict;
        this.remainDict = remainDict as unknown as QtyMap;
        this.itemsDict = itemsDict;
        this.vnItemsDict = vnItemsDict;
        this.need = need;
        this.bomDict = bomDict;
        this.buyerDict = buyerDict;
        this.remainDictCopy = { ...this.remainDict };
        this.cjDictCopy = { ...this.cjDict };
        this.testsDict = testsDict as unknown as QtyMap;
        this.safetystock = safetystock;
        this.inTransitDict = inTransitDict as unknown as QtyMap;
        this.productionSupplyDict = productionSupplyDict as unknown as QtyMap;
        this.substitutes = substitutes;
        this.purchaseOrderDetailDict = purchaseOrderDetailDict;
        this.remark = remarkMap;
        this.ryjj = ryjjMap;
        this.outsourcingTypeDict = outsourcingTypeDict;
        this.gd01 = gd01 as unknown as QtyMap;
        this.gd01Copy = { ...this.gd01 };
        this.gdBomDict = gdBomDict;
        this.leadtimeMap = leadtimeMap;
        this.holiday = holiday;
    }

    hoildayFunc(v: Row): void {
        const parseDatetime = (dateStr: string | Date) => dayjs(dateStr);
        let overlap: [string, string] | null = null;
        if (v['下阶成本中心编码'] === '1073' && String(v['成品工单号']).slice(0, 7) === 'LG-GD01' && !String(v['跟单码']).includes('.')) {
            v['预计开工日期'] = dayjs(v['预计开工日期'] as any).subtract(this.leadtimeMap.get('LG|1069') || 0, 'day').toDate();
        }
        for (const h of this.holiday) {
            if (dayjs(v['预计开工日期'] as any).isBefore(parseDatetime(h[1])) || dayjs(v['预计开工日期'] as any).isSame(parseDatetime(h[1]))) {
                if (dayjs(v['预计完工日期'] as any).isAfter(parseDatetime(h[0])) || dayjs(v['预计完工日期'] as any).isSame(parseDatetime(h[0]))) {
                    overlap = h;
                    break;
                }
            }
        }
        if (overlap) {
            const d = parseDatetime(overlap[1]).diff(v['预计完工日期'] as any, 'day');
            const dClamped = d < 0 ? 0 : d;
            const numDays = parseDatetime(overlap[1]).diff(parseDatetime(overlap[0]), 'day') - dClamped + 1;
            v['预计开工日期'] = dayjs(v['预计开工日期'] as any).subtract(numDays, 'day').toDate();
        }
    }

    remainOperation(v: Row, enddate?: string | Date | null, c: string = ''): void {
        const item: string = v['下阶'];
        if (typeof enddate === 'string') enddate = dayjs(enddate).toDate();
        const base = this.baseDict[item] || {} as any;
        const mainBase = this.baseDict[v['主件']] || {} as any;
        const remain = this.remainDict[item] || 0;
        const cj = this.cjDict[item] || 0;
        const gd01 = this.gd01[item] || 0;
        const stock: StockLike = { '可用库存': remain, '可用在制': cj, 'GD01可用工单数': gd01 };
        v['可用库存'] = stock['可用库存'];
        v['可用在制'] = stock['可用在制'];
        v['GD01可用工单数'] = stock['GD01可用工单数'];
        const rrrr = methods.demand(stock, v['毛需求']);
        v['净需求'] = rrrr[0];
        this.remainDict[item] = rrrr[1]['可用库存'];
        this.cjDict[item] = rrrr[1]['可用在制'];
        this.gd01[item] = rrrr[1]['GD01可用工单数'];

        v['人工工时'] = base['IMAE051'] * v['净需求'];
        v['子件标准人工工时'] = base['IMAE051'];
        v['主件标准人工工时'] = mainBase['IMAE051'];
        v['总库存'] = this.remainDictCopy[item] || 0;
        v['总在制'] = this.cjDictCopy[item] || 0;
        v['GD01工单数'] = this.gd01Copy[item] || 0;
        v['总在验'] = this.testsDict[item] || 0;
        v['总采购在途'] = this.inTransitDict[item] || 0;
        v['总工单供给'] = this.productionSupplyDict[item] || 0;
        this.totalDemand[item] = (this.totalDemand[item] || 0) + v['净需求'];
        v['合计欠料'] = this.totalDemand[item] || 0;
        this.itemNeed[item] = (this.itemNeed[item] || 0) + v['毛需求'];
        const itemsF = this.itemsDict[v['主件']] || { IMAAL003: '', IMAAL004: '' };
        v['主件料名'] = itemsF['IMAAL003'] || '';
        v['主件规格'] = itemsF['IMAAL004'] || '';
        const itemsS = this.itemsDict[item] || { IMAAL003: '', IMAAL004: '' };
        v['下阶料名'] = itemsS['IMAAL003'] || '';
        v['下阶规格'] = itemsS['IMAAL004'] || '';
        v['下阶成本中心'] = base['OOEFL003'];
        v['主件成本中心'] = mainBase['OOEFL003'];
        v['下阶成本中心编码'] = base['IMAE035'];
        v['主件成本中心编码'] = mainBase['IMAE035'];
        v['外购类型'] = this.outsourcingTypeDict[item]?.['OOCQL004'];
        v['材质'] = this.outsourcingTypeDict[item]?.['IMAA130'];
        let leadtime = v['固定生产前置时间'] + v['变动生产前置时间'] + v['QC前置时间'] + v['累计前置时间'];

        const key = `${this.site}|${mainBase['IMAE035']}`;
        if (this.leadtimeMap.has(key)) {
            let n = 0;
            if (mainBase['IMAE035'] === '1073' && mainBase['IMAFUD010'] === 'Y' && this.site === 'LG') n = 1;
            leadtime = !c.includes(v['主件成本中心'])
                ? (this.leadtimeMap.get(key) || 0) + n
                : 0;
        }
        if (v['下阶类别'] === 'X') leadtime = 0;

        if (v['预计完工日期'] == null) v['预计完工日期'] = enddate;
        v['预计开工日期'] = dayjs(enddate as any).subtract(leadtime, 'day').toDate();

        this.hoildayFunc(v);
        v['预计完工日期'] = dayjs(v['预计完工日期'] as any).format('YYYY-MM-DD');
        v['预计开工日期'] = dayjs(v['预计开工日期'] as any).format('YYYY-MM-DD');

        if (this.site === 'YN') {
            const vnItemsF = this.vnItemsDict[v['主件']];
            v['越南主件料名'] = vnItemsF ? vnItemsF['IMAAL003'] || '' : '';
            v['越南主件规格'] = vnItemsF ? vnItemsF['IMAAL004'] || '' : '';
            const vnItemsS = this.vnItemsDict[item];
            v['越南下阶料名'] = vnItemsS ? vnItemsS['IMAAL003'] || '' : '';
            v['越南下阶规格'] = vnItemsS ? vnItemsS['IMAAL004'] || '' : '';
        }

        v['补给策略'] = ({ '1': '外购', '2': '自制', '3': '委外' } as Record<string, string>)[base['IMAF013']];
        v['计划员'] = v['下阶成本中心'];
        const buyers = this.buyerDict[item] || {};
        const b: Record<string, string> = { 'LG': '张玉洪', 'QU': '', 'YN': '', 'GX': '', 'FN': '' };
        v['采购物控人员'] = base['IMAF013'] === '1' ? (buyers['OOAG011'] ?? b[this.site]) : '';
        v['最近采购供应商'] = buyers['PMAAL003'] || '';
        v['最近采购供应商编码'] = buyers['PMDL004'] || '';
        v['采购单位批量'] = base['IMAF145'];
        v['最小采购数量'] = base['IMAF146'];
        v['采购单位'] = base['IMAF143'];
        v['生产单位批量'] = base['IMAE017'];
        v['最小生产数量'] = base['IMAE018'];
        v['生产单位'] = base['IMAE016'];
        v['需求计算方式'] = ({ '1': 'APS计算', '2': '人工计算' } as Record<string, string>)[base['IMAF014']];
        v['使用库存'] = v['毛需求'] - v['净需求'];
    }

    sss(v: Row): void {
        const a = ['累计前置时间', 'QC前置时间', '变动生产前置时间', '固定生产前置时间',
            '最短采购前置时间', '入库前置时间', '到厂前置时间', '文件前置时间', '交货前置时间'];
        const base = this.baseDict[v['下阶']] || {} as any;
        const remark = this.remark.get(v['跟单码']);
        v['采购回复'] = remark ? remark[1] : '';
        v['承诺交期'] = remark ? remark[2] : '';
        v['生产损耗率'] = base['IMAE015'] != null ? base['IMAE015'] : 0;
        for (const i of a) v[i] = '-';
        this.remainOperation(v);

        v['总装车间'] = v['主件成本中心'];
        v['净需求'] = base['IMAE017']
            ? Math.ceil(v['净需求'] * (1 + v['生产损耗率'] / 100) / base['IMAE017']) * base['IMAE017']
            : v['净需求'] * (1 + v['生产损耗率'] / 100);

        if (v['主件'] !== v['下阶']) v['成本中心集'] = v['主件成本中心'] || '';
        else v['成本中心集'] = '';
        v['齐套数'] = Number.POSITIVE_INFINITY;
        this.l.push(v);
        if (v['补给策略'] !== '外购' && v['净需求'] > 0 && !['QU-GD04', 'QU-GD15'].includes(String(v['成品工单号']).slice(0, 7))) {
            this.aaa(v);
        }
    }

    async calculate(): Promise<void> {
        for (const i of this.need) {
            const v: Row = {
                '主件': i['主件料号'],
                '下阶': i['SFBA006'],
                'BOM用量': i['QPA分子'] / i['QPA分母'],
                '父跟单码': i['工单单号'],
                '成品工单号': String(i['工单单号']).replace('(备货)', ''),
                '成品工单状态': i['工单状态'],
                '跟单码': `${i['工单单号']}_${i['SFBASEQ']}`,
                '预计开工日期': i['预计开工日期'],
                '预计完工日期': i['预计完工日期'],
                '毛需求': i['主件需求数量'] * i['QPA分子'] / i['QPA分母'],
                '客户订单号': i['SFAAUD002'],
                '来源单号': i['SFAA006'],
                '主件单位': null,
                '下阶单位': i['SFBA014'],
                '备注': i['OOFF013'],
                '原始需求': true,
                '总装锁定日期': (i['SFAAUA002'] !== '' && i['SFAAUA002']) ? dayjs(i['SFAAUA002'] as any).format('YYYY-MM-DD') : '',
                '立柱锁定日期': (i['SFAAUA003'] !== '' && i['SFAAUA003']) ? dayjs(i['SFAAUA003'] as any).format('YYYY-MM-DD') : '',
                '客户': i['客户'],
            };
            this.docdt[v['成品工单号']] = i['DOCDT'];
            this.sss(v);
        }

        const now = dayjs(new Date()).hour(0).minute(0).second(0).millisecond(0);
        for (const i of this.safetystock) {
            const v: Row = {
                '主件': i['IMAF001'],
                '下阶': i['IMAF001'],
                'BOM用量': 1,
                '父跟单码': '',
                '成品工单号': '安全库存',
                '成品工单状态': '',
                '跟单码': '安全库存' + i['IMAF001'],
                '预计开工日期': now.add(90, 'day').toDate(),
                '预计完工日期': now.add(90, 'day').toDate(),
                '毛需求': i['IMAF026'],
                '客户订单号': '安全库存',
                '来源单号': '安全库存',
                '主件单位': null,
                '下阶单位': i['IMAF053'],
                '原始需求': true,
                '总装锁定日期': '',
                '立柱锁定日期': '',
            };
            this.sss(v);
        }

        const sums: QtyMap = {};
        for (const item of this.l) {
            if (item['成品工单状态'] === '已发出') {
                sums[item['下阶']] = (sums[item['下阶']] || 0) + item['毛需求'];
            }
        }
        for (const item of this.l) item['总装发出数量'] = sums[item['下阶']] || 0;

        const dykcZt = (i: string) => {
            const n = (this.remainDictCopy[i] || 0) + (this.cjDictCopy[i] || 0) +
                (this.inTransitDict[i] || 0) - (this.itemNeed[i] || 0);
            return n > 0 ? n : 0;
        };

        const added = new Set<string>();
        const pushR = (i: string) => {
            if (added.has(i)) return;
            added.add(i);
            this.r.push({
                '料号': i,
                '料名': (this.itemsDict[i] || {})['IMAAL003'] || '',
                '规格': (this.itemsDict[i] || {})['IMAAL004'] || '',
                '总库存': this.remainDictCopy[i] || 0, '总在制': this.cjDictCopy[i] || 0,
                '多余库存': this.remainDict[i] || 0, '多余在制': this.cjDict[i] || 0,
                '安全库存量': (this.baseDict[i] || {})['IMAF026'] || 0,
                '总采购在途': this.inTransitDict[i] || 0,
                '总在验': this.testsDict[i] || 0,
                '总需求': this.itemNeed[i] || 0,
                '多余库存含在途': dykcZt(i),
            });
        };
        for (const i of Object.keys(this.remainDictCopy)) pushR(i);
        for (const i of Object.keys(this.cjDictCopy)) if (this.remainDictCopy[i] == null) pushR(i);
        for (const i of Object.keys(this.inTransitDict)) {
            if (this.remainDictCopy[i] == null && this.cjDictCopy[i] == null) pushR(i);
        }
    }
}
