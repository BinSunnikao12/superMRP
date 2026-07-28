# -*- coding: utf-8 -*-
"""
compute 计算核心：MRP 物料需求运算
====================================

BOM 展开 + 净需求计算 + 库存/在制/采购在途/GD01 工单 顺序扣减。

核心数据：
  - need          原始需求（销售订单 + 工单）
  - base_dict     物料主数据（料号 → 字段字典）
  - remain_dict   现有可用库存 {料号: 数量}
  - cj_dict       现有在制（WIP）{料号: 数量}
  - gd01          现有 GD01 工单数 {料号: 数量}
  - tests_dict    在验数量
  - in_transit_dict 采购在途
  - production_supply_dict 现有工单供给（生产需求阶段用）
  - gd_bom_dict   GD 替代 BOM（按需优先消耗）
  - bom_dict      标准 BOM {主件: [下阶行, ...]}
  - substitute    替代料

输出（ser 实例属性）：
  - l: 物料需求明细（list[dict]），最终写到 Excel "物料需求" Sheet 和 mrp 表
  - r: 库存情况（list[dict]），最终写到 Excel "库存情况" Sheet
  - docdt: 销售订单接单日期
  - item_need: 每个料号累计毛需求
  - total_demand: 每个料号累计净需求
"""
import json, sys
from python.data import data_oracle, data_mysql, data_mes
import copy, datetime
import math
from math import inf
from pytz import timezone
from python.compute import methods


class serve():
    def __init__(self, site):
        # ---------- 加载主数据（来自 Oracle / MySQL / 低代码平台）----------
        self.d = data_oracle.db(site)
        self.site = site
        self.cj_dict = self.d.cjfunc()                            # 现有在制 {料号: 数量}
        self.base_dict = self.d.basefunc()                        # 物料主数据
        self.remain_dict = self.d.remainfunc()                    # 现有可用库存
        self.items_dict = self.d.itemsfunc()                      # 料号 → 料名/规格 (zh_CN)
        self.vn_items_dict = self.d.vn_itemsfunc()                # 越南文料名/规格 (vi_VN)
        self.need = self.d.needfunc()                             # 原始需求
        self.bom_dict = self.d.bomfunc()                          # 标准 BOM
        self.buyer_dict = self.d.buyerfunc()                      # 最近采购供应商 / 采购员
        # _copy 用来在最终汇总"总库存/总在制"时不被扣减态污染
        self.remain_dict_copy = copy.copy(self.remain_dict)
        self.cj_dict_copy = copy.copy(self.cj_dict)
        self.tests_dict = self.d.testfunc()                       # 在验
        self.safetystock = self.d.safetystock()                   # 安全库存补货需求
        self.in_transit_dict = self.d.in_transit()                # 采购在途
        self.production_supply_dict = self.d.production_supply()  # 现有工单供给
        self.substitutes = self.d.substitute()
        self.purchase_order_detail_dict = self.d.purchase_order_detail()  # 采购单
        self.remark = data_mes.remark()                           # 跟单码 → 采购回复/承诺交期
        self.ryjj = data_mes.ryjj()                               # 采购员交接映射
        self.outsourcing_type_dict = self.d.outsourcing_type()    # 外购类型/材质
        self.gd01 = self.d.gd01()                                 # GD01 工单数
        self.gd01_copy = copy.copy(self.gd01)
        self.gd_bom_dict = self.d.gd_bom()                        # GD 替代 BOM（按需优先消耗）
        self.leadtime_map = data_mysql.leadtime_func()            # (site, 成本中心编码) → 提前期（天）
        self.holiday = data_mysql.holiday_func(self.site)         # 节假日（开工日往前推）
        # self.unaudited_purchase_order_dict = self.d.unaudited_purchase_order()
        # self.qg_map = self.d.qg()

        # ---------- 计算中间态 ----------
        self.total_demand = {}        # 料号 → 累计净需求
        self.l = []                   # 物料需求明细
        self.r = []                   # 库存情况汇总
        self.docdt = {}               # 成品工单号 → 接单日期
        self.item_need = {}           # 料号 → 累计毛需求

    def hoilday_func(self, v):
        """
        提前期节假日修正：
          - 开工日 落在 假期区间内 → 把开工日 往前推，使完工日能落在假期结束之后
          - 工单是 LG-GD01 且 下阶成本中心编码 = 1073（喷塑） → 额外把开工日 提前 leadtime_map[LG, 1069] 天
        公式：开工日 -= (假期结束日 - 完工日) 的天数差 + 1
        """
        parse_datetime = lambda date_str: datetime.datetime.strptime(date_str, "%Y-%m-%d")
        overlap = None
        if v["下阶成本中心编码"] == '1073' and v["成品工单号"][:7] == 'LG-GD01' and "." not in v["跟单码"]:
            v["预计开工日期"] = v["预计开工日期"] - datetime.timedelta(days=self.leadtime_map[('LG', "1069")])
        for h in self.holiday:
            # 开工日早于假期结束 且 完工日晚于假期开始 → 有重叠
            if v["预计开工日期"] <= parse_datetime(h[1]) and v["预计完工日期"] >= parse_datetime(h[0]):
                overlap = h
                break
        if overlap:
            d = (parse_datetime(overlap[1]) - v["预计完工日期"]).days
            d = 0 if d < 0 else d
            num_days = ((parse_datetime(overlap[1]) - parse_datetime(overlap[0])).days) - d + 1
            v["预计开工日期"] = v["预计开工日期"] - datetime.timedelta(days=num_days)

    def remain_operation(self, v, enddate=None, c=''):
        """
        通用 库存/在制/GD01 三层扣减 + 提前期计算。
        被 sss(xxx) 和 xxxx(bom, n, m, s) 多次复用。

        关键字段计算顺序：
          1. stock = {可用库存, 可用在制, GD01可用工单数}
          2. rrrr = demand(stock, 毛需求)  → 净需求
          3. 把扣减后的余额回写到 remain_dict / cj_dict / gd01（注意：自此这些 dict 是被污染的）
          4. 累加 self.total_demand[item] 和 self.item_need[item]
          5. 计算 leadtime：
              - 优先用 leadtime_map[(site, 主件成本中心编码)]
              - LG 喷塑车间模块化物料 +1 天
              - 下阶是虚拟件 (X) → 0
          6. 预计开工日期 = 预计完工日期 - leadtime 天
          7. hoilday_func 修正节假日
          8. 把 大量业务字段（主件成本中心/计划员/采购员/外购类型/材质/前置时间/采购供应商...）写回 v
        """
        item = v["下阶"]
        if isinstance(enddate, str):
            enddate = datetime.datetime.strptime(enddate, "%Y-%m-%d")
        base = self.base_dict[item]
        main_base = self.base_dict[v["主件"]]
        remain = self.remain_dict.get(item, 0)
        cj = self.cj_dict.get(item, 0)
        gd01 = self.gd01.get(item, 0)
        stock = {"可用库存": remain, "可用在制": cj, "GD01可用工单数": gd01}
        v.update(stock)
        rrrr = methods.demand(stock, v["毛需求"])
        v["净需求"] = rrrr[0]
        # 扣减后的余额回写（注意：覆盖初始值，后续行会看到前面的消耗）
        self.remain_dict[item] = rrrr[1]["可用库存"]
        self.cj_dict[item] = rrrr[1]["可用在制"]
        self.gd01[item] = rrrr[1]["GD01可用工单数"]

        v["人工工时"] = base["IMAE051"] * v["净需求"]
        v["子件标准人工工时"] = base["IMAE051"]
        v["主件标准人工工时"] = main_base["IMAE051"]
        v["总库存"] = self.remain_dict_copy.get(item, 0)        # 取最初始的值（不被污染）
        v["总在制"] = self.cj_dict_copy.get(item, 0)
        v["GD01工单数"] = self.gd01_copy.get(item, 0)
        v["总在验"] = self.tests_dict.get(item, 0)
        v["总采购在途"] = self.in_transit_dict.get(item, 0)
        v["总工单供给"] = self.production_supply_dict.get(item, 0)
        self.total_demand[item] = self.total_demand.get(item, 0) + v["净需求"]
        v["合计欠料"] = self.total_demand.get(item, 0)
        self.item_need[item] = self.item_need.get(item, 0) + v["毛需求"]
        items_f = self.items_dict[v["主件"]]
        v["主件料名"] = items_f["IMAAL003"]
        v["主件规格"] = items_f["IMAAL004"]
        items_s = self.items_dict[item]
        v["下阶料名"] = items_s["IMAAL003"]
        v["下阶规格"] = items_s["IMAAL004"]
        v["下阶成本中心"] = base["OOEFL003"]
        v["主件成本中心"] = main_base["OOEFL003"]
        v["下阶成本中心编码"] = base["IMAE035"]
        v["主件成本中心编码"] = main_base["IMAE035"]
        v["外购类型"] = self.outsourcing_type_dict.get(item, {}).get("OOCQL004")
        v["材质"] = self.outsourcing_type_dict.get(item, {}).get("IMAA130")
        leadtime = v["固定生产前置时间"] + v["变动生产前置时间"] + v["QC前置时间"] + v["累计前置时间"]

        # 用主件成本中心编码反查提前期（业务部门维护的 leadtime_conf）
        key = (self.site, main_base["IMAE035"])
        if key in self.leadtime_map:
            n = 0
            if main_base["IMAE035"] == "1073" and main_base["IMAFUD010"] == "Y" and self.site == 'LG':
                # 乐歌喷塑车间（1073）模块化生产物料 +1 天
                n = 1
            leadtime = self.leadtime_map[key] + n if v["主件成本中心"] not in c else 0
        if v.get("下阶类别") == "X":
            # 下阶是虚拟件 → 不需要实际生产，提前期 = 0
            leadtime = 0

        if v.get("预计完工日期") == None:
            v["预计完工日期"] = enddate
        v["预计开工日期"] = enddate - datetime.timedelta(days=leadtime)

        self.hoilday_func(v)
        v["预计完工日期"] = v["预计完工日期"].strftime("%Y-%m-%d")
        v["预计开工日期"] = v["预计开工日期"].strftime("%Y-%m-%d")

        if self.site == "YN":
            vn_items_f = self.vn_items_dict.get(v["主件"])
            v["越南主件料名"] = vn_items_f.get("IMAAL003", '') if vn_items_f else ''
            v["越南主件规格"] = vn_items_f.get("IMAAL004", '') if vn_items_f else ''
            vn_items_s = self.vn_items_dict.get(item)
            v["越南下阶料名"] = vn_items_s.get("IMAAL003", '') if vn_items_s else ''
            v["越南下阶规格"] = vn_items_s.get("IMAAL004", '') if vn_items_s else ''

        v["补给策略"] = {"1": "外购", "2": "自制", '3': "委外"}.get(base["IMAF013"])
        v["计划员"] = v["下阶成本中心"]
        buyers = self.buyer_dict.get(item, {})
        b = {"LG": "张玉洪", "QU": "", "YN": "", "GX": "", "FN": ""}
        v["采购物控人员"] = buyers.get("OOAG011", b[self.site]) if base["IMAF013"] == "1" else ""
        v["最近采购供应商"] = buyers.get("PMAAL003", '')
        v["最近采购供应商编码"] = buyers.get("PMDL004", '')
        v["采购单位批量"] = base["IMAF145"]
        v["最小采购数量"] = base["IMAF146"]
        v["采购单位"] = base["IMAF143"]
        v["生产单位批量"] = base["IMAE017"]
        v["最小生产数量"] = base["IMAE018"]
        v["生产单位"] = base["IMAE016"]
        v["需求计算方式"] = {"1": "APS计算", "2": "人工计算"}.get(base["IMAF014"])
        v["使用库存"] = v["毛需求"] - v["净需求"]

    def aaa(self, m):
        """
        递归展开 BOM：处理下阶的所有下阶。
          1. 优先消耗 GD 替代 BOM（gd_bom_dict）：一组替代 BOM 按量消耗，剩余留给标准 BOM
          2. 剩余量用标准 bom（bom_dict）展开
        """
        bom = self.bom_dict.get(m["下阶"], [])
        x1 = self.gd_bom_dict.get(m["下阶"], {})
        nn = m["净需求"]

        f = 0
        for i, j in x1.items():
            bom_i = json.loads(i)
            # 每个替代 BOM 内的项次加后缀，避免冲突
            for iii in bom_i:
                iii["项次"] = iii["项次"] + "_" + str(f)
            f += 1
            if methods.compare_data(bom_i, bom) == False:
                if nn > j and j > 0:
                    # GD 替代 BOM 整批消耗
                    methods.xxxx(bom_i, j, m, self)
                    nn -= j
                    self.gd_bom_dict[m["下阶"]][i] = 0
                elif nn <= j and nn > 0:
                    # GD 替代 BOM 消耗一部分，剩余留给标准 BOM
                    methods.xxxx(bom_i, nn, m, self)
                    self.gd_bom_dict[m["下阶"]][i] = j - nn
                    nn = 0

        if nn > 0 and bom:
            methods.xxxx(bom, nn, m, self)

    def sss(self, v):
        """
        入口：处理一条"原始需求"行（来自 need 表，包括销售订单 + 工单）
          - 计算前置字段：v["采购回复"] / v["承诺交期"] / v["生产损耗率"]
          - 重置一组标准前置时间为 "-"
          - 调 remain_operation 扣库存
          - 如果下阶不是外购 且 净需求 > 0 且 不是 GD04/GD15（钣金/喷塑） → 调 aaa 递归展开
        """
        a = ["累计前置时间", "QC前置时间", "变动生产前置时间", "固定生产前置时间",
             "最短采购前置时间", "入库前置时间", "到厂前置时间", "文件前置时间", "交货前置时间"]
        base = self.base_dict[v["下阶"]]
        remark = self.remark.get(v["跟单码"])
        v["采购回复"] = remark[1] if remark != None else ""
        v["承诺交期"] = remark[2] if remark != None else ""
        v["生产损耗率"] = base["IMAE015"] if base["IMAE015"] is not None else 0
        for i in a:
            v[i] = "-"
        self.remain_operation(v)

        v["总装车间"] = v["主件成本中心"]
        # 按生产单位批量（IMAE017）向上取整 + 损耗率
        v["净需求"] = math.ceil(v["净需求"] * (1 + v["生产损耗率"] / 100) / base["IMAE017"]) * base["IMAE017"] \
            if base["IMAE017"] else v["净需求"] * (1 + v["生产损耗率"] / 100)

        if v["主件"] != v["下阶"]:
            v["成本中心集"] = v.get("主件成本中心", '')
        else:
            v["成本中心集"] = ''
        v["齐套数"] = float(inf)
        self.l.append(v)
        # 自制+委外 才继续展开
        if v["补给策略"] != "外购" and v["净需求"] > 0 and v["成品工单号"][:7] not in ['QU-GD04', 'QU-GD15']:
            self.aaa(v)

    def calculate(self):
        """
        主循环：依次处理 原始需求 + 安全库存补货
          - 把 need 表里每行构造成 v dict（主件=主件料号, 下阶=SFBA006, BOM用量=QPA分子/QPA分母, 跟单码=工单单号+_SFBASEQ, ...）
          - 调 sss(v)
          - 安全库存：构造一个"成品工单号=安全库存" + 开工/完工 = 90 天后 的伪需求
          - 累加 "总装发出数量"（成品工单状态=已发出 且按"下阶"汇总毛需求）
          - 生成库存情况 r（r = 总库存/总在制/在验/在途/多余/多余含在途...），r 来源是 remain_dict_copy / cj_dict_copy / in_transit_dict 的并集
        """
        for i in self.need:
            v = {
                "主件": i["主件料号"],
                "下阶": i["SFBA006"],
                "BOM用量": i["QPA分子"] / i["QPA分母"],
                "父跟单码": i["工单单号"],
                "成品工单号": i["工单单号"].replace("(备货)", ""),
                "成品工单状态": i["工单状态"],
                "跟单码": i["工单单号"] + "_" + str(i["SFBASEQ"]),
                "预计开工日期": i["预计开工日期"],
                "预计完工日期": i["预计完工日期"],
                "毛需求": i["主件需求数量"] * i["QPA分子"] / i["QPA分母"],
                "客户订单号": i["SFAAUD002"],
                "来源单号": i["SFAA006"],
                "主件单位": None,
                "下阶单位": i["SFBA014"],
                "备注": i["OOFF013"],
                "原始需求": True,
                "总装锁定日期": i["SFAAUA002"].strftime("%Y-%m-%d") if (i["SFAAUA002"] != '' and i["SFAAUA002"]) else '',
                "立柱锁定日期": i["SFAAUA003"].strftime("%Y-%m-%d") if (i["SFAAUA003"] != '' and i["SFAAUA003"]) else '',
                "客户": i["客户"]
            }
            self.docdt[v["成品工单号"]] = i["DOCDT"]
            self.sss(v)
        # 安全库存补货
        now = datetime.datetime.now(timezone('Asia/Shanghai')).replace(minute=0, second=0, microsecond=0, tzinfo=None)
        for i in self.safetystock:
            v = {
                "主件": i["IMAF001"],
                "下阶": i["IMAF001"],
                "BOM用量": 1,
                "父跟单码": "",
                "成品工单号": "安全库存",
                "成品工单状态": "",
                "跟单码": "安全库存" + i["IMAF001"],
                "预计开工日期": now + datetime.timedelta(days=90),
                "预计完工日期": now + datetime.timedelta(days=90),
                "毛需求": i["IMAF026"],
                "客户订单号": "安全库存",
                "来源单号": "安全库存",
                "主件单位": None,
                "下阶单位": i["IMAF053"],
                "原始需求": True,
                "总装锁定日期": '',
                "立柱锁定日期": ''
            }
            self.sss(v)

        # 已发出的成品工单，按"下阶"汇总毛需求 → 写到每行的"总装发出数量"列
        sums = {}
        for item in self.l:
            if item['成品工单状态'] == "已发出":
                if item['下阶'] not in sums:
                    sums[item['下阶']] = 0
                sums[item['下阶']] += item['毛需求']
        for item in self.l:
            item["总装发出数量"] = sums.get(item["下阶"], 0)

        # 库存情况 Sheet 数据
        def dykc_zt(i):
            """多余库存含在途 = 总库存 + 总在制 + 总采购在途 - 总需求，不足取 0"""
            n = self.remain_dict_copy.get(i, 0) + self.cj_dict_copy.get(i, 0) + self.in_transit_dict.get(i, 0) - self.item_need.get(i, 0)
            return n if n > 0 else 0

        # r 取 remain_dict_copy / cj_dict_copy / in_transit_dict 的并集，每个料号输出一行
        for i in self.remain_dict_copy:
            self.r.append({"料号": i, "料名": self.items_dict[i]["IMAAL003"], "规格": self.items_dict[i]["IMAAL004"],
                           "总库存": self.remain_dict_copy.get(i, 0), "总在制": self.cj_dict_copy.get(i, 0),
                           "多余库存": self.remain_dict.get(i, 0), "多余在制": self.cj_dict.get(i, 0),
                           "安全库存量": self.base_dict.get(i, {}).get("IMAF026", 0), "总采购在途": self.in_transit_dict.get(i, 0),
                           "总在验": self.tests_dict.get(i, 0), "总需求": self.item_need.get(i, 0), "多余库存含在途": dykc_zt(i)})
        for i in self.cj_dict_copy:
            if self.remain_dict_copy.get(i) == None:
                self.r.append({"料号": i, "料名": self.items_dict[i]["IMAAL003"], "规格": self.items_dict[i]["IMAAL004"],
                               "总库存": self.remain_dict_copy.get(i, 0), "总在制": self.cj_dict_copy.get(i, 0),
                               "多余库存": self.remain_dict.get(i, 0), "多余在制": self.cj_dict.get(i, 0),
                               "安全库存量": self.base_dict.get(i, {}).get("IMAF026", 0), "总采购在途": self.in_transit_dict.get(i, 0),
                               "总在验": self.tests_dict.get(i, 0), "总需求": self.item_need.get(i, 0), "多余库存含在途": dykc_zt(i)})
        for i in self.in_transit_dict:
            if self.remain_dict_copy.get(i) == None and self.cj_dict_copy.get(i) == None:
                self.r.append({"料号": i, "料名": self.items_dict[i]["IMAAL003"], "规格": self.items_dict[i]["IMAAL004"],
                               "总库存": self.remain_dict_copy.get(i, 0), "总在制": self.cj_dict_copy.get(i, 0),
                               "多余库存": self.remain_dict.get(i, 0), "多余在制": self.cj_dict.get(i, 0),
                               "安全库存量": self.base_dict.get(i, {}).get("IMAF026", 0), "总采购在途": self.in_transit_dict.get(i, 0),
                               "总在验": self.tests_dict.get(i, 0), "总需求": self.item_need.get(i, 0), "多余库存含在途": dykc_zt(i)})
        self.d.close()
