/**
 * src/admin/schema.ts
 * ============================================================
 * 22 张 raw_* 表的字段 → 中文 label 映射
 *
 * 来源：
 *   - 表结构见 initdb/02-raw-tables.sql
 *   - 中文字段名大多来自鼎捷 GP ERP dzebl_t 字典
 *   - 不在字典的字段用业务约定命名
 */

export interface ColumnInfo {
    /** 物理列名（DB 中真实列名） */
    name: string;
    /** 中文 label（页面显示） */
    label: string;
    /** 类型提示（仅用于 UI 提示） */
    type?: string;
    /** 接口 SQL 中的来源表 */
    sourceTable?: string;
    /** 接口 SQL 中的原始字段；计算字段可写表达式/别名 */
    sourceField?: string;
}

/**
 * 每张 raw_* 表的列信息（按页面显示顺序）
 * 注：label 多数已对照 dzebl_t 字典表
 */
export const RAW_SCHEMA: Record<string, ColumnInfo[]> = {
    raw_base: [
        { name: 'site', label: '据点', sourceTable: 'IMAF_T', sourceField: 'IMAFSITE' },
        { name: 'part_no', label: '料件编号', sourceTable: 'IMAF_T', sourceField: 'IMAF001' },
        { name: 'supply_strategy', label: '补给策略', type: '1=外购/2=自制/3=委外', sourceTable: 'IMAF_T', sourceField: 'IMAF013' },
        { name: 'demand_calc_method', label: '需求计算方法', sourceTable: 'IMAF_T', sourceField: 'IMAF014' },
        { name: 'safety_stock', label: '安全库存量', type: 'DECIMAL', sourceTable: 'IMAF_T', sourceField: 'IMAF026' },
        { name: 'po_uom', label: '采购单位', sourceTable: 'IMAF_T', sourceField: 'IMAF143' },
        { name: 'po_batch_qty', label: '采购批量', type: 'DECIMAL', sourceTable: 'IMAF_T', sourceField: 'IMAF145' },
        { name: 'po_min_qty', label: '最小采购量', type: 'DECIMAL', sourceTable: 'IMAF_T', sourceField: 'IMAF146' },
        { name: 'is_module', label: '是否模块化', type: 'Y/N', sourceTable: 'IMAF_T', sourceField: 'IMAFUD010' },
        { name: 'buyer_code', label: '采购人员', sourceTable: 'OOAG_T', sourceField: 'OOAG011（关联 IMAF142）' },
        { name: 'mat_ctrl_code', label: '物控人员', sourceTable: 'OOAG_T', sourceField: 'OOAG011（关联 IMAFUD001）' },
        { name: 'planner', label: '计划员', sourceTable: 'OOAG_T', sourceField: 'OOAG011（关联 IMAE012）' },
        { name: 'prod_loss_rate', label: '生产损耗率', type: 'DECIMAL', sourceTable: 'IMAE_T', sourceField: 'IMAE015' },
        { name: 'mo_uom', label: '生产单位', sourceTable: 'IMAE_T', sourceField: 'IMAE016' },
        { name: 'mo_batch_qty', label: '生产批量', type: 'DECIMAL', sourceTable: '计算值', sourceField: '常量 1（别名 IMAE017）' },
        { name: 'mo_min_qty', label: '最小生产量', type: 'DECIMAL', sourceTable: 'IMAE_T', sourceField: 'IMAE018' },
        { name: 'std_man_hour', label: '标准人工工时', type: 'DECIMAL', sourceTable: 'IMAE_T', sourceField: 'IMAE037' },
        { name: 'doc_lt', label: '文件前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAF_T', sourceField: 'IMAF171' },
        { name: 'delivery_lt', label: '交货前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAF_T', sourceField: 'IMAF172' },
        { name: 'arrival_lt', label: '到厂前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAF_T', sourceField: 'IMAF173' },
        { name: 'storage_lt', label: '入库前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAF_T', sourceField: 'IMAF174' },
        { name: 'fixed_lt', label: '固定生产前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAE_T', sourceField: 'IMAE032' },
        { name: 'variable_lt', label: '变动生产前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAE_T', sourceField: 'IMAE064' },
        { name: 'qc_lt', label: 'QC前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAE_T', sourceField: 'IMAE022' },
        { name: 'accum_lt', label: '累计前置时间', type: 'DECIMAL(天)', sourceTable: 'IMAE_T', sourceField: 'IMAE036' },
        { name: 'default_cc', label: '默认成本中心', sourceTable: 'IMAE_T', sourceField: 'IMAE035（含 CASE）' },
        { name: 'cc_name', label: '成本中心名称', sourceTable: 'OOEFL_T', sourceField: 'OOEFL003（含 CASE）' },
        { name: 'has_purchased', label: '是否采购过', type: 'Y/N', sourceTable: 'IMAE_T', sourceField: 'IMAE051' },
        { name: 'has_self_made', label: '是否自制过', type: 'Y/N', sourceTable: 'IMAE_T', sourceField: 'IMAE071' },
        { name: 'rd_purchased', label: '研发采购过', type: 'Y/N', sourceTable: 'IMAE_T', sourceField: 'IMAE072' },
        { name: 'rd_self_made', label: '研发自制过', type: 'Y/N', sourceTable: 'IMAE_T', sourceField: 'IMAE074' },
        { name: 'pulled_at', label: '拉取时间', sourceTable: '本地生成', sourceField: 'new Date()' },
    ],
    raw_bom: [
        { name: 'site', label: '据点' },
        { name: 'main_part', label: '主件料号' },
        { name: 'sub_part', label: '元件料号' },
        { name: 'qty', label: '用量', type: 'DECIMAL' },
        { name: 'main_type', label: '主件类别', type: 'X=虚拟件/W=实体' },
        { name: 'sub_type', label: '元件类别' },
        { name: 'issue_uom', label: '发料单位' },
        { name: 'seq', label: '项次' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_need: [
        { name: 'site', label: '据点' },
        { name: 'source', label: '来源', type: 'sf=工单/xmdd=销售' },
        { name: 'doc_no', label: '工单单号 / 销售订单号' },
        { name: 'sfbaseq', label: '序号' },
        { name: 'plan_start', label: '预计开工日期' },
        { name: 'status', label: '工单状态', type: '已审核/已发出' },
        { name: 'plan_end', label: '预计完工日期' },
        { name: 'main_part', label: '主件料号' },
        { name: 'qty', label: '需求数量', type: 'DECIMAL' },
        { name: 'src_doc', label: '来源单号' },
        { name: 'sfba006', label: '发料料号' },
        { name: 'qpa_num', label: 'QPA 分子', type: 'DECIMAL' },
        { name: 'qpa_den', label: 'QPA 分母', type: 'DECIMAL' },
        { name: 'sfba014', label: '发料单位' },
        { name: 'package_pending', label: '包材未确认' },
        { name: 'ooag011', label: '业务人员' },
        { name: 'customer', label: '客户' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_remain: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'qty', label: '现有数量', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_cj: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'qty', label: '在制数量', type: 'DECIMAL' },
        { name: 'sfba006', label: '发料料号' },
        { name: 'qpa_num', label: '用量分子' },
        { name: 'qpa_den', label: '用量分母' },
        { name: 'sfba013', label: '已发料量' },
        { name: 'sfba014', label: '发料单位' },
        { name: 'sfbadocno', label: '工单单号' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_in_transit: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'qty', label: '在途数量', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_purchase_order: [
        { name: 'site', label: '据点' },
        { name: 'pmdo001', label: '料号' },
        { name: 'ztnum', label: '未交量', type: 'DECIMAL' },
        { name: 'ztnum2', label: '原始未交量', type: 'DECIMAL' },
        { name: 'pmdl004', label: '供应商编码' },
        { name: 'pmaal003', label: '供应商' },
        { name: 'cgd', label: '采购单号(完整)' },
        { name: 'pmdldocdt', label: '单据日期' },
        { name: 'pmdo013', label: '采购要求交期' },
        { name: 'cjrq', label: '请购创建日期' },
        { name: 'pmdlstus', label: '审核状态' },
        { name: 'ooag011', label: '采购员' },
        { name: 'customer_model', label: '客户型号' },
        { name: 'company_model', label: '公司型号' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_buyer: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'buyer', label: '采购员' },
        { name: 'supplier', label: '供应商' },
        { name: 'supplier_code', label: '供应商编码' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_testfunc: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'qty', label: '在验数量', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_production_supply: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'issued', label: '已发量', type: 'DECIMAL' },
        { name: 'received', label: '已领量', type: 'DECIMAL' },
        { name: 'qty', label: '工单供给', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_items: [
        { name: 'site', label: '据点' },
        { name: 'lang', label: '语系', type: 'zh_CN/vi_VN' },
        { name: 'part_no', label: '料号' },
        { name: 'name', label: '产品名称' },
        { name: 'spec', label: '产品规格' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_safetystock: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'qty', label: '安全库存量', type: 'DECIMAL' },
        { name: 'uom', label: '单位' },
        { name: 'pulled_at', label: '拉取时间' },
        { name: 'qty', label: '安全库存量', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_substitute: [
        { name: 'site', label: '据点' },
        { name: 'bmea001', label: '主件料号' },
        { name: 'bmea003', label: '替代料号' },
        { name: 'bmea008', label: '替代说明' },
        { name: 'bmea011', label: '替代特征' },
        { name: 'bmea012', label: '替代备注' },
        { name: 'bmea016', label: '替代用量', type: 'DECIMAL' },
        { name: 'bmea007', label: '生效日期' },
        { name: 'bmea015', label: '优先级' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_outsourcing_type: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'outsource_type', label: '外购类型' },
        { name: 'material', label: '材质' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_gd01: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '主件料号' },
        { name: 'qty', label: 'GD01 工单数', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_gd_bom: [
        { name: 'site', label: '据点' },
        { name: 'doc_no', label: '工单单号' },
        { name: 'main_part', label: '主件料号' },
        { name: 'qty', label: '未交量', type: 'DECIMAL' },
        { name: 'sub_part', label: '发料料号' },
        { name: 'qpa', label: '用量比例', type: 'DECIMAL' },
        { name: 'issue_uom', label: '发料单位' },
        { name: 'seq', label: '项次' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
    raw_special_supply: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料号' },
        { name: 'qty', label: '特殊工单供给', type: 'DECIMAL' },
        { name: 'pulled_at', label: '拉取时间' },
    ],
};

/** 本地字段 → 线上接口 SQL 来源；仅登记能从现有接口明确确认的对应关系。 */
const SOURCE_META: Record<string, Record<string, [string, string]>> = {
    raw_bom: {
        main_part: ['BMBA_T', 'BMBA001'], sub_part: ['BMBA_T', 'BMBA003'],
        qty: ['BMBA_T', 'BMBA004'], main_type: ['BMBA_T', 'BMBA005'],
        sub_type: ['BMBA_T', 'BMBA006'], issue_uom: ['BMBA_T', 'BMBA007'], seq: ['BMBA_T', 'BMBA009'],
    },
    raw_need: {
        source: ['本地生成', 'sf / xmdd'], doc_no: ['SFAA_T / XMDD_T', 'SFAADOCNO / XMDDDOCNO'],
        sfbaseq: ['XMDD_T', 'XMDDSEQ'], plan_start: ['SFAA_T / XMDD_T', 'SFAA019 / XMDD011'],
        status: ['SFAA_T', 'SFAASTUS（CASE）'], plan_end: ['SFAA_T', 'SFAA020'],
        main_part: ['SFAA_T / XMDD_T', 'SFAA010 / XMDD001'],
        qty: ['SFAA_T / XMDD_T', 'SFAA012-SFAA050 / XMDD006-XMDD014+XMDD016'],
        src_doc: ['SFAA_T', 'SFAA006'], ooag011: ['OOAG_T', 'OOAG011'], customer: ['XMDD_T', '接口计算/空值'],
    },
    raw_remain: { part_no: ['INAG_T', 'INAG001'], qty: ['INAG_T', 'INAG008'] },
    raw_cj: {
        sfba006: ['SFBA_T', 'SFBA006'], qpa_num: ['SFBA_T', 'SFBA010'],
        qpa_den: ['SFBA_T', 'SFBA011'], sfba013: ['SFBA_T', 'SFBA013'],
        sfba014: ['SFBA_T', 'SFBA014'], sfbadocno: ['SFBA_T', 'SFBADOCNO'],
    },
    raw_in_transit: {
        part_no: ['PMDO_T', 'PMDO001'],
        qty: ['PMDO_T', 'SUM(PMDO006-PMDO019+PMDO017)'],
    },
    raw_purchase_order: {
        pmdo001: ['PMDO_T', 'PMDO001'], ztnum: ['PMDO_T', 'PMDO006-PMDO019+PMDO017'],
        ztnum2: ['PMDO_T', 'PMDO001（接口当前别名）'], pmdl004: ['PMDL_T', 'PMDL004'],
        pmaal003: ['PMAAL_T', 'PMAAL003'], cgd: ['PMDO_T', '组合单号（CASE）'],
        pmdldocdt: ['PMDL_T', 'PMDLDOCDT'], pmdo013: ['PMDO_T', 'PMDO013'],
        pmdlstus: ['PMDL_T', 'PMDLSTUS'], ooag011: ['OOAG_T', 'OOAG011'],
        customer_model: ['PMDN_T', 'PMDNUA019'], company_model: ['PMDN_T', 'PMDNUA120'],
    },
    raw_buyer: {
        part_no: ['PMDN_T', 'PMDN001'], buyer: ['OOAG_T', 'OOAG011'],
        supplier: ['PMAAL_T', 'PMAAL003'], supplier_code: ['PMDL_T', 'PMDL004'],
    },
    raw_testfunc: { part_no: ['PMDT_T', 'PMDT006'], qty: ['PMDT_T', 'SUM(PMDT020-PMDT054-PMDT055)'] },
    raw_production_supply: {
        part_no: ['SFAC_T', 'SFAC001'], qty: ['SFAC_T', 'SUM(SFAC003-SFAC005)'],
    },
    raw_items: {
        lang: ['IMAAL_T', 'IMAAL002（请求参数）'], part_no: ['IMAAL_T', 'IMAAL001'],
        name: ['IMAAL_T', 'IMAAL003'], spec: ['IMAAL_T', 'IMAAL004'],
    },
    raw_safetystock: { part_no: ['IMAF_T', 'IMAF001'], qty: ['IMAF_T', 'IMAF026'], uom: ['IMAF_T', 'IMAF053'] },
    raw_special_supply: { part_no: ['SFAA_T', 'SFAA010'], qty: ['SFAA_T', 'SUM(SFAA012-SFAA050)'] },
    raw_substitute: {
        bmea001: ['BMEA_T', 'BMEA001'], bmea003: ['BMEA_T', 'BMEA003'], bmea008: ['BMEA_T', 'BMEA008'],
        bmea011: ['BMEA_T', 'BMEA011'], bmea012: ['BMEA_T', 'BMEA012'], bmea016: ['BMEA_T', 'BMEA016'],
        bmea007: ['BMEA_T', 'BMEA007'], bmea015: ['BMEA_T', 'BMEA015'],
    },
    raw_outsourcing_type: {
        part_no: ['IMAA_T', 'IMAA001'], outsource_type: ['OOCQL_T', 'OOCQL004'], material: ['IMAA_T', 'IMAA130'],
    },
};

for (const [table, fields] of Object.entries(SOURCE_META)) {
    for (const column of RAW_SCHEMA[table] || []) {
        const meta = fields[column.name];
        if (meta) [column.sourceTable, column.sourceField] = meta;
        else if (column.name === 'site') [column.sourceTable, column.sourceField] = ['请求参数', 'site'];
        else if (column.name === 'pulled_at') [column.sourceTable, column.sourceField] = ['本地生成', 'new Date()'];
    }
}

/** 中文 label → 物理列名（用于把页面查询条件转 SQL WHERE） */
export const LABEL_TO_COL_BY_TABLE: Record<string, Record<string, string>> = (() => {
    const out: Record<string, Record<string, string>> = {};
    for (const [tbl, cols] of Object.entries(RAW_SCHEMA)) {
        out[tbl] = {};
        for (const c of cols) out[tbl][c.label] = c.name;
    }
    return out;
})();
