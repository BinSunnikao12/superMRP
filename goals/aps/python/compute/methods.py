# -*- coding: utf-8 -*-
"""
compute.methods：BOM 展开工具方法
==================================

- compare_data: 比较两个 BOM 行的 (主件, 下阶, QPA) 三元组是否一致（用于判断 GD 替代 BOM 是否与标准 BOM 实质等价）
- demand:      从 stock 三层扣减需求（库存 → 在制 → GD01 工单），返回 (剩余需求, 扣后余额)
- xxxx:        展开单层 BOM：对 bom 里的每个下阶行 jj 构造一条记录，递归调 aaa
"""
import copy
from math import inf
import math


def compare_data(data1, data2):
    """
    比较两个 BOM 列表是否"结构等价"：按 (主件, 下阶, QPA) 排序后逐项比对。
    用于 GD 替代 BOM：若与标准 BOM 等价就直接走标准 BOM，不重复展开。
    """
    keys = ['主件', '下阶', 'QPA']
    sorted_data1 = sorted(data1, key=lambda x: tuple(x[key] for key in keys))
    sorted_data2 = sorted(data2, key=lambda x: tuple(x[key] for key in keys))
    return all(all(dict1[key] == dict2[key] for key in keys) for dict1, dict2 in zip(sorted_data1, sorted_data2))


def demand(warehouses, needs):
    """
    三层库存扣减：
      warehouses = {"可用库存": x1, "可用在制": x2, "GD01可用工单数": x3}
      按 库存 → 在制 → GD01 顺序扣 needs
    :return: (剩余需求, 扣后余额 dict)
    """
    for warehouse, stock in warehouses.items():
        if stock >= needs:
            warehouses[warehouse] = stock - needs
            needs = 0
            break
        else:
            warehouses[warehouse] = 0
            needs -= stock
    return (max(0, needs), warehouses)  # 净需求不会为负


def xxxx(bom, n, m, s):
    """
    把 BOM 列表 bom 展开一层：
      - 对每条 BOM 行 jj 复制一份
      - 跟单码 = m 的跟单码 + "." + 项次（用 . 区分层级）
      - 主件继承 m 的主件（虚拟件场景）
      - BOM 用量 = QPA × m 的 BOM 用量（虚拟件继承父量）
      - 调 s.remain_operation 扣库存 + 算前置时间
      - 如果是 非外购 + 净需求 > 0 → 继续 aaa 递归

    :param bom: list[dict] BOM 行
    :param n: 父级净需求
    :param m: 父级 dict（含 跟单码 / 预计开工日期 / 父跟单码 ...）
    :param s: serve 实例（带所有主数据 + 业务状态）
    """
    for i, j in enumerate(bom):
        jj = copy.copy(j)
        # 虚拟件 (X) → 父跟单码继承自 m 的父跟单码
        jj["父跟单码"] = m["父跟单码"] if jj["主件类别"] == "X" else m["跟单码"]
        jj["跟单码"] = m["跟单码"] + "." + str(j["项次"])
        jj["总装车间"] = m.get("总装车间")
        remark = s.remark.get(jj["跟单码"])
        jj["采购回复"] = remark[1] if remark != None else ""
        jj["承诺交期"] = remark[2] if remark != None else ""
        jj["主件"] = m["主件"] if jj["主件类别"] == "X" else jj["主件"]
        # 虚拟件：用父级的 BOM 用量 × 当前 QPA；否则直接用 QPA
        jj["BOM用量"] = jj["QPA"] * m["BOM用量"] if jj["主件类别"] == "X" else jj["QPA"]
        base = s.base_dict[jj["下阶"]]
        main_base = s.base_dict[jj["主件"]]
        jj["主件单位"] = m["下阶单位"]
        jj["下阶单位"] = jj["发料单位"]
        # 主件级 5 个采购前置时间
        jj["文件前置时间"] = main_base["IMAF171"]
        jj["交货前置时间"] = main_base["IMAF172"]
        jj["到厂前置时间"] = main_base["IMAF173"]
        jj["入库前置时间"] = main_base["IMAF174"]
        jj["最短采购前置时间"] = main_base["IMAF175"]
        # 主件级 4 个生产前置时间
        jj["固定生产前置时间"] = main_base["IMAE071"]
        jj["变动生产前置时间"] = main_base["IMAE072"]
        jj["QC前置时间"] = main_base["IMAE074"]
        jj["累计前置时间"] = main_base["IMAE075"]
        jj["生产损耗率"] = base["IMAE015"] if base["IMAE015"] is not None else 0

        jj["毛需求"] = jj["BOM用量"] * n
        # 继承父级的订单信息
        jj["客户订单号"] = m["客户订单号"]
        jj["总装锁定日期"] = m["总装锁定日期"]
        jj["立柱锁定日期"] = m["立柱锁定日期"]
        jj["来源单号"] = m["来源单号"]
        jj["成品工单号"] = m["成品工单号"]
        jj["成品工单状态"] = m["成品工单状态"]
        s.remain_operation(jj, m["预计开工日期"],
                            (m.get("成本中心集") if m.get("成本中心集") is not None else ""))
        jj["齐套数"] = float(inf)
        # 按 IMAE017（生产单位批量）向上取整 + 损耗率
        jj["净需求"] = math.ceil(jj["净需求"] * (1 + jj["生产损耗率"] / 100) / base["IMAE017"]) * base["IMAE017"] \
            if base["IMAE017"] else jj["净需求"] * (1 + jj["生产损耗率"] / 100)

        # 齐套数：父子取 min（看"实际能用库存"够生产多少个 BOM 套数）
        if m.get("齐套数", float(inf)) > jj["使用库存"]:
            m["齐套数"] = jj["使用库存"] / jj["BOM用量"]

        # 成本中心集：非虚拟件 累加主件成本中心
        if jj["下阶类别"] != "X":
            jj["成本中心集"] = (m.get("成本中心集") if m.get("成本中心集") is not None else "") + "," + (
                jj.get("主件成本中心") if (jj.get("主件成本中心") is not None) else "")
        else:
            jj["成本中心集"] = (m.get("成本中心集") if m.get("成本中心集") is not None else "")

        if jj["下阶类别"] != "X":
            s.l.append(jj)
        # 自制/委外 且 净需求 > 0 → 继续展开
        if (base["IMAF013"] != '1' or jj["下阶类别"] == "X") and jj["净需求"] > 0:
            s.aaa(jj)
