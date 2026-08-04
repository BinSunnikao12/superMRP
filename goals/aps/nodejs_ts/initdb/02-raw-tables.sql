-- =====================================================================
-- APS MRP Stage 1 (pull phase) raw data tables
-- Columns use ASCII English aliases; APS maps label→ascii col when inserting.
-- This avoids MySQL latin1 mis-decoding of UTF-8 comments/labels.
-- =====================================================================
USE mrp;

-- ---------------------------------------------------------------------
-- Pull log: each (site, api_key) one row, with start/end/duration
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pull_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  api_key VARCHAR(64) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3),
  duration_ms INT,
  page_count INT,
  total_rows INT,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  error TEXT,
  KEY idx_site_api (site, api_key),
  KEY idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_base: tiptop_query_imaf_t
-- label cols: 料件编号 补给策略 需求计算方法 安全库存量 采购单位 采购单位批量
--             最小采购数量 是否模块化 采购员 物控人员 采购文档前置时间 采购交货前置时间
--             采购到厂前置时间 采购入库前置时间 严守交期前置时间 计划员 生产损耗率
--             生产单位 生产单位批量 最小生产数量 标准人工工时 固定生产前置时间
--             变动生产前置时间 QC前置时间 累计前置时间 是否采购过 是否自制过
--             研发是否采购过 研发是否自制过 默认成本中心 成本中心名称
CREATE TABLE IF NOT EXISTS raw_base (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  supply_strategy VARCHAR(16),
  demand_calc_method VARCHAR(32),
  safety_stock DECIMAL(20,6),
  po_uom VARCHAR(16),
  po_batch_qty DECIMAL(20,6),
  po_min_qty DECIMAL(20,6),
  is_module VARCHAR(8),
  buyer_code VARCHAR(64),
  mat_ctrl_code VARCHAR(64),
  doc_lt DECIMAL(20,6),
  delivery_lt DECIMAL(20,6),
  arrival_lt DECIMAL(20,6),
  storage_lt DECIMAL(20,6),
  strict_delivery_lt DECIMAL(20,6),
  planner VARCHAR(64),
  prod_loss_rate DECIMAL(10,4),
  mo_uom VARCHAR(16),
  mo_batch_qty DECIMAL(20,6),
  mo_min_qty DECIMAL(20,6),
  std_man_hour DECIMAL(20,6),
  fixed_lt DECIMAL(20,6),
  variable_lt DECIMAL(20,6),
  qc_lt DECIMAL(20,6),
  accum_lt DECIMAL(20,6),
  has_purchased VARCHAR(8),
  has_self_made VARCHAR(8),
  rd_purchased VARCHAR(8),
  rd_self_made VARCHAR(8),
  default_cc VARCHAR(32),
  cc_name VARCHAR(64),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_bom: tiptop_query_bom
-- label cols: 主件 元件料号 用量 主件类别 元件类别 发料单位 项次
CREATE TABLE IF NOT EXISTS raw_bom (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  main_part VARCHAR(64),
  sub_part VARCHAR(64),
  qty DECIMAL(20,6),
  main_type VARCHAR(8),
  sub_type VARCHAR(8),
  issue_uom VARCHAR(16),
  seq VARCHAR(32),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_main_part (main_part)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_need: tiptop_query_sfaa_t + tiptop_query_xmdd_t
-- sfaa label cols: 工单单号 预计开工日期 工单状态 预计完工日期 主件料号 主件需求数量 来源单号
--                   SFAAUD002 OOAG011 SFAAUA002 SFAAUA003
-- xmdd label cols: 销售订单号 订单项次 预计开工日期 主件料号 可交货数量 XMDD006 XMDD014
--                   XMDD016 XMDA002 OOAG011 DOCDT
-- We unify into one raw_need table; source='sf' or 'xmdd'
CREATE TABLE IF NOT EXISTS raw_need (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'sf',
  doc_no VARCHAR(64),
  sfbaseq VARCHAR(16),
  plan_start DATETIME,
  status VARCHAR(32),
  plan_end DATETIME,
  main_part VARCHAR(64),
  qty DECIMAL(20,6),
  src_doc VARCHAR(64),
  sfaaud002 VARCHAR(64),
  ooag011 VARCHAR(64),
  sfaaua002 VARCHAR(32),
  sfaaua003 VARCHAR(32),
  docdt DATETIME,
  customer VARCHAR(128),
  sfba006 VARCHAR(64),
  qpa_num DECIMAL(20,6),
  qpa_den DECIMAL(20,6),
  sfba014 VARCHAR(16),
  package_pending VARCHAR(32),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_remain: tiptop_query_inag_t
-- label cols: 料号 现有数量
CREATE TABLE IF NOT EXISTS raw_remain (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  imafsite VARCHAR(16),                   -- IMAF_T 原始 imafsite（ALL/LG/YN/QU/FN/GX）
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_part_no (part_no),
  UNIQUE KEY uk_site_part_imafsite (site, part_no, imafsite)  -- UPSERT 唯一键
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_cj: tiptop_query_sfba_t (in WIP)
-- raw cols: SFBA006 QPA分子 QPA分母 SFBA013 SFBA014 SFBADOCNO
CREATE TABLE IF NOT EXISTS raw_cj (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  sfba006 VARCHAR(64),
  qpa_num DECIMAL(20,6),
  qpa_den DECIMAL(20,6),
  sfba013 DECIMAL(20,6),
  sfba014 VARCHAR(16),
  sfbadocno VARCHAR(64),
  part_no VARCHAR(64),
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_in_transit: tiptop_query_in_transit
-- label cols: 料号 在途数量
CREATE TABLE IF NOT EXISTS raw_in_transit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_purchase_order: tiptop_query_purchase_order
-- raw cols: PMDO001 ZTNUM ZTNUM2 PMDL004 PMAAL003 CGD CGD2 PMDLDOCDT PMDO013 CJRQ PMDLSTUS OOAG011 客户型号 公司型号
CREATE TABLE IF NOT EXISTS raw_purchase_order (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  pmdo001 VARCHAR(64),
  ztnum DECIMAL(20,6),
  ztnum2 DECIMAL(20,6),
  pmdl004 VARCHAR(64),
  pmaal003 VARCHAR(128),
  cgd VARCHAR(128),
  cgd2 VARCHAR(128),
  pmdldocdt DATETIME,
  pmdo013 DATETIME,
  cjrq VARCHAR(128),
  pmdlstus VARCHAR(8),
  ooag011 VARCHAR(64),
  customer_model VARCHAR(128),
  company_model VARCHAR(128),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_pmdo001 (pmdo001)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_buyer: tiptop_query_pmdn_t
-- raw cols: 料号 采购员 供应商 供应商编码
CREATE TABLE IF NOT EXISTS raw_buyer (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  buyer VARCHAR(64),
  supplier VARCHAR(128),
  supplier_code VARCHAR(64),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_part_no (part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_testfunc: tiptop_query_pmdt_t (in inspection)
-- raw cols: 在验料号 在验量
CREATE TABLE IF NOT EXISTS raw_testfunc (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_production_supply: tiptop_query_sfac_t
-- raw cols: SFAC001 SFAC003 SFAC005
CREATE TABLE IF NOT EXISTS raw_production_supply (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  issued DECIMAL(20,6),
  received DECIMAL(20,6),
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_part_no (part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_items: tiptop_query_imaal_t
-- raw cols: IMAAL001 IMAAL003 IMAAL004
CREATE TABLE IF NOT EXISTS raw_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  lang VARCHAR(16) NOT NULL DEFAULT 'zh_CN',
  part_no VARCHAR(64),
  name VARCHAR(128),
  spec VARCHAR(128),
  KEY idx_site_lang (site, lang, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_safetystock: tiptop_query_imaf_t (where IMAF026>0)
-- raw cols: IMAF001 IMAF026
CREATE TABLE IF NOT EXISTS raw_safetystock (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  qty DECIMAL(20,6),
  uom VARCHAR(16),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_substitute: tiptop_query_bmea_t
-- raw cols: BMEA001 BMEA003 BMEA008 BMEA011 BMEA012 BMEA016 BMEA007 BMEA015
CREATE TABLE IF NOT EXISTS raw_substitute (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  bmea001 VARCHAR(64),
  bmea003 VARCHAR(64),
  bmea008 VARCHAR(128),
  bmea011 VARCHAR(64),
  bmea012 VARCHAR(128),
  bmea016 DECIMAL(20,6),
  bmea007 VARCHAR(128),
  bmea015 DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_bmea001 (bmea001)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_outsourcing_type: tiptop_query_imaa_oocql
-- raw cols: IMAA001 OOCQL004 IMAA130
CREATE TABLE IF NOT EXISTS raw_outsourcing_type (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  outsource_type VARCHAR(64),
  material VARCHAR(64),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_gd01: tiptop_query_gd01
-- label cols: 主件 GD01数量
CREATE TABLE IF NOT EXISTS raw_gd01 (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_gd_bom: tiptop_query_gd_bom
-- label cols: 工单号 主件料号 未交量
CREATE TABLE IF NOT EXISTS raw_gd_bom (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  doc_no VARCHAR(64),
  main_part VARCHAR(64),
  qty DECIMAL(20,6),
  sub_part VARCHAR(64),
  qpa DECIMAL(20,10),
  issue_uom VARCHAR(16),
  seq VARCHAR(32),
  KEY idx_site_pulled (site, pulled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_special_supply: Python get_special_supply()
CREATE TABLE IF NOT EXISTS raw_special_supply (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  pulled_at DATETIME(3) NOT NULL,
  part_no VARCHAR(64),
  qty DECIMAL(20,6),
  KEY idx_site_pulled (site, pulled_at),
  KEY idx_part_no (part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
