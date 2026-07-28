/**
 * excel/excel.ts
 * ============================================================
 * Excel 报告生成（Node.js + TypeScript 复刻版，openpyxl → exceljs）
 *
 * 与 Python 版完全等价：
 *   1. 中越双语标题对照表
 *   2. 数字格式化 / writerSheet / allocate / djmy
 *   3. f(site) 主入口：调用 compute → 6 类 Sheet → 落盘 → 写 MySQL → 清理
 *
 * 关键 Sheet：
 *   - 库存情况（ser.r）
 *   - 物料需求（ser.l 全字段）
 *   - 采购需求-明细（外购毛需求拆到采购单上）
 *   - 生产需求（自制+委外按下阶成本中心+下阶汇总）
 *   - 各下阶成本中心子 Sheet
 *   - 销售备货
 *   - 主计划
 */

import * as ExcelJS from 'exceljs';
import * as path from 'path';
import * as fs from 'fs';
import * as dayjs from 'dayjs';
import { Serve } from '../compute/compute';
import { mysqlLoad } from '../data/dataMysql';
import type { Row } from '../data/dataOracle';

// ---------------------------------------------------------------------------
// 1. 中越双语标题对照表（与 Python 版 1:1）
// ---------------------------------------------------------------------------
export const vnTitles: Record<string, string> = {
    "预计开工日期": "NGÀY BẮT ĐẦU DỰ KIẾN SẢN XUẤT",
    "预计完工日期": "NGÀY DỰ KIẾN HOÀN THÀNH",
    "客户订单号": "MÃ ĐƠN ĐẶT HÀNG CỦA KHÁCH HÀNG",
    "成品工单号": "MÃ CÔNG ĐƠN THÀNH PHẨM",
    "成品工单状态": "TRẠNG THÁI CÔNG ĐƠN THÀNH PHẨM",
    "父跟单码": "MÃ THEO ĐƠN XƯỞNG LẮP RÁP",
    "跟单码": "MÃ THEO ĐƠN",
    "主件": "LINH KIỆN CHỦ YẾU",
    "主件料名": "TÊN LIỆU CỦA LINH KIỆN CHÍNH",
    "主件规格": "QUY CÁCH LINH KIỆN CHÍNH",
    "主件成本中心": "TRUNG TÂM GIÁ THÀNH  LINH KIỆN CHÍNH",
    "下阶": "GIAI ĐOẠN SAU",
    "下阶料名": "TÊN LIỆU GIAI ĐOẠN SAU",
    "下阶规格": "QUY CÁCH GIAI ĐOẠN SAU",
    "下阶成本中心": "TRUNG TÂM GIÁ THÀNH GIAI ĐOẠN SAU",
    "BOM用量": "LƯỢNG DÙNG BOM",
    "毛需求": "TỔNG NHU CẦU",
    "总库存": "TỔNG TỒN KHO",
    "总在制": "TỔNG BÁN THÀNH PHẨM",
    "总装发出数量": "SỐ LƯỢNG PHÁT RA LẮP RÁP HOÀN CHỈNH",
    "GD01工单数": "SỐ CÔNG ĐƠN GD01",
    "总采购在途": "TỔNG MUA SẮM TRONG QUÁ TRÌNH VẬN CHUYỂN",
    "总工单供给": "CUNG CẤP TỔNG CÔNG ĐƠN",
    "总在验": " TỔNG SỐ ĐANG KIỂM NGHIỆM",
    "可用库存": "TỒN KHO CÓ THỂ DÙNG",
    "可用在制GD01": "BÁN THÀNH PHẨM CÓ THỂ DÙNG GD01",
    "可用工单数": "SỐ CÔNG ĐƠN CÓ THỂ DÙNG",
    "净需求": "NHU CẦU TỊNH",
    "合计欠料": "TỔNG SỐ THIẾU LIỆU",
    "子件标准人工工时": "THỜI GIAN TIÊU CHUẨN LINH KIỆN CON",
    "主件标准人工工时": "THỜI GIAN TIÊU CHUẨN LINH KIỆN CHÍNH",
    "补给策略": "CHÍNH SÁCH BÙ",
    "计划员": "NHÂN VIÊN KẾ HOẠCH",
    "采购物控人员": "NHÂN VIÊN KHỐNG CHẾ LIỆU THU MUA",
    "最近采购供应商": "NHÀ CUNG CẤP MUA HÀNG GẦN ĐÂY",
    "外购类型": "LOẠI HÌNH MUA NGOÀI",
    "材质": "CHẤT LIỆU",
    "最近采购供应商编码": "MÃ NHÀ CUNG CẤP MUA HÀNG GẦN ĐÂY",
    "采购单位批量": "ĐƠN VỊ MUA HÀNG SỐ LƯỢNG LỚN",
    "最小采购数量": "LƯỢNG MUA HÀNG NHỎ NHẤT",
    "采购单位": "ĐƠN VỊ MUA HÀNG",
    "生产单位批量": "ĐƠN VỊ SẢN XUẤT SỐ LƯỢNG LỚN",
    "最小生产数量": "SỐ LƯỢNG SẢN XUẤT NHỎ NHẤT",
    "生产单位": "ĐƠN VỊ SẢN XUẤT",
    "生产损耗率": "TỈ LỆ HƯ HẠI SẢN XUẤT",
    "固定生产前置时间": "THIẾT LẬP THỜI GIAN CỐ ĐỊNH TRƯỚC SẢN XUẤT",
    "变动生产前置时间": "THIẾT LẬP THỜI GIAN BIẾN ĐỘNG TRƯỚC SẢN XUẤT",
    "QC前置时间": "THIẾT LẬP THỜI GIAN TRƯỚC QC",
    "累计前置时间": "TỔNG CỘNG THỜI GIAN THIẾT LẬP",
    "来源单号": "NGUỒN GỐC MÃ ĐƠN",
    "需求计算方式": "PHƯƠNG THỨC TÍNH TOÁN YÊU CẦU",
    "齐套数": "SỐ ĐỦ BỘ",
    "主件单位": "ĐƠN VỊ LINH KIỆN CHÍNH",
    "下阶单位": "ĐƠN VỊ GIAI ĐOẠN SAU",
    "总装锁定日期": "CHỐT THỜI GIAN TỔNG LẮP RÁP",
    "立柱锁定日期": "CHỐT THỜI GIAN LẮP RÁP CHÂN",
    "承诺交期": "THỜI GIAN CAM KẾT GIAO HÀNG",
    "采购回复": "TRẢ LỜI THU MUA",
    "总装车间": "XƯỞNG LẮP RÁP",
    "越南主件料名": " TÊN LIỆU LINH KIỆN CHÍNH VIỆT NAM",
    "越南主件规格": "QUI CÁCH LIỆU CHÍNH VIỆT NAM",
    "越南下阶料名": "TÊN LIỆU VIỆT NAM GIAI ĐOẠN SAU",
    "越南下阶规格": "QUY CÁCH GIAI ĐOẠN SAU VIỆT NAM",
    "料号": "MÃ LIỆU",
    "料名": "TÊN LIỆU",
    "规格": "QUI CÁCH",
    "多余库存": "TỒN KHO DƯ",
    "多余在制": "BÁN THÀNH PHẨM DƯ",
    "安全库存量": "LƯỢNG TỒN KHO AN TOÀN",
    "总需求": "TỔNG YÊU CẦU",
    "多余库存含在途": "BAO GỒM LƯỢNG TỒN KHO TRÊN ĐƯỜNG VẬN CHUYỂN",
    "要求到货日期": "YÊU CẦU THỜI GIAN GIAO HÀNG",
    "需求": "YÊU CẦU",
    "采购单": "ĐƠN THU MUA",
    "单据日期": "NGÀY DỮ LIỆU CỦA ĐƠN",
    "采购单要求交期": "YÊU CẦU GIAO HÀNG ĐƠN THU MUA",
    "请购创建日期": "NGÀY TẠO YÊU CẦU MUA",
    "供应商": "NHÀ CUNG CẤP",
    "成本中心": "TRUNG TÂM GIÁ THÀNH",
    "是否新品": "CÓ PHẢI LIỆU MỚI",
    "多角贸易": "GIAO DICH ĐA GỐC",
    "接单日期": "NGÀY NHẬN ĐƠN",
    "约定交货日期": "HẸN THỜI GIAN GIAO HÀNG",
    "销售订单号": "MÃ ĐƠN HÀNG  KINH DOANH",
    "应发数量": "SỐ LƯỢNG PHẢI PHÁT",
    "缺料数量": "SỐ LƯỢNG THIẾU LIỆU",
    "备注": "GHI CHÚ",
    "净需求总和": "TỔNG SỐ NHU CẦU TỊNH",
    "齐套数总和": "TỔNG SỐ LƯỢNG ĐỦ BỘ",
    "人工工时": "THỜI GIAN NHÂN CÔNG",
    "工单供给": "CUNG CẤP CÔNG ĐƠN",
    "工单单号": "MÃ CÔNG ĐƠN",
    "工单状态": "TRẠNG THÁI CÔNG ĐƠN",
    "主件料号": "MÃ LIỆU LINH KIỆN CHÍNH",
    "主件需求数量": "SỐ LƯỢNG YÊU CẦU LINH KIỆN CHÍNH",
    "业务人员": "NHÂN VIÊN NGHIỆP VỤ",
    "客户": "KHÁCH HÀNG",
};

/** 调试用：打印当前工作目录 */
export function t(): void {
    console.log(process.cwd());
}

/** 数字格式化：整数去掉小数位，小数保留 3 位 */
export const formatFloat = (value: number): string =>
    value % 1 !== 0 ? Number(value).toFixed(3) : String(Math.trunc(value));

/**
 * 把"采购需求行 i 的需求 q"在它对应的成本中心额度 f 中按比例分配（Python allocate 的 1:1 复刻）
 * 注：Python 原版定义后未在主流程被调用（被注释掉），此处保留作为工具方法
 */
export function allocate(i: Row, q: number, f: Record<string, Record<string, number>>): void {
    const c = f[i['要求到货日期'] + i['下阶']];
    const firstKey = Object.keys(c)[0] || '';
    if (firstKey === '') {
        i['成本中心'] += ' ' + (i['成本中心'] === '' ? '' : formatFloat(q));
    } else if (c[firstKey] > q) {
        c[firstKey] -= q;
        i['成本中心'] += firstKey + (i['成本中心'] === '' ? '' : formatFloat(q));
    } else if (c[firstKey] === q) {
        i['成本中心'] += firstKey + (i['成本中心'] === '' ? '' : formatFloat(q));
        delete c[firstKey];
    } else {
        q -= c[firstKey];
        i['成本中心'] += firstKey + formatFloat(c[firstKey]) + ',';
        delete c[firstKey];
        allocate(i, q, f);
    }
}

/**
 * 把 data（list[dict]）按 titles 列顺序写到 worksheet：
 *   - 第 1 行：中文列头
 *   - 第 2 行：越南语列头（用 vnTitles 反查）
 *   - 第 3 行起：每条 dict 按列取值
 */
export function writerSheet(worksheet: ExcelJS.Worksheet, data: Row[], titles: string[]): void {
    titles.forEach((title, idx) => {
        const cell = worksheet.getCell(1, idx + 1);
        cell.value = title;
        const cell2 = worksheet.getCell(2, idx + 1);
        cell2.value = vnTitles[title] ?? '';
    });
    data.forEach((row, i1) => {
        titles.forEach((title, i2) => {
            worksheet.getCell(i1 + 3, i2 + 1).value = row[title] as any;
        });
    });
}

/**
 * 多角贸易判断（与 Python djmy 一致）
 *   跟单码 含 'XS07' 且不包含 . → ' 发越南'
 *   跟单码 含 'XS09' 且不包含 . → ' 发姜山'
 *   跟单码 含 'XS79' 且不包含 . → ' 发广西'
 */
export function djmy(d: Row): void {
    d['多角贸易'] = '';
    const elements = String(d['跟单码']).split(',');
    for (const element of elements) {
        if (!element.includes('.') && element.includes('XS07') && !String(d['多角贸易']).includes(' 发越南')) {
            d['多角贸易'] += ' 发越南';
        } else if (!element.includes('.') && element.includes('XS09') && !String(d['多角贸易']).includes(' 发姜山')) {
            d['多角贸易'] += ' 发姜山';
        } else if (!element.includes('.') && element.includes('XS79') && !String(d['多角贸易']).includes(' 发广西')) {
            d['多角贸易'] += ' 发广西';
        }
    }
}

/**
 * 主入口：为一个基地跑一次 MRP → Excel + MySQL
 * 流程与 Python 版完全一致
 */
export async function f(site: string): Promise<void> {
    const ser = new Serve(site);
    await ser.init();
    await ser.calculate();

    // 物料需求 Sheet 的完整列
    const kList: string[] = [
        '预计开工日期', '预计完工日期', '客户订单号', '成品工单号', '成品工单状态', '父跟单码', '跟单码', '主件', '主件料名', '主件规格', '主件成本中心', '下阶',
        '下阶料名', '下阶规格', '下阶成本中心', 'BOM用量', '毛需求', '总库存', '总在制', '总装发出数量', 'GD01工单数', '总采购在途', '总工单供给', '总在验', '可用库存',
        '可用在制', 'GD01可用工单数', '净需求', '合计欠料', '子件标准人工工时', '主件标准人工工时', '补给策略', '计划员', '采购物控人员', '最近采购供应商',
        '外购类型', '材质', '最近采购供应商编码', '采购单位批量', '最小采购数量', '采购单位',
        '生产单位批量', '最小生产数量', '生产单位', '生产损耗率', '固定生产前置时间', '变动生产前置时间',
        'QC前置时间', '累计前置时间', '来源单号', '需求计算方式', '齐套数', '主件单位', '下阶单位', '总装锁定日期', '立柱锁定日期', '承诺交期', '采购回复', '总装车间',
    ];
    if (site === 'YN') {
        kList.push('越南主件料名', '越南主件规格', '越南下阶料名', '越南下阶规格');
    }

    const workbook = new ExcelJS.Workbook();

    // ---------- Sheet 1: 库存情况 ----------
    const rList = ['料号', '料名', '规格', '总库存', '总在制', '多余库存', '多余在制', '安全库存量', '总需求', '总在验', '总采购在途', '多余库存含在途'];
    const ws1 = workbook.addWorksheet('库存情况', { views: [{ state: 'normal' }] });
    // 注意：原版 writer_sheet 第 2 个参数是 data，第 3 个是 worksheet（顺序与 Python 保持一致）
    writerSheet(ws1, ser.r, rList);

    let wgCopy: Row[] | null = null;
    let wgD: Row[] = [];
    let zjData: Row[] | null = null;
    console.log(`[${site}] ser.l.length=${ser.l.length}, ser.r.length=${ser.r.length}`);

    if (ser.l.length > 0) {
        // ==================== 销售备货 ====================
        // 简单内存版 DataFrame（仅支持这里用到的过滤/排序/groupBy）
        const df = simpleDataFrame(ser.l as any);

        const dfXs = df
            .filter(r => String(r['成品工单号']).includes('XS') && !String(r['跟单码']).includes('.'))
            .rename({
                '预计开工日期': '约定交货日期',
                '成品工单号': '销售订单号',
                '下阶': '料号',
                '下阶料名': '料名',
                '下阶规格': '规格',
                '下阶成本中心': '成本中心',
                '毛需求': '应发数量',
                '净需求': '缺料数量',
            });
        const wsXs = workbook.addWorksheet('销售备货', { views: [{ state: 'normal' }] });
        dfXs.rows.forEach(r => {
            const docdtVal = ser.docdt[r['销售订单号']];
            r['接单日期'] = docdtVal ? dayjs.default(docdtVal as any).format('YYYY-MM-DD') : '';
        });
        writerSheet(wsXs, dfXs.rows, ['接单日期', '约定交货日期', '销售订单号', '料号', '料名', '规格', '成本中心', '应发数量', '缺料数量',
            '总库存', '总在制', '总采购在途', '总在验', '备注']);

        // ==================== 采购需求明细 ====================
        const dfWg = df
            .filter(r => r['补给策略'] === '外购' && r['净需求'] !== 0)
            .fillna({ '下阶料名': '', '下阶规格': '', '采购物控人员': '', '最近采购供应商': '' });

        const groupedWg = dfWg.rename({ '净需求': '净需求总和', '预计开工日期': '要求到货日期' });
        groupedWg.sortBy('要求到货日期');
        groupedWg.rows.forEach(r => {
            r['要求到货日期'] = dayjs.default(r['要求到货日期'] as any).subtract(1, 'day').format('YYYY-MM-DD');
        });
        const wg = groupedWg.rows;
        wgCopy = deepCopy(wg);
        const wgCopy2 = deepCopy(wg);
        const fObj: Record<string, Record<string, number>> = {};
        for (const i of wgCopy2) {
            fObj[i['要求到货日期'] + i['下阶']] = i['主件成本中心'] as any;
        }
        const p = ser.purchaseOrderDetailDict as Record<string, Row[]>;
        wgD = [];
        for (const i of wgCopy2) {
            const pp = p[i['下阶']];
            let x: number = i['净需求总和'];
            delete i['净需求总和'];
            if (pp) {
                for (const j of pp) {
                    if (j['ZTNUM'] >= x) {
                        const ii: Row = {
                            ...i,
                            '采购单': j['CGD'],
                            '单据日期': j['PMDLDOCDT'] ? dayjs.default(j['PMDLDOCDT'] as any).format('YYYY-MM-DD') : null,
                            '采购单要求交期': j['PMDO013'] != null ? dayjs.default(j['PMDO013'] as any).format('YYYY-MM-DD') : null,
                            '请购创建日期': j['CJRQ'],
                            '供应商': j['PMAAL003'] != null ? j['PMAAL003'] : i['最近采购供应商'],
                            '需求': x,
                            '未处理请购数': null,
                            '采购物控人员': j['OOAG011'] != null ? j['OOAG011'] : i['采购物控人员'],
                            '公司型号': j['公司型号'],
                            '客户型号': j['客户型号'],
                        };
                        if (String(ii['采购单']).includes('QG34') && ser.site === 'LG') {
                            ii['采购物控人员'] = '千银海';
                        }
                        j['ZTNUM'] -= x;
                        x = 0;
                        wgD.push(ii);
                        break;
                    } else if (j['ZTNUM'] === 0) {
                        continue;
                    } else {
                        const ii: Row = {
                            ...i,
                            '采购单': j['CGD'],
                            '单据日期': j['PMDLDOCDT'] ? dayjs.default(j['PMDLDOCDT'] as any).format('YYYY-MM-DD') : null,
                            '采购单要求交期': j['PMDO013'] != null ? dayjs.default(j['PMDO013'] as any).format('YYYY-MM-DD') : null,
                            '请购创建日期': j['CJRQ'],
                            '供应商': j['PMAAL003'] != null ? j['PMAAL003'] : i['最近采购供应商'],
                            '需求': j['ZTNUM'],
                            '未处理请购数': null,
                            '采购物控人员': j['OOAG011'] != null ? j['OOAG011'] : i['采购物控人员'],
                            '公司型号': j['公司型号'],
                            '客户型号': j['客户型号'],
                        };
                        if (String(ii['采购单']).includes('QG34') && ser.site === 'LG') {
                            ii['采购物控人员'] = '千银海';
                        }
                        x = x - j['ZTNUM'];
                        j['ZTNUM'] = 0;
                        wgD.push(ii);
                    }
                }
            }
        }

        const cgXp = (x: string) => {
            const base = ser.baseDict[x] || {} as any;
            if (base['IMAFUD003'] !== 'Y' && base['IMAFUA003'] === 'Y') return '新品已试产';
            if (base['IMAFUD003'] !== 'Y') return '新品';
            return '';
        };

        for (const i of wgD) {
            const remark = ser.remark.get(i['跟单码']);
            i['采购回复'] = remark ? remark[1] : '';
            i['承诺交期'] = remark ? remark[2] : '';
            i['是否新品'] = cgXp(i['下阶']);
            i['成本中心'] = i['主件成本中心'];
            djmy(i);
            i['采购物控人员'] = ser.ryjj.get(i['采购物控人员']) ?? i['采购物控人员'];
            for (const jjj of ser.l) {
                if (i['跟单码'] === jjj['跟单码']) {
                    jjj['采购物控人员'] = i['采购物控人员'];
                }
            }
            if (ser.site === 'YN' || ser.site === 'FN') {
                const vnItemsF = ser.vnItemsDict[i['下阶']];
                i['越南下阶料名'] = vnItemsF ? vnItemsF['IMAAL003'] || '' : '';
                i['越南下阶规格'] = vnItemsF ? vnItemsF['IMAAL004'] || '' : '';
            }
        }

        let cgTitles: string[] = ['采购物控人员', '要求到货日期', '下阶', '下阶料名', '下阶规格', '需求', '总采购在途', '总库存', '总在制', '总在验',
            '采购单', '单据日期', '采购单要求交期', '请购创建日期', '供应商', '外购类型', '客户订单号', '跟单码', '成本中心',
            '总装锁定日期', '立柱锁定日期', '是否新品', '多角贸易', '承诺交期', '采购回复'];
        let cgSheetName = '采购需求-明细';
        if (ser.site === 'YN' || ser.site === 'FN') {
            cgSheetName += 'nhu cầu liệu thu mua - chi tiết';
            cgTitles = cgTitles.concat(['越南下阶料名', '越南下阶规格']);
        }
        const wsCg = workbook.addWorksheet(cgSheetName);
        writerSheet(wsCg, wgD, cgTitles);

        // ---------- 物料需求（明细）----------
        const wsWl = workbook.addWorksheet('物料需求', { views: [{ state: 'normal' }] });
        writerSheet(wsWl, ser.l, kList);

        // ==================== 生产需求 ====================
        const dfZz = df
            .filter(r => r['补给策略'] !== '外购' && r['净需求'] !== 0)
            .fillna({ '下阶料名': '', '下阶规格': '', '下阶成本中心': '' });

        const titles: string[] = ['下阶成本中心', '预计完工日期', '下阶', '下阶料名', '下阶规格', '净需求总和', '齐套数总和', '人工工时',
            '工单供给', '总工单供给', '跟单码', '总装锁定日期', '立柱锁定日期', '是否新品', '多角贸易', '主件成本中心'];
        dfZz.rows.forEach(r => {
            r['喷涂料名'] = r['主件料名'];
            const isWeldingOrLaser = ['焊接车间-乐歌', '激光切割车间'].includes(r['下阶成本中心']);
            if (!isWeldingOrLaser || r['主件成本中心'] !== '喷塑车间-乐歌') {
                r['喷涂料名'] = '';
            }
        });
        // groupBy 实现
        const grouped = groupByAgg(dfZz.rows, ['下阶成本中心', '下阶成本中心编码', '预计开工日期', '下阶', '下阶料名', '下阶规格', '总工单供给', '喷涂料名', '主件成本中心'],
            {
                '净需求': 'sum',
                '齐套数': 'sum',
                '人工工时': 'sum',
                '跟单码': (rows: Row[]) => rows.map(r => r['跟单码']).join(','),
                '总装锁定日期': (rows: Row[]) => rows.some(r => r['总装锁定日期']) ? rows.map(r => r['总装锁定日期']).join(',') : '',
                '立柱锁定日期': (rows: Row[]) => rows.some(r => r['立柱锁定日期']) ? rows.map(r => r['立柱锁定日期']).join(',') : '',
            });
        grouped.forEach(r => {
            r['净需求总和'] = r['净需求_sum'];
            r['齐套数总和'] = r['齐套数_sum'];
            r['预计完工日期'] = r['预计开工日期'];
            delete r['净需求_sum'];
            delete r['齐套数_sum'];
            delete r['预计开工日期'];
        });

        const zjXp = (x: string) => {
            const base = ser.baseDict[x] || {} as any;
            if (base['IMAFUD004'] !== 'Y' && base['IMAFUA004'] === 'Y') return '新品已试产';
            if (base['IMAFUD004'] !== 'Y') return '新品';
            return '';
        };

        grouped.forEach(r => {
            r['预计完工日期'] = dayjs.default(r['预计完工日期'] as any).subtract(1, 'day').format('YYYY-MM-DD');
        });
        const zgd: Record<string, number> = { ...ser.productionSupplyDict };
        for (const r of grouped) {
            if ((zgd[r['下阶']] || 0) > r['净需求总和']) {
                r['工单供给'] = r['净需求总和'];
                zgd[r['下阶']] -= r['净需求总和'];
            } else {
                r['工单供给'] = zgd[r['下阶']] || 0;
                zgd[r['下阶']] = 0;
            }
        }
        zjData = grouped;
        for (const i of zjData) {
            i['是否新品'] = zjXp(i['下阶']);
            djmy(i);
            if (ser.site === 'YN' || ser.site === 'FN') {
                const vnItemsF = ser.vnItemsDict[i['下阶']];
                i['越南下阶料名'] = vnItemsF ? vnItemsF['IMAAL003'] || '' : '';
                i['越南下阶规格'] = vnItemsF ? vnItemsF['IMAAL004'] || '' : '';
            }
        }
        let zjTitles = [...titles];
        if (ser.site === 'YN' || ser.site === 'FN') {
            zjTitles = zjTitles.concat(['越南下阶料名', '越南下阶规格']);
        }
        const wsZj = workbook.addWorksheet('生产需求');
        writerSheet(wsZj, zjData, zjTitles);

        // ---------- 按下阶成本中心拆 Sheet ----------
        zjTitles.shift(); // 去掉"下阶成本中心"列
        const titleListSet = new Set<string>();
        dfZz.rows.forEach(r => {
            const v = r['下阶成本中心'];
            if (v && typeof v === 'string' && v.trim()) titleListSet.add(v);
        });
        const sortDict: Record<string, string[]> = {
            'LG': ['委外需求', '激光切割车间', '焊接车间-乐歌', '喷塑车间-乐歌', '总装一车间', '总装二车间', '总装三车间', '总装四车间', '木工车间'],
        };
        const listSort = sortDict[site] || [];
        const titleList = Array.from(titleListSet).sort((a, b) => {
            const ia = listSort.indexOf(a);
            const ib = listSort.indexOf(b);
            if (ia === -1 && ib === -1) return 0;
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
        });
        for (const aValue of titleList) {
            const titles1 = [...zjTitles];
            if (['焊接车间-乐歌', '激光切割车间'].includes(aValue)) {
                titles1.push('喷涂料名');
            }
            const ws = workbook.addWorksheet(aValue);
            const aData = grouped.filter(r => r['下阶成本中心'] === aValue);
            for (const r of aData) {
                r['是否新品'] = zjXp(r['下阶']);
                djmy(r);
                if (ser.site === 'YN' || ser.site === 'FN') {
                    const vnItemsF = ser.vnItemsDict[r['下阶']];
                    r['越南下阶料名'] = vnItemsF ? vnItemsF['IMAAL003'] || '' : '';
                    r['越南下阶规格'] = vnItemsF ? vnItemsF['IMAAL004'] || '' : '';
                }
            }
            writerSheet(ws, aData, titles1);
        }

        // ==================== 主计划 ====================
        // 构造主计划 df：与 Python 完全一致
        const needDf = simpleDataFrame(ser.need.map((r: Row) => ({
            '预计开工日期': r['预计开工日期'],
            '预计完工日期': r['预计完工日期'],
            '主件料号': r['主件料号'],
            '主件需求数量': r['主件需求数量'],
            '工单状态': r['工单状态'],
            '工单单号': r['工单单号'],
            'SFBASEQ': r['SFBASEQ'],
            '客户订单号': r['SFAAUD002'],
            '业务人员': r['OOAG011'],
            '客户': r['客户'],
        })));
        needDf.rows.forEach(r => {
            r['预计开工日期'] = dayjs.default(r['预计开工日期'] as any).format('YYYY-MM-DD');
            r['预计完工日期'] = dayjs.default(r['预计完工日期'] as any).format('YYYY-MM-DD');
        });
        needDf.rows.forEach(r => {
            const item = ser.itemsDict[r['主件料号']];
            r['主件料名'] = item['IMAAL003'];
            r['主件规格'] = item['IMAAL004'];
            // process_work_order
            const wo = String(r['工单单号']);
            if (wo.length >= 5 && wo.substring(3, 5) === 'GD') {
                r['SFBASEQ'] = 0;
            }
        });
        // 去重
        const seen = new Set<string>();
        const dedupedRows: Row[] = [];
        for (const r of needDf.rows) {
            const k = JSON.stringify(r);
            if (!seen.has(k)) { seen.add(k); dedupedRows.push(r); }
        }
        needDf.rows = dedupedRows;
        const wsMp = workbook.addWorksheet('主计划');
        writerSheet(wsMp, needDf.rows, ['预计开工日期', '预计完工日期', '客户订单号', '工单单号', '工单状态',
            '主件料号', '主件料名', '主件规格', '主件需求数量', '业务人员', '客户']);

        // 删除空 Sheet
        if (workbook.worksheets.some(w => w.name === 'Sheet')) {
            const empty = workbook.getWorksheet('Sheet');
            if (empty) workbook.removeWorksheet(empty.id);
        }
    }

    // 文件版本：site_yymmddHHMMSS
    const version = `${site}_${dayjs.default(new Date()).format('YYMMDDHHmmss')}`;

    // 保存路径：
    //   APS_OUTPUT_DIR 有值 → {APS_OUTPUT_DIR}/{site}/{site}_<version>.xlsx（每个基地一个 subdir）
    //   否则：cwd/{site}/{site}_<version>.xlsx
    //   （和 src/httpServer.ts 的 listFilesForSite(site, outputDir) 约定一致）
    const fileDir = process.env.APS_OUTPUT_DIR
        ? path.join(process.env.APS_OUTPUT_DIR, site)
        : path.join(process.cwd(), site);
    if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
    }
    const filePath = path.join(fileDir, `${version}.xlsx`);
    console.log(`[${site}] Excel 落盘 → ${filePath}`);

    // 流式写盘：
    //   1. writeBuffer() 在内存里生成 Buffer（exceljs 没有真 streaming 写）
    //   2. 用 createWriteStream 边写边 flush，避免一次性把 Buffer 全部驻留
    //   3. 对超大 Excel（10w+ 行）可改用 CSV 落盘后再用 xlsx-stream 二次处理
    const buffer: Buffer = await workbook.xlsx.writeBuffer() as unknown as Buffer;
    console.log(`[${site}] buffer: type=${buffer.constructor.name} len=${buffer.length} isBuf=${Buffer.isBuffer(buffer)}`);
    await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(filePath);
        ws.on('error', (e) => { console.error(`[${site}] stream error:`, e); reject(e); });
        ws.on('finish', () => { console.log(`[${site}] stream finish, file size=${fs.existsSync(filePath) ? fs.statSync(filePath).size : 'N/A'}`); resolve(); });
        ws.end(buffer);
    });

    // 写 MySQL（如果配置了 SKIP_MYSQL=true 或连不上则优雅跳过）
    const skipMysql = process.env.SKIP_MYSQL === 'true';
    if (skipMysql) {
        console.log(`[${site}] 跳过 MySQL 写入（SKIP_MYSQL=true）`);
    } else {
        try {
            await mysqlLoad(ser.l, site, version, wgD, zjData);
        } catch (e) {
            console.warn(`[${site}] MySQL 写入失败（${(e as Error).message}），已跳过：仅保留 Excel`);
        }
    }

    // 清理当天同名旧文件（同 9 位前缀），保留最大
    const fileNames = fs.readdirSync(fileDir);
    if (fileNames.length > 0) {
        const maxFileName = fileNames.reduce((a, b) => (a > b ? a : b));
        const siteElements = fileNames.filter(n => n.startsWith(maxFileName.substring(0, 9)));
        for (const fileName of siteElements) {
            if (fileName !== maxFileName) {
                fs.unlinkSync(path.join(fileDir, fileName));
            }
        }
    }
}

// ===========================================================================
// 简单的内存 DataFrame（避免引入 pandas / danfo.js，仅实现这里用到的子集）
// ===========================================================================
class SimpleDataFrame {
    rows: Row[];
    constructor(rows: Row[]) { this.rows = rows; }
    filter(pred: (r: Row) => boolean): SimpleDataFrame {
        return new SimpleDataFrame(this.rows.filter(pred));
    }
    fillna(map: Record<string, any>): SimpleDataFrame {
        for (const r of this.rows) {
            for (const k of Object.keys(map)) {
                if (r[k] == null) r[k] = map[k];
            }
        }
        return this;
    }
    rename(map: Record<string, string>): SimpleDataFrame {
        const newRows = this.rows.map(r => {
            const nr: Row = { ...r };
            for (const [from, to] of Object.entries(map)) {
                if (from in nr) {
                    nr[to] = nr[from];
                    delete nr[from];
                }
            }
            return nr;
        });
        return new SimpleDataFrame(newRows);
    }
    sortBy(col: string): SimpleDataFrame {
        const newRows = [...this.rows].sort((a, b) => {
            const av = a[col], bv = b[col];
            if (av instanceof Date && bv instanceof Date) return av.getTime() - bv.getTime();
            return av < bv ? -1 : av > bv ? 1 : 0;
        });
        return new SimpleDataFrame(newRows);
    }
}

function simpleDataFrame(rows: Row[]): SimpleDataFrame {
    return new SimpleDataFrame(rows);
}

function deepCopy<T>(arr: T[]): T[] {
    return JSON.parse(JSON.stringify(arr));
}

/**
 * 内存 groupBy + agg 实现（仅支持 sum / 字符串拼接 / 任意 reducer）
 */
function groupByAgg(rows: Row[], keys: string[], agg: Record<string, string | ((rows: Row[]) => any)>): Row[] {
    const groups: Record<string, Row[]> = {};
    for (const r of rows) {
        const k = keys.map(key => r[key]).join('|');
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
    }
    const result: Row[] = [];
    for (const k of Object.keys(groups)) {
        const grp = groups[k];
        const out: Row = {};
        for (const key of keys) {
            out[key] = grp[0][key];
        }
        for (const [col, fn] of Object.entries(agg)) {
            const values = grp.map(r => r[col]);
            if (fn === 'sum') {
                out[col + '_sum'] = values.reduce((a, b) => Number(a) + Number(b), 0);
            } else if (typeof fn === 'function') {
                out[col] = fn(grp);
            }
        }
        result.push(out);
    }
    return result;
}
