import json,sys
from aps.data import data_oracle, data_mysql,data_mes
import copy,datetime
import math
from math import inf
from pytz import timezone
from aps.compute import methods

class serve():
    def __init__(self, site):
        self.d                             = data_oracle.db(site)
        self.site                          = site
        self.cj_dict                       = self.d.cjfunc()
        self.base_dict                     = self.d.basefunc()
        self.remain_dict                   = self.d.remainfunc()
        self.items_dict                    = self.d.itemsfunc()
        self.vn_items_dict                 = self.d.vn_itemsfunc()
        self.need                          = self.d.needfunc()
        self.bom_dict                      = self.d.bomfunc()
        self.buyer_dict                    = self.d.buyerfunc()
        self.remain_dict_copy              = copy.copy(self.remain_dict)
        self.cj_dict_copy                  = copy.copy(self.cj_dict)
        self.tests_dict                    = self.d.testfunc()
        self.safetystock                   = self.d.safetystock()
        self.in_transit_dict               = self.d.in_transit()
        self.production_supply_dict        = self.d.production_supply()
        self.substitutes                   = self.d.substitute()
        self.purchase_order_detail_dict    = self.d.purchase_order_detail()
        self.remark                        = data_mes.remark()
        self.ryjj                          = data_mes.ryjj()
        # self.unaudited_purchase_order_dict = self.d.unaudited_purchase_order()
        self.outsourcing_type_dict         = self.d.outsourcing_type()
        # self.gd01                          = self.d.gd01()
        self.gd01                          = self.d.get_special_supply()
        self.gd01_copy                     = copy.copy(self.gd01)
        self.gd_bom_dict                   = self.d.gd_bom()
        self.leadtime_map                  = data_mysql.leadtime_func()
        self.holiday                       = data_mysql.holiday_func(self.site)
        # self.qg_map                        = self.d.qg()
        self.total_demand                  = {}
        self.l                             = []
        self.r                             = []
        self.docdt                         = {}
        self.item_need                     = {}

    def hoilday_func(self,v):
        parse_datetime = lambda date_str: datetime.datetime.strptime(date_str, "%Y-%m-%d")
        overlap = None
        if v["下阶成本中心编码"] == '1073' and v["成品工单号"][:7] == 'LG-GD01' and "." not in v["跟单码"]:
            v["预计开工日期"] = v["预计开工日期"] - datetime.timedelta(days=self.leadtime_map[('LG',"1069")])
        for h in self.holiday:
            # 开工日期早于假期结束日期，完工日期晚于假日开始日期，表示两个时间区间有交叉
            if v["预计开工日期"] <= parse_datetime(h[1]) and v["预计完工日期"] >= parse_datetime(h[0]):
                overlap = h
                break
        if overlap:
            d = (parse_datetime(overlap[1]) - v["预计完工日期"]).days
            d = 0 if d < 0 else d
            num_days = ((parse_datetime(overlap[1]) - parse_datetime(overlap[0])).days) - d + 1
            v["预计开工日期"] = v["预计开工日期"] - datetime.timedelta(days=num_days)

    def remain_operation(self, v, enddate=None, c=''):
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
        self.remain_dict[item] = rrrr[1]["可用库存"]
        self.cj_dict[item] = rrrr[1]["可用在制"]
        self.gd01[item] = rrrr[1]["GD01可用工单数"]

        v["人工工时"] = base["IMAE051"] * v["净需求"]
        v["子件标准人工工时"]=base["IMAE051"]
        v["主件标准人工工时"] = main_base["IMAE051"]
        v["总库存"] = self.remain_dict_copy.get(item, 0)
        v["总在制"] = self.cj_dict_copy.get(item, 0)
        v["GD01工单数"] = self.gd01_copy.get(item, 0)
        v["总在验"] = self.tests_dict.get(item, 0)
        v["总采购在途"] = self.in_transit_dict.get(item, 0)
        v["总工单供给"] = self.production_supply_dict.get(item, 0)
        self.total_demand[item] = self.total_demand.get(item, 0) + v["净需求"]
        v["合计欠料"] = self.total_demand.get(item, 0)
        self.item_need[item]=self.item_need.get(item,0)+v["毛需求"]
        items_f = self.items_dict[v["主件"]]
        v["主件料名"] = items_f["IMAAL003"]
        v["主件规格"] = items_f["IMAAL004"]
        items_s = self.items_dict[item]
        v["下阶料名"] = items_s["IMAAL003"]
        v["下阶规格"] = items_s["IMAAL004"]
        v["下阶成本中心"] = base["OOEFL003"]
        v["主件成本中心"] = main_base["OOEFL003"]
        v["下阶成本中心编码"]=base["IMAE035"]
        v["主件成本中心编码"] = main_base["IMAE035"]
      #  v["总装车间"]=v["主件成本中心"]
        v["外购类型"] = self.outsourcing_type_dict.get(item,{}).get("OOCQL004")
        v["材质"] = self.outsourcing_type_dict.get(item, {}).get("IMAA130")
        leadtime = v["固定生产前置时间"] + v["变动生产前置时间"] + v["QC前置时间"] + v["累计前置时间"]
        
        key = (self.site, main_base["IMAE035"])
        if key in self.leadtime_map:
            n = 0
            if main_base["IMAE035"] == "1073" and main_base["IMAFUD010"] == "Y" and self.site == 'LG':
                #乐歌喷塑车间物料，如果有是否模块化标记，则提前期在原基础上+1天
                n = 1
            leadtime = self.leadtime_map[key] + n if v["主件成本中心"] not in c else 0
        if v.get("下阶类别") == "X":
            leadtime = 0

        if v.get("预计完工日期") == None:
            v["预计完工日期"] = enddate
           
#            try:
            v["预计开工日期"] = enddate - datetime.timedelta(days=leadtime)
#            except TypeError:
#                print(v)
#               print(enddate)
#                sys.exit(1) 

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
        b = {"LG": "张玉洪", "QU": "", "YN": "", "GX": "","FN":""}
        v["采购物控人员"] = buyers.get("OOAG011", b[self.site]) if base["IMAF013"] == "1" else ""
        # if 'LGSC' in v["客户订单号"] and  base["IMAF013"] == "1":
        #     v["采购物控人员"]="千银海"
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
        bom = self.bom_dict.get(m["下阶"],[])
        x1=self.gd_bom_dict.get(m["下阶"],{})
        nn=m["净需求"]

        f=0
        for i,j in x1.items():
            bom_i=json.loads(i)
            for iii in bom_i:
                iii["项次"]=iii["项次"]+"_"+str(f)
            f+=1
            if methods.compare_data(bom_i, bom)==False:
                if nn>j and j>0:
                    methods.xxxx(bom_i,j, m, self)
                    nn-=j
                    self.gd_bom_dict[m["下阶"]][i]=0
                elif nn<=j and nn>0:
                    methods.xxxx(bom_i, nn, m, self)
                    self.gd_bom_dict[m["下阶"]][i] = j-nn
                    nn = 0
            # if nn>0 and j >0:
            #     c+=1
            #     m["跟单码"] += "({})".format(c)

        if nn>0 and bom:
            methods.xxxx(bom,nn,m,self)

    def sss(self, v):
        a = ["累计前置时间", "QC前置时间", "变动生产前置时间", "固定生产前置时间", "最短采购前置时间", "入库前置时间", "到厂前置时间", "文件前置时间", "交货前置时间"]
        base = self.base_dict[v["下阶"]]
        remark=self.remark.get(v["跟单码"])
        v["采购回复"] = remark[1] if remark !=None else ""
        v["承诺交期"] = remark[2] if remark !=None else ""
        v["生产损耗率"] = base["IMAE015"] if base["IMAE015"] is not None else 0
        for i in a:
            v[i] = "-"
        self.remain_operation(v)

        v["总装车间"]=v["主件成本中心"]
        v["净需求"] = math.ceil(v["净需求"] * (1 + v["生产损耗率"] / 100) / base["IMAE017"]) * base["IMAE017"] if base["IMAE017"] else v["净需求"] * (1 + v["生产损耗率"] / 100)

        if v["主件"] != v["下阶"]:
            v["成本中心集"] = v.get("主件成本中心", '')
        else:
            v["成本中心集"] = ''
        v["齐套数"] = float(inf)
        self.l.append(v)
        if v["补给策略"] != "外购" and v["净需求"] > 0 and v["成品工单号"][:7] not in ['QU-GD04', 'QU-GD15']:
            self.aaa(v)

    def calculate(self):
        for i in self.need:
            v = {
                "主件": i["主件料号"],
                "下阶": i["SFBA006"],
                "BOM用量": i["QPA分子"] / i["QPA分母"],
                "父跟单码": i["工单单号"],
                "成品工单号": i["工单单号"].replace("(备货)",""),
                "成品工单状态": i["工单状态"],
                "跟单码": i["工单单号"] + "_" + str(i["SFBASEQ"]),
                "预计开工日期": i["预计开工日期"],
                "预计完工日期": i["预计完工日期"],
                "毛需求": i["主件需求数量"] * i["QPA分子"] / i["QPA分母"],
                "客户订单号": i["SFAAUD002"],
                "来源单号": i["SFAA006"],
                "主件单位":None,
                "下阶单位": i["SFBA014"],
                "备注":i["OOFF013"],
                "原始需求":True,
                "总装锁定日期":i["SFAAUA002"].strftime("%Y-%m-%d") if  (i["SFAAUA002"] != '' and i["SFAAUA002"]) else '',
                "立柱锁定日期":i["SFAAUA003"].strftime("%Y-%m-%d") if  (i["SFAAUA003"] != '' and i["SFAAUA003"]) else '',
                "客户":i["客户"]
            }
            self.docdt[v["成品工单号"]]=i["DOCDT"]
            self.sss(v)
        now=datetime.datetime.now(timezone('Asia/Shanghai')).replace(minute=0, second=0, microsecond=0,tzinfo=None)
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
                "下阶单位":i["IMAF053"],
                "原始需求": True,
                "总装锁定日期":'',
                "立柱锁定日期":''
            }
            self.sss(v)

        sums = {}
        for item in self.l:
            if item['成品工单状态'] == "已发出":
                if item['下阶'] not in sums:
                    sums[item['下阶']] = 0
                sums[item['下阶']] += item['毛需求']
        for item in self.l:
            item["总装发出数量"]=sums.get(item["下阶"],0)

        def dykc_zt(i):
            n=self.remain_dict_copy.get(i, 0) + self.cj_dict_copy.get(i, 0) + self.in_transit_dict.get(i, 0) - self.item_need.get( i, 0)
            return n if n>0 else 0

        for i in self.remain_dict_copy:
            self.r.append({"料号": i, "料名": self.items_dict[i]["IMAAL003"], "规格": self.items_dict[i]["IMAAL004"],
                           "总库存": self.remain_dict_copy.get(i, 0), "总在制": self.cj_dict_copy.get(i, 0),
                           "多余库存": self.remain_dict.get(i, 0), "多余在制": self.cj_dict.get(i, 0),
                           "安全库存量": self.base_dict.get(i,{}).get("IMAF026",0),"总采购在途": self.in_transit_dict.get(i, 0),
                           "总在验": self.tests_dict.get(i, 0),"总需求":self.item_need.get(i,0),"多余库存含在途":dykc_zt(i)})
        for i in self.cj_dict_copy:
            if self.remain_dict_copy.get(i) == None:
                self.r.append({"料号": i, "料名": self.items_dict[i]["IMAAL003"], "规格": self.items_dict[i]["IMAAL004"],
                               "总库存": self.remain_dict_copy.get(i, 0), "总在制": self.cj_dict_copy.get(i, 0),
                               "多余库存": self.remain_dict.get(i, 0), "多余在制": self.cj_dict.get(i, 0),
                               "安全库存量": self.base_dict.get(i,{}).get("IMAF026",0),"总采购在途": self.in_transit_dict.get(i, 0),
                               "总在验": self.tests_dict.get(i, 0),"总需求":self.item_need.get(i,0),"多余库存含在途":dykc_zt(i)})
        for i in self.in_transit_dict:
            if self.remain_dict_copy.get(i) == None and self.cj_dict_copy.get(i) == None:
                self.r.append({"料号": i, "料名": self.items_dict[i]["IMAAL003"], "规格": self.items_dict[i]["IMAAL004"],
                               "总库存": self.remain_dict_copy.get(i, 0), "总在制": self.cj_dict_copy.get(i, 0),
                               "多余库存": self.remain_dict.get(i, 0), "多余在制": self.cj_dict.get(i, 0),
                               "安全库存量": self.base_dict.get(i,{}).get("IMAF026",0), "总采购在途": self.in_transit_dict.get(i, 0),
                               "总在验": self.tests_dict.get(i, 0), "总需求": self.item_need.get(i, 0),
                               "多余库存含在途":dykc_zt(i)})
        self.d.close()


