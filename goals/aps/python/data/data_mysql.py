# -*- coding: utf-8 -*-
"""
data.data_mysql：MySQL 配置 / 结果回写
========================================

连接：
  - 业务库 mrp (10.19.204.8 / root / 123456)  ← 注意：原代码连的是 192.168.0.78，权限不同；这里保留两份
  - 配置库 lglrp (192.168.0.78) ← leadtime_conf / holiday 表

提供：
  - leadtime_func()        (site, 成本中心编码) → 提前期（天）
  - holiday_func(site)     [(startday, endday), ...]
  - mysql_load(...)        把 l / zj_data / cg_data 写入 mrp 库（并清理老版本）
"""
import pymysql
import math
from math import inf, isnan, isinf


def mm(sql):
    """192.168.0.78 业务库（lglrp/mrp）通用查询"""
    db = pymysql.connect(
        host="192.168.0.78",  # 数据库主机地址
        user="lglrp",  # 数据库用户名
        password="loctek@2023",  # 数据库密码
        database="mrp"  # 数据库名称
    )
    cursor = db.cursor()
    cursor.execute(sql)
    data = cursor.fetchall()
    db.close()
    return data


def leadtime_func():
    """
    业务维护的提前期配置：
      leadtime_conf(site, cost_center, ..., days)
    返回 {(site, cost_center): days}
    """
    s = ''' select * from leadtime_conf  '''
    leadtimes = {}
    for i in mm(s):
        leadtimes[(i[0], i[1])] = i[3]
    return leadtimes


def holiday_func(site):
    """基地节假日清单：[(startday, endday), ...]"""
    s = ''' select DATE_FORMAT(startday, '%Y-%m-%d') AS startday, DATE_FORMAT(endday, '%Y-%m-%d') AS endday from holiday where site = '{}'  '''
    return list(mm(s.format(site)))


def mysql_load(data, site, version, cg_data=None, zj_data=None):
    """
    结果回写到 MySQL（mrp 库）：
      1. mrp 表：写入物料需求明细（ser.l） → 按 1000 行一批 executemany
      2. zj_data 表：写入生产需求汇总
      3. cg_data 表：写入采购需求明细
      4. 写版本号 mrp_version(site, version) ON DUPLICATE KEY UPDATE
      5. 清理：mrp 仅保留最近 3 个版本；cg_data/zj_data 仅保留当前版本
    """
    connection = pymysql.connect(host='192.168.0.78', user='root', password='123456', db='mrp')
    cursor = connection.cursor()

    # 物料需求明细 列定义
    columns = ['预计开工日期', '预计完工日期', '客户订单号', '成品工单号', '成品工单状态', '父跟单码', '跟单码', '主件', '主件料名', '主件规格', '主件成本中心', '下阶',
               '下阶料名', '下阶规格', '下阶成本中心', 'BOM用量', '毛需求', '总库存', '总在制', '总采购在途', '总工单供给', '总在验', '可用库存', '可用在制', '净需求',
               '合计欠料', '补给策略', '计划员', '采购物控人员', '最近采购供应商', '最近采购供应商编码', '采购单位批量', '最小采购数量', '采购单位', '生产单位批量', '最小生产数量',
               '生产单位', '生产损耗率', '固定生产前置时间', '变动生产前置时间', 'QC前置时间', '累计前置时间', '来源单号', '需求计算方式', '齐套数', '越南主件料名', '越南主件规格',
               '越南下阶料名', '越南下阶规格', 'version', 'site', '使用库存', '文件前置时间', '人工工时', '最短采购前置时间', '到厂前置时间', '成本中心集', '交货前置时间',
               '入库前置时间', "主件单位", "下阶单位", "下阶成本中心编码", "承诺交期", "采购回复"]
    placeholders = ', '.join(['%s'] * (len(columns)))
    query = "INSERT INTO mrp ({}) VALUES ({})".format(",".join(columns), placeholders)
    d = []
    for i in data:
        i["site"] = site
        i["version"] = version
        i["齐套数"] = 0 if i["齐套数"] == inf else i["齐套数"]
        d.append([i.get(ii) if i.get(ii) is not None else '' for ii in columns])
    batches = [tuple(d[i: i + 1000]) for i in range(0, len(d), 1000)]
    for batch in batches:
        cursor.executemany(query, batch)
        connection.commit()

    if zj_data != None:
        columns = ['site', 'version', '齐套数总和', '预计完工日期', '总工单供给', '工单供给', '净需求总和', '人工工时', '下阶规格', '下阶料名', '下阶成本中心',
                   '下阶', '跟单码', '下阶成本中心编码', '喷涂料名', '主件成本中心']
        placeholders = ', '.join(['%s'] * (len(columns)))
        query = "INSERT INTO zj_data ({}) VALUES ({})".format(",".join(columns), placeholders)
        d = []
        for i in zj_data:
            i["site"] = site
            i["version"] = version
            i["齐套数总和"] = 0 if isnan(i["齐套数总和"]) else i["齐套数总和"]
            i["齐套数总和"] = 0 if isinf(i["齐套数总和"]) else i["齐套数总和"]
            d.append([i.get(ii) if i.get(ii) is not None else '' for ii in columns])
        batches = [tuple(d[i: i + 1000]) for i in range(0, len(d), 1000)]
        for batch in batches:
            cursor.executemany(query, batch)
            connection.commit()

    if cg_data != None:
        columns = ['site', 'version', '要求到货日期', '下阶', '下阶料名', '下阶规格', '需求', '总采购在途',
                   '总库存', '总在制', '总在验', '未处理请购数', '采购物控人员', '跟单码', '采购单', '单据日期',
                   '采购单要求交期', '请购创建日期', '供应商', '外购类型', '客户订单号', "公司型号", "客户型号"]
        placeholders = ', '.join(['%s'] * (len(columns)))
        query = "INSERT INTO cg_data ({}) VALUES ({})".format(",".join(columns), placeholders)
        d = []
        for i in cg_data:
            i["site"] = site
            i["version"] = version
            d.append([i.get(ii) if i.get(ii) is not None else '' for ii in columns])
        batches = [tuple(d[i: i + 1000]) for i in range(0, len(d), 1000)]
        for batch in batches:
            cursor.executemany(query, batch)
            connection.commit()

    # 更新 mrp_version 表（每个 site 当前 version）
    version_sql = '''insert into mrp_version (site,version) values(%s,%s) ON DUPLICATE KEY UPDATE version =values(version)'''
    cursor.execute(version_sql, (site, version))
    connection.commit()

    # 清理老版本：mrp 只保留最近 3 版；cg_data / zj_data 只保留当前版
    del_sql = '''delete from  mrp where site=%s and version!=%s
        and version not in (select version from (
        SELECT DISTINCT version
        FROM mrp where site=%s
        ORDER BY version desc
        LIMIT 3) as a) '''
    cursor.execute(del_sql, (site, version, site))
    connection.commit()
    del_cg_sql = '''delete from  cg_data where site=%s and version!=%s '''
    cursor.execute(del_cg_sql, (site, version))
    connection.commit()
    del_zj_sql = '''delete from  zj_data where site=%s and version!=%s '''
    cursor.execute(del_zj_sql, (site, version))
    connection.commit()

    cursor.close()
    connection.close()
