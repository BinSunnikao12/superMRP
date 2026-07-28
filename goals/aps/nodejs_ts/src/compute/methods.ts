/**
 * compute/methods.ts
 * ============================================================
 * BOM 展开工具方法（Node.js + TypeScript 复刻版）
 *
 * - compareData: 比较两个 BOM 行的 (主件, 下阶, QPA) 三元组是否一致
 *                用于判断 GD 替代 BOM 是否与标准 BOM 实质等价
 * - demand:      从 stock 三层扣减需求（库存 → 在制 → GD01 工单），返回 (剩余需求, 扣后余额)
 * - xxxx:        展开单层 BOM：对 bom 里的每个下阶行 jj 构造一条记录，递归调 aaa
 *
 * 注：与 Python 版相比，仅"for i, j in enumerate(bom)" -> "for (i, j) of bom.entries()"
 *     以及 inf -> Number.POSITIVE_INFINITY、math.ceil -> Math.ceil 等价替换
 */

import { Serve } from './compute';

type BomRow = Record<string, any>;

/**
 * 比较两个 BOM 列表是否"结构等价"：按 (主件, 下阶, QPA) 排序后逐项比对。
 * 用于 GD 替代 BOM：若与标准 BOM 等价就直接走标准 BOM，不重复展开。
 */
export function compareData(data1: BomRow[], data2: BomRow[]): boolean {
    const keys = ['主件', '下阶', 'QPA'];
    const sortedData1 = [...data1].sort((a, b) => {
        for (const k of keys) {
            if (a[k] < b[k]) return -1;
            if (a[k] > b[k]) return 1;
        }
        return 0;
    });
    const sortedData2 = [...data2].sort((a, b) => {
        for (const k of keys) {
            if (a[k] < b[k]) return -1;
            if (a[k] > b[k]) return 1;
        }
        return 0;
    });
    for (let idx = 0; idx < sortedData1.length; idx++) {
        const d1 = sortedData1[idx];
        const d2 = sortedData2[idx];
        if (!d2) return false;
        for (const k of keys) {
            if (d1[k] !== d2[k]) return false;
        }
    }
    return true;
}

/**
 * 三层库存扣减：
 *   warehouses = {"可用库存": x1, "可用在制": x2, "GD01可用工单数": x3}
 *   按 库存 → 在制 → GD01 顺序扣 needs
 *   注：JS 中 for...in 顺序 = 对象插入顺序，与 Python dict 一致
 * @returns [剩余需求, 扣后余额 dict]
 */
export function demand(warehouses: Record<string, number>, needs: number): [number, Record<string, number>] {
    for (const warehouse in warehouses) {
        const stock = warehouses[warehouse];
        if (stock >= needs) {
            warehouses[warehouse] = stock - needs;
            needs = 0;
            break;
        } else {
            warehouses[warehouse] = 0;
            needs -= stock;
        }
    }
    return [Math.max(0, needs), warehouses];
}

/**
 * 把 BOM 列表 bom 展开一层：
 *   - 对每条 BOM 行 jj 复制一份
 *   - 跟单码 = m 的跟单码 + "." + 项次（用 . 区分层级）
 *   - 主件继承 m 的主件（虚拟件场景）
 *   - BOM 用量 = QPA × m 的 BOM 用量（虚拟件继承父量）
 *   - 调 s.remainOperation 扣库存 + 算前置时间
 *   - 如果是 非外购 + 净需求 > 0 → 继续 aaa 递归
 *
 * @param bom list[dict] BOM 行
 * @param n 父级净需求
 * @param m 父级 dict（含 跟单码 / 预计开工日期 / 父跟单码 ...）
 * @param s Serve 实例（带所有主数据 + 业务状态）
 */
export function xxxx(bom: BomRow[], n: number, m: BomRow, s: Serve): void {
    for (const [, j] of bom.entries()) {
        // 深拷贝 BOM 行（避免污染原数据；Python copy.copy 是浅拷贝，但 BOM 行内部不再嵌 dict，浅拷贝够用）
        const jj: BomRow = { ...j };
        // 虚拟件 (X) → 父跟单码继承自 m 的父跟单码
        jj['父跟单码'] = jj['主件类别'] === 'X' ? m['父跟单码'] : m['跟单码'];
        jj['跟单码'] = m['跟单码'] + '.' + String(j['项次']);
        jj['总装车间'] = m['总装车间'];
        const remark = s.remark.get(jj['跟单码']);
        jj['采购回复'] = remark ? remark[1] : '';
        jj['承诺交期'] = remark ? remark[2] : '';
        jj['主件'] = jj['主件类别'] === 'X' ? m['主件'] : jj['主件'];
        // 虚拟件：用父级的 BOM 用量 × 当前 QPA；否则直接用 QPA
        jj['BOM用量'] = jj['主件类别'] === 'X' ? jj['QPA'] * m['BOM用量'] : jj['QPA'];

        const base = s.baseDict[jj['下阶']];
        const mainBase = s.baseDict[jj['主件']];
        jj['主件单位'] = m['下阶单位'];
        jj['下阶单位'] = jj['发料单位'];
        // 主件级 5 个采购前置时间
        jj['文件前置时间'] = mainBase['IMAF171'];
        jj['交货前置时间'] = mainBase['IMAF172'];
        jj['到厂前置时间'] = mainBase['IMAF173'];
        jj['入库前置时间'] = mainBase['IMAF174'];
        jj['最短采购前置时间'] = mainBase['IMAF175'];
        // 主件级 4 个生产前置时间
        jj['固定生产前置时间'] = mainBase['IMAE071'];
        jj['变动生产前置时间'] = mainBase['IMAE072'];
        jj['QC前置时间'] = mainBase['IMAE074'];
        jj['累计前置时间'] = mainBase['IMAE075'];
        jj['生产损耗率'] = base['IMAE015'] != null ? base['IMAE015'] : 0;

        jj['毛需求'] = jj['BOM用量'] * n;
        // 继承父级的订单信息
        jj['客户订单号'] = m['客户订单号'];
        jj['总装锁定日期'] = m['总装锁定日期'];
        jj['立柱锁定日期'] = m['立柱锁定日期'];
        jj['来源单号'] = m['来源单号'];
        jj['成品工单号'] = m['成品工单号'];
        jj['成品工单状态'] = m['成品工单状态'];
        s.remainOperation(jj, m['预计开工日期'],
            m['成本中心集'] != null ? m['成本中心集'] : '');
        jj['齐套数'] = Number.POSITIVE_INFINITY;
        // 按 IMAE017（生产单位批量）向上取整 + 损耗率
        jj['净需求'] = base['IMAE017']
            ? Math.ceil(jj['净需求'] * (1 + jj['生产损耗率'] / 100) / base['IMAE017']) * base['IMAE017']
            : jj['净需求'] * (1 + jj['生产损耗率'] / 100);

        // 齐套数：父子取 min（看"实际能用库存"够生产多少个 BOM 套数）
        if ((m['齐套数'] ?? Number.POSITIVE_INFINITY) > jj['使用库存']) {
            m['齐套数'] = jj['使用库存'] / jj['BOM用量'];
        }

        // 成本中心集：非虚拟件 累加主件成本中心
        if (jj['下阶类别'] !== 'X') {
            jj['成本中心集'] = (m['成本中心集'] != null ? m['成本中心集'] : '') + ',' +
                (jj['主件成本中心'] != null ? jj['主件成本中心'] : '');
        } else {
            jj['成本中心集'] = m['成本中心集'] != null ? m['成本中心集'] : '';
        }

        if (jj['下阶类别'] !== 'X') {
            s.l.push(jj);
        }
        // 自制/委外 且 净需求 > 0 → 继续展开
        if ((base['IMAF013'] !== '1' || jj['下阶类别'] === 'X') && jj['净需求'] > 0) {
            s.aaa(jj);
        }
    }
}
