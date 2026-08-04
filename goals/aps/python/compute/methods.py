import copy
import math
from math import inf


def compare_data(data1, data2):
    keys = ['主件', '下阶', 'QPA']

    # 对数据进行排序
    sorted_data1 = sorted(data1, key=lambda x: tuple(x[key] for key in keys))
    sorted_data2 = sorted(data2, key=lambda x: tuple(x[key] for key in keys))

    # 比较排序后数据中主件、下阶和QPA的值是否一致
    return all(all(dict1[key] == dict2[key] for key in keys) for dict1, dict2 in zip(sorted_data1, sorted_data2))

def demand( warehouses, needs):
    # 遍历每个仓库
    for warehouse, stock in warehouses.items():
        # 如果仓库库存足够
        if stock >= needs:
            warehouses[warehouse] = stock - needs
            needs = 0
            break
        else:
            warehouses[warehouse] = 0
            needs -= stock
    return (max(0, needs), warehouses)  # max把负需求调整净需求为0

def xxxx(bom,n,m,s):
    for i, j in enumerate(bom):
        jj = copy.copy(j)
        jj["父跟单码"] = m["父跟单码"] if jj["主件类别"] == "X" else m["跟单码"]  # 如果BOM的主件类别是虚拟件，则父跟单码取上一层的父跟单码
        jj["跟单码"] = m["跟单码"] + "." + str(j["项次"])
        jj["总装车间"]=m.get("总装车间")
        remark=s.remark.get(jj["跟单码"])
        jj["采购回复"] = remark[1] if remark !=None else ""
        jj["承诺交期"] = remark[2] if remark !=None else ""
        jj["主件"] = m["主件"] if jj["主件类别"] == "X" else jj["主件"]
        jj["BOM用量"] = jj["QPA"] * m["BOM用量"] if jj["主件类别"] == "X" else jj["QPA"]
        base = s.base_dict[jj["下阶"]]
        main_base = s.base_dict[jj["主件"]]
        jj["主件单位"]=m["下阶单位"]
        jj["下阶单位"]=jj["发料单位"]
        jj["文件前置时间"] = main_base["IMAF171"]
        jj["交货前置时间"] = main_base["IMAF172"]
        jj["到厂前置时间"] = main_base["IMAF173"]
        jj["入库前置时间"] = main_base["IMAF174"]
        jj["最短采购前置时间"] = main_base["IMAF175"]
        jj["固定生产前置时间"] = main_base["IMAE071"]
        jj["变动生产前置时间"] = main_base["IMAE072"]
        jj["QC前置时间"] = main_base["IMAE074"]
        jj["累计前置时间"] = main_base["IMAE075"]
        jj["生产损耗率"] = base["IMAE015"] if base["IMAE015"] is not None else 0

        jj["毛需求"] = jj["BOM用量"] * n
        jj["客户订单号"] = m["客户订单号"]
        jj["总装锁定日期"] = m["总装锁定日期"]
        jj["立柱锁定日期"] = m["立柱锁定日期"]
        jj["来源单号"] = m["来源单号"]
        jj["成品工单号"] = m["成品工单号"]
        jj["成品工单状态"] = m["成品工单状态"]
        s.remain_operation(jj, m["预计开工日期"], (m.get("成本中心集") if m.get("成本中心集") is not None else ""))
        jj["齐套数"] = float(inf)
        jj["净需求"] = math.ceil(jj["净需求"] * (1 + jj["生产损耗率"] / 100) / base["IMAE017"]) * base["IMAE017"] if base[
            "IMAE017"] else jj["净需求"] * (1 + jj["生产损耗率"] / 100)

        if m.get("齐套数", float(inf)) > jj["使用库存"]:
            m["齐套数"] = jj["使用库存"] / jj["BOM用量"]

        if jj["下阶类别"] != "X":
            jj["成本中心集"] = (m.get("成本中心集") if m.get("成本中心集") is not None else "") + "," + (
                jj.get("主件成本中心") if (jj.get("主件成本中心") is not None) else "")
        else:
            jj["成本中心集"] = (m.get("成本中心集") if m.get("成本中心集") is not None else "")

        if jj["下阶类别"] != "X":
            s.l.append(jj)
        if (base["IMAF013"] != '1' or jj["下阶类别"] == "X") and jj["净需求"] > 0:
            s.aaa(jj)
