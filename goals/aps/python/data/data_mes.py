# -*- coding: utf-8 -*-
"""
data.data_mes：低代码平台（MES/乐歌 lowcode）业务数据
====================================================

连接：10.19.204.8 / lowcode / 6V_YBn*q / lowcode

提供：
  - remark()  跟单码 → (备注, 采购回复, 承诺交期)
  - ryjj()    原采购员 → 新采购员（采购员交接映射）
"""
import pymysql
from math import inf, isnan, isinf


def mm(sql):
    db = pymysql.connect(
        # host="10.10.68.40",  # 数据库主机地址
        host="10.19.204.8",
        user="lowcode",  # 数据库用户名
        # password="2AJR$9@TKLJu7vZ#Ks",  # 数据库密码
        password="6V_YBn*q",
        database="lowcode"  # 数据库名称
    )
    cursor = db.cursor()
    cursor.execute(sql)
    data = cursor.fetchall()
    db.close()
    return data


def remark():
    """
    跟单码级别的 采购回复 / 承诺交期：
      gendanM: 跟单码
      beizhu:  备注
      chengnuoJQ: 承诺交期
    返回 {gendanM: (gendanM, beizhu, chengnuoJQ)}
    """
    s = ''' select gendanM,beizhu,chengnuoJQ from diy_Remarks where gendanM is not null  '''
    remark_dict = {}
    for i in mm(s):
        remark_dict[i[0]] = i
    return remark_dict


def ryjj():
    """
    采购员交接映射：原采购员 → 新采购员
    数据源：diy_handover + sys_user 关联，过滤未删除 + 接收方是采购员
    返回 {原采购员: 新采购员}
    """
    s = ''' select t0.yuancaiGRY as  原采购员,t1.Name as 新采购员
            from diy_handover t0 join  sys_user t1 on t0.jieshouRY=t1.Account
            where t0.isDeleted=false and t1.IsDeleted=0 and t1.ShifouCGY ='是'
        '''
    remark_dict = {}
    for i in mm(s):
        remark_dict[i[0]] = i[1]
    return remark_dict
