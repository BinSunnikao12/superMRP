import pymysql


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
    s = ''' select gendanM,beizhu,chengnuoJQ from diy_Remarks where gendanM is not null  '''
    remark_dict = {}
    for i in mm(s):
        remark_dict[i[0]] = i
    return remark_dict

def ryjj():
    s = ''' select t0.yuancaiGRY as  原采购员,t1.Name as 新采购员
            from diy_handover t0 join  sys_user t1 on t0.jieshouRY=t1.Account
            where t0.isDeleted=false and t1.IsDeleted=0 and t1.ShifouCGY ='是'  
        '''
    remark_dict = {}

    for i in mm(s):
        remark_dict[i[0]] = i[1]
    return remark_dict

