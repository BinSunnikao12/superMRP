-- =====================================================================
-- APS MRP 本地数据库初始化脚本
-- 容器首次启动时自动执行（docker-entrypoint-initdb.d/）
-- 重要：本文件只使用 ASCII 字符（避免容器以 latin1 读取 UTF-8 中文注释/列名时乱码）
-- 中文列名 → 物理列名 的映射见 src/data/dataMysql.ts 的 columns 数组
-- =====================================================================

CREATE DATABASE IF NOT EXISTS mrp DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mrp;

-- ---------------------------------------------------------------------
-- mrp 物料需求主表（每条 BOM 展开行）
-- 列名使用拼音首字母 / 英文别名，避免中文字段名
-- 物理列名 ↔ APS dict key 映射在 src/data/dataMysql.ts columns 数组里
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mrp (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  plan_start_date        VARCHAR(32),       -- 预计开工日期
  plan_end_date          VARCHAR(32),       -- 预计完工日期
  customer_order_no      VARCHAR(64),       -- 客户订单号
  finished_work_order    VARCHAR(64),       -- 成品工单号
  finished_wo_status     VARCHAR(32),       -- 成品工单状态
  parent_track_no        VARCHAR(64),       -- 父跟单码
  track_no               VARCHAR(128),      -- 跟单码
  main_part              VARCHAR(64),       -- 主件
  main_part_name         VARCHAR(128),      -- 主件料名
  main_part_spec         VARCHAR(128),      -- 主件规格
  main_cost_center       VARCHAR(64),       -- 主件成本中心
  sub_part               VARCHAR(64),       -- 下阶
  sub_part_name          VARCHAR(128),      -- 下阶料名
  sub_part_spec          VARCHAR(128),      -- 下阶规格
  sub_cost_center        VARCHAR(64),       -- 下阶成本中心
  bom_qty                DECIMAL(20,6),     -- BOM用量
  gross_demand           DECIMAL(20,6),     -- 毛需求
  total_stock            DECIMAL(20,6),     -- 总库存
  total_wip              DECIMAL(20,6),     -- 总在制
  total_in_transit       DECIMAL(20,6),     -- 总采购在途
  total_wo_supply        DECIMAL(20,6),     -- 总工单供给
  total_inspecting       DECIMAL(20,6),     -- 总在验
  avail_stock            DECIMAL(20,6),     -- 可用库存
  avail_wip              DECIMAL(20,6),     -- 可用在制
  net_demand             DECIMAL(20,6),     -- 净需求
  total_shortage         DECIMAL(20,6),     -- 合计欠料
  supply_strategy        VARCHAR(16),       -- 补给策略
  planner                VARCHAR(64),       -- 计划员
  buyer                  VARCHAR(64),       -- 采购物控人员
  recent_supplier        VARCHAR(128),      -- 最近采购供应商
  recent_supplier_code   VARCHAR(64),       -- 最近采购供应商编码
  po_batch_qty           DECIMAL(20,6),     -- 采购单位批量
  po_min_qty             DECIMAL(20,6),     -- 最小采购数量
  po_uom                 VARCHAR(16),       -- 采购单位
  mo_batch_qty           DECIMAL(20,6),     -- 生产单位批量
  mo_min_qty             DECIMAL(20,6),     -- 最小生产数量
  mo_uom                 VARCHAR(16),       -- 生产单位
  prod_loss_rate         DECIMAL(10,4),     -- 生产损耗率
  fixed_lead_time        VARCHAR(16),       -- 固定生产前置时间 (APS 端可填 "-" 占位)
  variable_lead_time     VARCHAR(16),       -- 变动生产前置时间
  qc_lead_time           VARCHAR(16),       -- QC前置时间
  accum_lead_time        VARCHAR(16),       -- 累计前置时间
  source_order           VARCHAR(64),       -- 来源单号
  demand_calc_method     VARCHAR(32),       -- 需求计算方式
  kit_qty                DECIMAL(20,6),     -- 齐套数
  vn_main_name           VARCHAR(128),      -- 越南主件料名
  vn_main_spec           VARCHAR(128),      -- 越南主件规格
  vn_sub_name            VARCHAR(128),      -- 越南下阶料名
  vn_sub_spec            VARCHAR(128),      -- 越南下阶规格
  version                VARCHAR(32),       -- version
  site                   VARCHAR(8),        -- site
  used_stock             DECIMAL(20,6),     -- 使用库存
  doc_lead_time          VARCHAR(16),       -- 文件前置时间
  man_hours              DECIMAL(20,6),     -- 人工工时
  min_po_lead_time       VARCHAR(16),       -- 最短采购前置时间
  arrival_lead_time      VARCHAR(16),       -- 到厂前置时间
  cost_center_set        VARCHAR(256),      -- 成本中心集
  delivery_lead_time     VARCHAR(16),       -- 交货前置时间
  storage_lead_time      VARCHAR(16),       -- 入库前置时间
  main_uom               VARCHAR(16),       -- 主件单位
  sub_uom                VARCHAR(16),       -- 下阶单位
  sub_cc_code            VARCHAR(16),       -- 下阶成本中心编码
  promise_delivery       VARCHAR(128),      -- 承诺交期
  purchase_reply         VARCHAR(256),      -- 采购回复
  KEY idx_site_version (site, version),
  KEY idx_track_no (track_no),
  KEY idx_sub_part (sub_part),
  KEY idx_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- zj_data 生产需求汇总
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zj_data (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site                   VARCHAR(8),
  version                VARCHAR(32),
  kit_total              DECIMAL(20,6),     -- 齐套数总和
  plan_end_date          VARCHAR(32),       -- 预计完工日期
  total_wo_supply        DECIMAL(20,6),     -- 总工单供给
  wo_supply              DECIMAL(20,6),     -- 工单供给
  net_demand_total       DECIMAL(20,6),     -- 净需求总和
  man_hours              DECIMAL(20,6),     -- 人工工时
  sub_part_spec          VARCHAR(128),      -- 下阶规格
  sub_part_name          VARCHAR(128),      -- 下阶料名
  sub_cost_center        VARCHAR(64),       -- 下阶成本中心
  sub_part               VARCHAR(64),       -- 下阶
  track_no               VARCHAR(256),      -- 跟单码
  sub_cc_code            VARCHAR(16),       -- 下阶成本中心编码
  spray_part_name        VARCHAR(128),      -- 喷涂料名
  main_cost_center       VARCHAR(64),       -- 主件成本中心
  KEY idx_site_version (site, version),
  KEY idx_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- cg_data 采购需求明细
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cg_data (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  site                   VARCHAR(8),
  version                VARCHAR(32),
  require_arrive_date    VARCHAR(32),       -- 要求到货日期
  sub_part               VARCHAR(64),       -- 下阶
  sub_part_name          VARCHAR(128),      -- 下阶料名
  sub_part_spec          VARCHAR(128),      -- 下阶规格
  demand                 DECIMAL(20,6),     -- 需求
  total_in_transit       DECIMAL(20,6),     -- 总采购在途
  total_stock            DECIMAL(20,6),     -- 总库存
  total_wip              DECIMAL(20,6),     -- 总在制
  total_inspecting       DECIMAL(20,6),     -- 总在验
  pending_pr_qty         DECIMAL(20,6),     -- 未处理请购数
  buyer                  VARCHAR(64),       -- 采购物控人员
  track_no               VARCHAR(128),      -- 跟单码
  po_no                  VARCHAR(64),       -- 采购单
  po_doc_date            VARCHAR(32),       -- 单据日期
  po_require_date        VARCHAR(32),       -- 采购单要求交期
  pr_create_date         VARCHAR(128),      -- 请购创建日期
  supplier               VARCHAR(128),      -- 供应商
  outsource_type         VARCHAR(64),       -- 外购类型
  customer_order_no      VARCHAR(64),       -- 客户订单号
  company_model          VARCHAR(128),      -- 公司型号
  customer_model         VARCHAR(128),      -- 客户型号
  KEY idx_site_version (site, version),
  KEY idx_version (version),
  KEY idx_sub_part (sub_part)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- mrp_version 当前每个基地的最新版本号
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mrp_version (
  site VARCHAR(8) PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- leadtime_conf 提前期配置
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leadtime_conf (
  id INT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  cost_center VARCHAR(16) NOT NULL,
  cost_center_name VARCHAR(64),
  days INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_site_cc (site, cost_center)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO leadtime_conf (site, cost_center, cost_center_name, days) VALUES
  ('LG', '1069', 'Welding Workshop Loctek', 3),
  ('LG', '2001', 'Final Assembly 1', 2);

-- ---------------------------------------------------------------------
-- holiday 节假日
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holiday (
  id INT AUTO_INCREMENT PRIMARY KEY,
  site VARCHAR(8) NOT NULL,
  startday DATE NOT NULL,
  endday DATE NOT NULL,
  UNIQUE KEY uk_site_date (site, startday, endday)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO holiday (site, startday, endday) VALUES
  ('LG', '2026-10-01', '2026-10-07'),
  ('YN', '2026-09-02', '2026-09-04');

-- ---------------------------------------------------------------------
-- pull_state：增量同步状态（每基地每接口一行）
-- last_successful_time：上次成功拉取时间，下次拉取 WHERE > 这个时间
-- 默认 '1900-01-01 00:00:00' = 拉全量
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pull_state (
  site VARCHAR(8) NOT NULL,
  api_key VARCHAR(64) NOT NULL,
  last_successful_time DATETIME NOT NULL DEFAULT '1900-01-01 00:00:00',
  last_total_rows INT,
  last_duration_ms INT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (site, api_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- raw_base 长任务断点：每站点顺序分页，每页成功后推进 last_completed_page
CREATE TABLE IF NOT EXISTS raw_base_pull_checkpoint (
  site VARCHAR(8) NOT NULL,
  api_key VARCHAR(64) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  last_pull_time DATETIME NOT NULL,
  upper_pull_time DATETIME NOT NULL,
  batch_size INT NOT NULL,
  total_rows INT NOT NULL,
  total_pages INT NOT NULL,
  last_completed_page INT NOT NULL DEFAULT 0,
  pulled_rows INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  error TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (site, api_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
