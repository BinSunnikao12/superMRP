# Python SQL 与本地 MySQL 同步设计

## 目标

以 `goals/aps/python/data/data_oracle.py` 为业务查询基线。`raw_base` 继续使用独立的断点增量脚本；其他 Oracle 数据通过 LowCode ApiEngine 分页返回，再写入本地 MySQL 的 `raw_*` 表。

## 运行模式

- 全量模式：拉完每个接口的所有分页。记录第一页总数，分页期间若总数变化，或最终拉取行数与总数不同，则本批次失败并删除本批新增数据，保留上一批完整快照。
- 快速模式：每个基地、每张 MySQL 表最多保留 1000 条。`raw_need` 的工单和销售订单各分配 500 条，`raw_items` 的中越文各分配 500 条。快速模式用于页面、字段和计算联调，不要求与源端总数一致。
- 同一基地使用 MySQL advisory lock 互斥，避免全量、快速或两个终端同时同步造成快照交叉写入。

## 数据映射

Python 的 BOM、工单需求、销售订单、库存、在制、在途、工单供给、采购信息、在验、安全库存、替代料、外购类型、特殊工单供给、GD 工单与 GD BOM 均有独立任务。共享表使用作用域字段清理：`raw_need.source` 区分 `sf/xmdd`，`raw_items.lang` 区分 `zh_CN/vi_VN`。

新增 `raw_special_supply`；为 `raw_need`、`raw_cj`、`raw_production_supply`、`raw_safetystock`、`raw_gd_bom` 补充 Python 实际返回字段。同步启动时检查并增量补列，兼容已经创建的本地数据库。

## 失败处理

每个任务先写新批次，成功校验后才删除旧批次。接口失败、总数漂移、行数不一致或分页超过上限都会回滚本批数据并记录 `pull_log=failed`。快速样本会替换对应旧快照，因此不能与全量任务并发运行。
