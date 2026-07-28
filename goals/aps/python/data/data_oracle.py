# -*- coding: utf-8 -*-
"""
data.data_oracle：Oracle ERP 主数据加载
=========================================

连接：192.168.0.199:1521/topprd (user=erp_reader)
所有表前缀对应 tiptop / GP ERP 系统（鼎捷）。

加载的数据全部以 dict / list[dict] 形式返回，键名用中文字段注释里的别名，
方便 compute 层直接 .get() 取。
"""
import cx_Oracle as cx
import os, json


class db():
    def __init__(self, aa):
        self.site = aa
        # 不同基地的 MRP 单别（用于排除已纳入 MRP 的单据）
        self.mrp_version = {"LG": "WAPS002", "QU": "WAPS001", "YN": "YN01",
                            'GX': 'WAPS001', "FN": "FN01"}[self.site]
        # 强制 instantclient 路径（仅 Windows 开发机需要）
        os.environ['path'] = r'D:\instantclient\instantclient_21_3'
        self.connection = cx.connect(user="erp_reader", password="erp#query",
                                      dsn="192.168.0.199:1521/topprd")
        self.cursor = self.connection.cursor()

    def ora(self, sql):
        """执行 SQL，返回 list[dict]（列名 → 值）"""
        self.cursor.execute(sql)
        col_names = [i[0] for i in self.cursor.description]
        return [dict(zip(col_names, row)) for row in self.cursor]

    def close(self):
        self.cursor.close()
        self.connection.close()

    # ----------------------------------------------------------------------
    # 标准 BOM
    # ----------------------------------------------------------------------
    def bomfunc(self):
        """
        标准 BOM：从 bmba_t（料件主件结构） + bmaa_t（产品结构主件） + imaa_t（料件基础）
        过滤条件：
          - 有效日期内（bmba005 <= sysdate 且 bmba006 IS NULL OR > sysdate）
          - 用量 bmba011 != 0
          - ECN 未作废 bmba019 != 2
        返回 {主件: [BOM 行, ...]}
        """
        bom_sql = '''select bmba001 主件,
               bmba003 下阶,
               bmba011 / bmba012 QPA,
               a.imaa004 主件类别,
               b.imaa004 下阶类别,
               bmba010 发料单位,bmba009 项次
               from bmba_t, bmaa_t,imaa_t a,imaa_t b
                 where bmaa001 = bmba001
                   and bmba001=a.imaa001
                   and bmba003=b.imaa001
                   and bmbasite = bmaasite
                   and bmaasite = '{}'
                   and (bmba006 IS NULL OR bmba006 > sysdate)
                   AND bmba005 <= sysdate
                   and bmba011!=0
                   and bmba019!=2   --ECN变更会更新这个字段，2是作废版本
                   '''
        bom = (self.ora(bom_sql.format(self.site)))
        bom_dict = {}
        for i in bom:
            bom_dict[i["主件"]] = bom_dict.get(i["主件"], []) + [i]
        return bom_dict

    # ----------------------------------------------------------------------
    # 物料主数据
    # ----------------------------------------------------------------------
    def basefunc(self):
        """
        物料主数据：imaf_t + imae_t 关联，取关键字段
          - imaf013 补给策略 (1=外购 2=自制 3=委外)
          - imaf014 需求计算方式
          - imaf026 安全库存量
          - imaf143/145/146 采购单位/批量/最小采购量
          - imaf171~175 采购前置时间
          - imae051 标准人工工时
          - imae071~075 生产前置时间
          - imae015 生产损耗率
          - imae016/017/018 生产单位/批量/最小生产量
          - ooefl003 成本中心名称（中文）
          - IMAFUD010 是否模块化（LG 喷塑 +1 天 逻辑用）
        """
        base_sql = """ select imaf001, --产品料号
        imaf013, --补给策略
        imaf014, --需求计算方式
        imaf026, --安全库存量
        imaf143, --采购单位
        imaf145, --采购单位批量
        imaf146, --最小采购数量
        nvl(imafud010,'N') imafud010,--是否模块化生产
        o1.ooag011 as imaf142, --采购人员
        o2.ooag011 as imafud001, --物控人员
        nvl(imaf171,0) imaf171, --文件前置时间
        nvl(imaf172,0) imaf172, --交货前置时间
        nvl(imaf173,0) imaf173, --到厂前置时间
        nvl(imaf174,0) imaf174, --入库前置时间
        nvl(imaf175,0) imaf175, --最短采购前置时间
        o3.ooag011 as imae012, --计划员
        imae015, --生产损耗率
        imae016, --生产单位
        1  as imae017, --生产单位批量(逻辑上恒为 1)
        imae018, --最小生产数量
        imae037, --预设BOM特性
        imae032, --工艺料号
        imae064, --供给汇整时距
        imae022, --工单拆分批量
        imae036, --允许需求合并生产
        nvl(imae051,0) imae051, --标准人工工时
        nvl(imae071,0) imae071, --固定生产前置时间
        nvl(imae072,0) imae072, --变动生产前置时间
        nvl(imae074,0) imae074, --QC前置时间
        nvl(imae075,0) imae075,  --累计前置时间
        imafud003,
        imafud004,
        imafua003,
        imafua004,
        case when imaf013='2'  then nvl(ooefl003,'') when imaf013='3' then '委外需求'  else ooefl003 end ooefl003,--成本中心名称
        case when imaf013='2'  then nvl(imae035,'')  when   imaf013='3' then '{ww_code}' else  imae035 end  imae035--成本中心编码
        from  imaf_t t0 join imae_t on imaf001=imae001 and imafsite=imaesite
        left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','{site}') GROUP BY ooag001)  o1 on o1.ooag001=imaf142
        left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','{site}') GROUP BY ooag001)  o2 on o2.ooag001=imafud001
        left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','{site}') GROUP BY ooag001)  o3 on o3.ooag001=imae012
        left join (select * from ooefl_t where ooefl002='zh_CN') on ooefl001=imae035
        where  imafsite='{site}' """
        ww_code = {"LG": "0000", "GX": '0001', 'YN': '0002', 'QU': '0003', 'FN': '0004'}
        base = (self.ora(base_sql.format(site=self.site, ww_code=ww_code.get(self.site, '9999'))))
        return {i["IMAF001"]: i for i in base}

    # ----------------------------------------------------------------------
    # 原始需求：工单 + 销售订单备货
    # ----------------------------------------------------------------------
    def needfunc(self):
        """
        原始需求 = 工单 + 销售订单（XMDA 备货单）的并集

        工单侧 sfaa_t + sfba_t：
          - 工单类型 = GD01/GD04/GD15/GD16/GD30/GD35/GD36
          - 排除已作废状态 X/C/M/N
          - 净需求 > 0
          - 下阶料件 != 主件（剔除自己）
          - 料件不是虚拟件 imaa004 != 'X'
        销售订单侧 xmda_t + xmdd_t + xmdc_t：
          - 订单已审核 xmdastus='Y' 且 排除已纳入 MRP 版本 (pscc_t)
          - 可交货数量 > 0
          - 单据日期 > 2022-01-01（历史订单豁免）
        返回值按 "工单状态, 预计完工日期, 工单单号" 排序
        """
        need_sql = '''
            select * from (
             select distinct
               (case when xmdddocno is null then '' when  pmdastus='Y' then '' else '包材未确认-'  end)||sfaadocno 工单单号,
                 cast(sfbaseq as VARCHAR(10)) sfbaseq,sfaa019 预计开工日期,
                case  sfaastus when  'Y' then '已审核'  when 'F' then '已发出' end  工单状态,
                sfaa020 预计完工日期,sfaa010 主件料号,sfaa012 -sfaa050 主件需求数量,
                SFBA006,sfba010 qpa分子,sfba011 qpa分母 ,sfaa006,NVL(sfaaud002,' ') sfaaud002,ooag011,sfba014,sfaaua002,sfaaua003,
                null docdt,null ooff013, (case when xmdddocno is null then ''
                      when  pmdastus='Y' then ''
                     else '包材未确认'  end) 包材未确认,'' 客户
                from sfaa_t
                left join ooag_t on ooag001=sfaa002
                left join xmdd_t on xmdddocno=sfaa006 and xmddseq=sfaa007 and xmddsite=sfaasite
                left join (select * from (select distinct pmdadocno,pmdaua016,pmdaua017,pmdasite,pmdastus,row_number() over (partition by pmdaua016,pmdaua017,pmdasite order by pmdastus desc) nb from pmda_t ) where nb=1)
                on pmdaua016=sfaa006 and pmdaua017=sfaa007 and pmdasite=sfaasite
                left join sfba_t on sfaadocno=sfbadocno  and sfaasite=sfbasite
                left join imaa_t on imaa001=sfba006
                where  sfaasite='{site}'  and sfaastus not in('X','C','M','N')
                and substr(sfaadocno,0,7) IN ('{site}-GD01','{site}-GD04','{site}-GD15','{site}-GD16','{site}-GD30','{site}-GD35','{site}-GD36')
                and sfba011!=0 and sfba010!=0  and SFBA006!=sfaa010
                and sfaa012 -sfaa050>0 and imaa004 != 'X'
            union all
            select xmdadocno 订单号,xmddseq||'_'||xmddseq1||'_'||xmddseq2 订单项次,xmdd011 ,'已审核' 工单状态,
               xmdd011 ,xmdd001,xmdd006-xmdd014+xmdd016 可交货数量,xmdd001,1,1,xmdadocno,NVL(xmda033,' ') xmda033,
               ooag011,xmdc006,null,null,xmdadocdt,xmddud001,'',NVL(t2.pmaal003,t1.pmaal003) 客户
                from xmda_t
                join xmdd_t on xmdadocno=xmdddocno
                join xmdc_t on xmdddocno=xmdcdocno and xmddseq=xmdcseq
                left join ooag_t on ooag001=xmda002
                left join pmaal_t t1 on t1.pmaal001 = xmda004 and t1.pmaal002 = 'zh_CN'
                left join pmaal_t t2 on t2.pmaal001 = xmdaud006 and t2.pmaal002='zh_CN'
                where xmdastus='Y' and xmdd006-xmdd014+xmdd016 >0 and xmdasite='{site}' and xmdc045='1'
                and substr(xmdadocno,4,4) not in (select pscc002 from  pscc_t where pscc001='{mrp_version}'  and psccsite='{site}')
                AND xmdc012>  to_date('2022.1.1','yyyy.mm.dd')
         ) order by 工单状态,预计完工日期,工单单号
        '''
        return self.ora(need_sql.format(site=self.site, mrp_version=self.mrp_version))

    # ----------------------------------------------------------------------
    # 库存
    # ----------------------------------------------------------------------
    def remainfunc(self):
        """现有库存（inag_t 库存明细 + inaa_t 库存主档，账号启用 INAA009='Y'）"""
        remain_sql = """
            select inag001,sum(inag008) inag008 from inag_t join inaa_t on inagsite=inaasite and inag004=inaa001
            where inagsite='{site}' and inag008!=0 and inaa009='Y'
                and inag004 not in (select pscd002 from pscd_t where pscd001='{mrp_version}' and pscdsite='{site}')
            group by inag001 """
        remain = self.ora(remain_sql.format(site=self.site, mrp_version=self.mrp_version))
        return {i["INAG001"]: i["INAG008"] for i in remain}

    def cjfunc(self):
        """在制（WIP）= 工单已发料未完工的数量，sfba_t - sfaa_t 已领料比例"""
        cj_sql = '''
            select
            SFBA006,sum(sfba016-sfaa050*sfba013/sfaa012 ) qty
            from sfaa_t   , sfba_t
            where sfaadocno=sfbadocno and sfaasite='{}'  and sfaastus not in('X','C','M','N')
            and sfba013>0
            group by SFBA006 having sum(sfba016-sfaa050*sfba013/sfaa012 )!=0
        '''
        cj = (self.ora(cj_sql.format(self.site)))
        return {i["SFBA006"]: i["QTY"] for i in cj}

    def itemsfunc(self):
        """料件中文名称（zh_CN）"""
        items_sql = ''' select imaal001,imaal003,imaal004 from imaal_t  where imaal002='zh_CN'  '''
        items = (self.ora(items_sql))
        return {i["IMAAL001"]: i for i in items}

    def vn_itemsfunc(self):
        """料件越南文名称（vi_VN）"""
        items_sql = '''select imaal001,imaal003,imaal004 from imaal_t  where imaal002='vi_VN' '''
        items = (self.ora(items_sql))
        return {i["IMAAL001"]: i for i in items}

    def buyerfunc(self):
        """最近采购供应商/采购员：取每个料号最新一笔采购单（按 PMDLDOCDT 倒序）"""
        buyer_sql = '''
            select pmdn001,ooag011,pmaal003,pmdl004 from
            (select * from
            (select pmdn001,pmdndocno,row_number() over(partition by pmdn001 order by pmdldocdt desc) as nb from
            (select distinct pmdn001,pmdndocno,pmdldocdt from pmdn_t
            left join pmdl_t on pmdnent=pmdlent and pmdnsite=pmdlsite and pmdndocno=pmdldocno
            where pmdnent=5 and pmdnsite='{site}' and pmdlstus!='X') A)
            where   nb=1 )
            left join pmdl_t on pmdndocno=pmdldocno
            left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','{site}') GROUP BY ooag001) on pmdl002=ooag001
                        left join   pmaal_t on pmaal001=pmdl004 where pmaal002='zh_CN'
        '''
        buyer = (self.ora(buyer_sql.format(site=self.site)))
        return {i["PMDN001"]: i for i in buyer}

    def testfunc(self):
        """在验数量 = 进货检验单 pmds_t 中已收未检/未判的数量"""
        test_sql = '''
            select pmdt006,sum(COALESCE(pmdt020,0)-COALESCE(pmdt054,0)-COALESCE(pmdt055,0)) 在验量
            from pmdt_t left join pmds_t on pmdtdocno = pmdsdocno
            where pmdtdocno LIKE '%BJ%' and pmdsstus = 'Y' and pmdtsite='{}'
             group by pmdt006 having sum(COALESCE(pmdt020,0)-COALESCE(pmdt054,0)-COALESCE(pmdt055,0))>0
            '''
        tests = (self.ora(test_sql.format(self.site)))
        return {i["PMDT006"]: i["在验量"] for i in tests}

    def safetystock(self):
        """安全库存量大于 0 的料件 → 用于补货需求"""
        safetystock_sql = '''
            select  imaf001,imaf026,imaf053 from imaf_t  where imaf026>0 and imafsite='{}'
        '''
        return self.ora(safetystock_sql.format(self.site))

    def in_transit(self):
        """采购在途 = 采购单未交量 = pmdo006 - pmdo019 + pmdo017，状态 Y"""
        in_transit_sql = '''
            select  pmdo001,sum(COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0)) as ztnum from pmdl_t,pmdo_t ,pmdn_t
            where pmdoent=pmdlent and pmdosite=pmdlsite and pmdodocno=pmdldocno and pmdndocno=pmdldocno and pmdnseq=pmdoseq
            and  pmdlstus ='Y' and pmdlsite='{site}' and pmdn045='1'
             and   substr(pmdldocno,4,4) not in (select pscc002 from  pscc_t where pscc001='{mrp_version}'  and psccsite='{site}')
            and COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0)>0
            group by pmdo001
        '''
        in_transits = self.ora(in_transit_sql.format(site=self.site, mrp_version=self.mrp_version))
        return {i["PMDO001"]: i["ZTNUM"] for i in in_transits}

    def production_supply(self):
        """工单供给 = 已发料可生产的数量，sfac_t - sfaa_t 关联，状态 Y/F，排除 GD04/GD09/GD10/GD15/GD19"""
        production_supply_sql = '''
            select sfac001,sum(sfac003-sfac005) qty from sfac_t,sfaa_t
            where sfacdocno=sfaadocno and sfaasite='{site}' and sfaastus in ('Y','F')
            and substr(sfaadocno,0,7) not IN ('{site}-GD04','{site}-GD09','{site}-GD10','{site}-GD15','{site}-GD19')
            group by sfac001
        '''
        production_supplys = self.ora(production_supply_sql.format(site=self.site))
        return {i["SFAC001"]: i["QTY"] for i in production_supplys}

    def substitute(self):
        """替代料：bmea_t（料件替代关系），按优先级 bmea015 倒序"""
        substitute_sql = '''
        select bmea001,bmea003,bmea008,bmea011,bmea012, bmea016, bmea007,bmea015
            from bmea_t  where bmea009 <SYSDATE and (bmea010 IS NULL OR bmea010 > sysdate)  and bmeasite='{}'
            order by bmea015  desc
        '''
        substitutes = self.ora(substitute_sql.format(self.site))
        substitute_dict = {}
        for i in substitutes:
            substitute_dict[i["BMEA001"] + "_" + i["BMEA003"]] = substitute_dict.get(
                i["BMEA001"] + "_" + i["BMEA003"], []) + [i]
        return substitute_dict

    def purchase_order_detail(self):
        """
        采购单明细（含 请购 PMDB）：
          - ztnum = 未交量
          - cgd = 单号.项次.项序.分批序
          - 状态未审核的采购单加 '未审核' 前缀
        返回 {料号: [采购单行, ...]}（按日期/单号排序）
        """
        Purchase_Order_Details_sql = '''
  select ooag013,ooag011,pmdo001,ztnum,ztnum as ztnum2,pmdl004,pmaal003,case when pmdlstus='N' then '未审核'||cgd else cgd end as cgd,
             pmdldocdt,pmdo013,
case when length(listagg(to_char(pmdacrtdt,'YYYY-MM-DD'),',') within group (order by pmdpdocno))>200 then listagg(to_char(pmdacrtdt,'YYYY-MM-DD'),',') within group (order by pmdpdocno) else '长度太长' end as  cjrq,
            pmdlstus ,pmdnua019 客户型号,pmdnua120 公司型号
            from(
             select distinct pmdl002,pmdo001,
             COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0) as ztnum,pmdl004,pmaal003,
              pmdldocno||'.'||pmdoseq||'.'||pmdoseq1||'.'||pmdoseq2 as cgd /*采购单号、项次、项序（分期序）、分批序*/ ,
              pmdldocdt,pmdo013,pmdpdocno,pmdacrtdt,pmdlstus ,pmdnua019 ,pmdnua120
              from pmdo_t
              left join pmdl_t on pmdldocno=pmdodocno and pmdlent=pmdoent and pmdlsite=pmdosite
              left join pmdn_t on pmdndocno=pmdodocno and pmdnent=pmdoent and pmdnsite=pmdosite and pmdnseq=pmdoseq
              left join pmdp_t on pmdpdocno=pmdodocno and pmdpseq=pmdoseq
              left join pmda_t on pmdp003=pmdadocno and pmdpsite=pmdasite
              left join pmaal_t on pmaalent=pmdlent and pmaal001=pmdl004 and pmaal002='zh_CN'
             where pmdoent=5  and pmdosite='{site}' and pmdn045='1' /*行状态*/
                and (COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0))>0
                and substr(pmdldocno,4,4) not in (select pscc002 from  pscc_t where pscc001='{mrp_version}'  and pscdsite='{site}')
                and  (pmdlstus ='Y' or pmdlstus ='N')/*审核状态*/
            union all
             select null pmdl002,pmdb004,pmdb006 - pmdb049 qty,'' pmdl004,'' pmaal003,
                    '请购'||pmdbdocno||'.'||pmdbseq cgd,pmdadocdt,null,pmdadocno,pmdacrtdt,pmdastus,null,null
                    from pmdb_t
                    left join pmda_t on pmdbsite = pmdasite and pmdbdocno = pmdadocno
                    where pmdbent = 5 and pmdb006 - pmdb049 > 0 and pmdb032 = '1'
                    and pmdastus = 'Y' and pmdbsite = '{site}'
         )
         left join ooag_t on ooag001 = pmdl002
         group by ooag013,ooag011,pmdo001,ztnum,pmdl004,pmaal003,cgd,pmdldocdt,pmdo013,pmdlstus,pmdnua019,pmdnua120
         order by pmdldocdt,cgd,pmdlstus
        '''
        Purchase_Order_Details = self.ora(Purchase_Order_Details_sql.format(
            site=self.site, mrp_version=self.mrp_version))
        Purchase_Order_Detail_dict = {}
        for i in Purchase_Order_Details:
            Purchase_Order_Detail_dict[i["PMDO001"]] = Purchase_Order_Detail_dict.get(
                i["PMDO001"], []) + [i]
        return Purchase_Order_Detail_dict

    # def unaudited_purchase_order(self):  # 已废弃
    #     ...

    def gd01(self):
        """GD01/GD16/GD35/GD36/GD30 工单的可发量（除成品工单之外的）"""
        gd01_sql = '''
         select sfaa010,sum(sfaa012-sfaa050)  qty
                from sfaa_t
                where sfaasite='{}'  and sfaastus in ('Y','F')
                and substr(sfaadocno,4,4) in ('GD01','GD16','GD35','GD36','GD30')  and sfaa012 -sfaa050>0
                group by sfaa010
        '''
        gd01_r = self.ora(gd01_sql.format(self.site))
        return {i["SFAA010"]: i["QTY"] for i in gd01_r}

    def outsourcing_type(self):
        """外购类型/材质：imaa128 关联 oocql_t 取 oocql004"""
        outsourcing_type_sql = '''
           select imaa001,oocql004,imaa130 from imaa_t
            left join oocql_t on imaa128=oocql002 and oocql001='2004' and oocql003='zh_CN'
        '''
        outsourcing_type_r = self.ora(outsourcing_type_sql.format(self.site))
        return {i["IMAA001"]: i for i in outsourcing_type_r}

    def gd_bom(self):
        """
        GD 替代 BOM：来自 sfaa_t + sfba_t，但排除 GD01/GD04/GD15/GD16/GD35/GD30/GD36
        （即"非顶层工单"的实际发料比例），把"同主件料号下，相同发料结构的多张工单"的未交量累加
        返回 {主件: {BOM_结构(JSON排序后字符串): 未交量合计}}
        """
        gd_bom_sql = '''
          select sfaadocno 工单号,sfaa010 主件料号,sfaa012-sfaa050 未交量,sfba006 发料料号,sfba013/sfaa012 用量比例  ,
            sfba014 发料单位,'g'||sfbaseq 项次
            from sfaa_t
            left join sfba_t on sfaadocno=sfbadocno and sfaasite=sfbasite
            where sfaasite='{site}'  and sfaastus not in('X','C','M','N')
            and SFBA006!=sfaa010
            and sfaa012 -sfaa050>0 and sfba013>0
            and  substr(sfaadocno,0,7) not IN ('{site}-GD01','{site}-GD04','{site}-GD15','{site}-GD16','{site}-GD35','{site}-GD30','{site}-GD36')
        '''
        gd_bom_r = self.ora(gd_bom_sql.format(site=self.site))

        result = {}
        for item in gd_bom_r:
            part_number = item['主件料号']
            work_order = item['工单号']
            if part_number not in result:
                result[part_number] = {}
            if work_order + "_" + str(item["未交量"]) not in result[part_number]:
                result[part_number][work_order + "_" + str(item["未交量"])] = []
            result[part_number][work_order + "_" + str(item["未交量"])].append(
                {"主件": item['主件料号'], "下阶": item["发料料号"], "QPA": item["用量比例"],
                 "主件类别": "W", "下阶类别": "W", "发料单位": item["发料单位"], "项次": item["项次"]})
        dd = {}
        for i, j in result.items():
            d = {}
            for i1, j1 in j.items():
                # 把同结构 BOM 序列化做 key，累加未交量
                jj = json.dumps(sorted(j1, key=lambda x: x['下阶']))
                d[jj] = d.get(jj, 0) + float(i1.split("_")[1])
            dd[i] = d
        return dd

    # def qg(self):  # 已废弃
    #     ...
