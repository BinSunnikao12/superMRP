# -*- coding: utf-8 -*-
"""
APS（高级计划与排程）MRP 主入口
====================================

整个项目是一个集团的 MRP（物料需求计划）运算系统：
  - 入口：依次为 5 个基地（LG 乐歌 / YN 越南 / QU 衢州 / GX 广西 / FN 扶南）跑一次 `excel.f(site)`
  - excel 模块负责：调用 compute 计算 → 生成多 Sheet 的 Excel 报告 → 把结果回写到 MySQL
  - compute 模块负责：递归展开 BOM 树、计算净需求、提前期、扣减库存/在制/采购在途/GD01工单
  - data 模块负责：从 Oracle 拉主数据、从 MySQL 拉配置和节日、从低代码平台拉业务备注

对应 Node.js 复刻版路径见 `../nodejs_ts/` 目录，逻辑与本文件完全一致。

使用方式（项目根目录）：
    cd python && python main.py
    # 或：
    PYTHONPATH=python python -m main
"""
from python.excel import excel

# 依次为每个基地生成一份 MRP 报告
excel.f("LG")
excel.f("YN")
excel.f("QU")
excel.f("GX")
excel.f("FN")
