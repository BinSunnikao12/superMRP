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
}

/**
 * 每张 raw_* 表的列信息（按页面显示顺序）
 * 注：label 多数已对照 dzebl_t 字典表
 */
export const RAW_SCHEMA: Record<string, ColumnInfo[]> = {
    raw_base: [
        { name: 'site', label: '据点' },
        { name: 'part_no', label: '料件编号' },
        { name: 'supply_strategy', label: '补给策略', type: '1=外购/2=自制/3=委外' },
        { name: 'demand_calc_method', label: '需求计算方法' },
        { name: 'safety_stock', label: '安全库存量', type: 'DECIMAL' },
        { name: 'po_uom', label: '采购单位' },
        { name: 'po_batch_qty', label: '采购批量', type: 'DECIMAL' },
        { name: 'po_min_qty', label: '最小采购量', type: 'DECIMAL' },
        { name: 'is_module', label: '是否模块化', type: 'Y/N' },
        { name: 'buyer_code', label: '采购人员' },
        { name: 'mat_ctrl_code', label: '物控人员' },
        { name: 'planner', label: '计划员' },
        { name: 'prod_loss_rate', label: '生产损耗率', type: 'DECIMAL' },
        { name: 'mo_uom', label: '生产单位' },
        { name: 'mo_batch_qty', label: '生产批量', type: 'DECIMAL' },
        { name: 'mo_min_qty', label: '最小生产量', type: 'DECIMAL' },
        { name: 'std_man_hour', label: '标准人工工时', type: 'DECIMAL' },
        { name: 'doc_lt', label: '文件前置时间', type: 'DECIMAL(天)' },
        { name: 'delivery_lt', label: '交货前置时间', type: 'DECIMAL(天)' },
        { name: 'arrival_lt', label: '到厂前置时间', type: 'DECIMAL(天)' },
        { name: 'storage_lt', label: '入库前置时间', type: 'DECIMAL(天)' },
        { name: 'fixed_lt', label: '固定生产前置时间', type: 'DECIMAL(天)' },
        { name: 'variable_lt', label: '变动生产前置时间', type: 'DECIMAL(天)' },
        { name: 'qc_lt', label: 'QC前置时间', type: 'DECIMAL(天)' },
        { name: 'accum_lt', label: '累计前置时间', type: 'DECIMAL(天)' },
        { name: 'default_cc', label: '默认成本中心' },
        { name: 'cc_name', label: '成本中心名称' },
        { name: 'has_purchased', label: '是否采购过', type: 'Y/N' },
        { name: 'has_self_made', label: '是否自制过', type: 'Y/N' },
        { name: 'rd_purchased', label: '研发采购过', type: 'Y/N' },
        { name: 'rd_self_made', label: '研发自制过', type: 'Y/N' },
        { name: 'pulled_at', label: '拉取时间' },
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
        { name: 'pulled_at', label: '拉取时间' },
    ],
};

/** 中文 label → 物理列名（用于把页面查询条件转 SQL WHERE） */
export const LABEL_TO_COL_BY_TABLE: Record<string, Record<string, string>> = (() => {
    const out: Record<string, Record<string, string>> = {};
    for (const [tbl, cols] of Object.entries(RAW_SCHEMA)) {
        out[tbl] = {};
        for (const c of cols) out[tbl][c.label] = c.name;
    }
    return out;
})();
