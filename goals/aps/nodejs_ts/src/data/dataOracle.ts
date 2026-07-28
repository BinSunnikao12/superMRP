/**
 * src/data/dataOracle.ts
 * ============================================================
 * Oracle ERP 主数据加载（Node.js + TypeScript 复刻版 + 优化）
 *
 * 优化点：
 *   1. oracledb 改用连接池（dbPools.withOracleConnection）
 *   2. 全部查询走 TtlLru 缓存：key = `${site}|${method}`，TTL = 10 分钟
 *      多基地连跑时，只有第一次查 Oracle，后续直接命中
 *   3. 同样 SQL 一次只生成一次结果
 */
import oracledb from 'oracledb';
import { withOracleConnection, initOraclePool } from './dbPools';
import { cachePool } from '../cache/ttlLru';
import { config } from '../config';

type Row = Record<string, any>;
type RowDict = Record<string, Row>;
type QtyMap = Record<string, number>;

export type { Row, RowDict, QtyMap };

/**
 * OracleDB 直连版（仅当 MRP_ORACLE_SOURCE=direct 时使用）
 * 走 oracledb thin mode + 连接池
 * 选择数据源请用 src/data/dataSource.ts 的 getOracleDB()
 */
export class OracleDB {
    private site: string;
    private mrpVersion: string;

    constructor(site: string) {
        this.site = site;
        this.mrpVersion = ({
            'LG': 'WAPS002', 'QU': 'WAPS001', 'YN': 'YN01',
            'GX': 'WAPS001', 'FN': 'FN01',
        } as Record<string, string>)[site];
    }

    /** 应用启动时调一次即可（idempotent） */
    async init(): Promise<void> {
        await initOraclePool();
    }

    /**
     * 执行 SQL 并返回 list[dict]（列名 → 值）
     * 内部走 withOracleConnection，结束自动归还连接到池
     */
    private async ora(sql: string): Promise<Row[]> {
        return withOracleConnection(async (conn) => {
            const result = await conn.execute<Row>(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
            return (result.rows || []) as Row[];
        });
    }

    /**
     * 通用缓存包装：第一次走 Oracle，10 分钟内直接返回缓存
     */
    private async cached<T>(namespace: string, loader: () => Promise<T>): Promise<T> {
        const pool = cachePool.get(this.site, 'oracle');
        return pool.wrap(`${namespace}|${this.mrpVersion}`, loader);
    }

    /**
     * 把表名加上 schema 前缀（如果配置了）
     * 默认情况下 TIPTOP GP 的当前用户就是 schema，不加前缀
     */
    private t(table: string): string {
        const s = config.oracle.schema;
        return s ? `${s}.${table}` : table;
    }

    async close(): Promise<void> {
        // 不再关连接池（应用级别统一关）
    }

    // ----------------------------------------------------------------------
    // 标准 BOM
    // ----------------------------------------------------------------------
    async bomfunc(): Promise<RowDict> {
        return this.cached('bomfunc', async () => {
            const bomSql = `select bmba001 主件,
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
                   and bmaasite = '${this.site}'
                   and (bmba006 IS NULL OR bmba006 > sysdate)
                   AND bmba005 <= sysdate
                   and bmba011!=0
                   and bmba019!=2`;
            const bom = await this.ora(bomSql);
            const bomDict: RowDict = {};
            for (const i of bom) {
                if (!bomDict[i['主件']]) bomDict[i['主件']] = [];
                bomDict[i['主件']].push(i);
            }
            return bomDict;
        });
    }

    async basefunc(): Promise<RowDict> {
        return this.cached('basefunc', async () => {
            const baseSql = ` select imaf001, imaf013, imaf014, imaf026, imaf143, imaf145, imaf146,
        nvl(imafud010,'N') imafud010,
        o1.ooag011 as imaf142,
        o2.ooag011 as imafud001,
        nvl(imaf171,0) imaf171, nvl(imaf172,0) imaf172, nvl(imaf173,0) imaf173, nvl(imaf174,0) imaf174, nvl(imaf175,0) imaf175,
        o3.ooag011 as imae012,
        imae015, imae016,
        1  as imae017,
        imae018, imae037, imae032, imae064, imae022, imae036,
        nvl(imae051,0) imae051,
        nvl(imae071,0) imae071, nvl(imae072,0) imae072, nvl(imae074,0) imae074, nvl(imae075,0) imae075,
        imafud003, imafud004, imafua003, imafua004,
        case when imaf013='2'  then nvl(ooefl003,'') when imaf013='3' then '委外需求'  else ooefl003 end ooefl003,
        case when imaf013='2'  then nvl(imae035,'')  when   imaf013='3' then '{ww_code}' else  imae035 end  imae035
        from  imaf_t t0 join imae_t on imaf001=imae001 and imafsite=imaesite
        left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','${this.site}') GROUP BY ooag001)  o1 on o1.ooag001=imaf142
        left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','${this.site}') GROUP BY ooag001)  o2 on o2.ooag001=imafud001
        left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','${this.site}') GROUP BY ooag001)  o3 on o3.ooag001=imae012
        left join (select * from ooefl_t where ooefl002='zh_CN') on ooefl001=imae035
        where  imafsite='${this.site}' `;
            const wwCode: Record<string, string> = { 'LG': '0000', 'GX': '0001', 'YN': '0002', 'QU': '0003', 'FN': '0004' };
            const base = await this.ora(baseSql.replace('{ww_code}', wwCode[this.site] || '9999'));
            const result: RowDict = {};
            for (const i of base) result[i['IMAF001']] = i;
            return result;
        });
    }

    async needfunc(): Promise<Row[]> {
        return this.cached('needfunc', async () => {
            const needSql = `
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
                where  sfaasite='${this.site}'  and sfaastus not in('X','C','M','N')
                and substr(sfaadocno,0,7) IN ('${this.site}-GD01','${this.site}-GD04','${this.site}-GD15','${this.site}-GD16','${this.site}-GD30','${this.site}-GD35','${this.site}-GD36')
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
                where xmdastus='Y' and xmdd006-xmdd014+xmdd016 >0 and xmdasite='${this.site}' and xmdc045='1'
                and substr(xmdadocno,4,4) not in (select pscc002 from  pscc_t where pscc001='${this.mrpVersion}'  and psccsite='${this.site}')
                AND xmdc012>  to_date('2022.1.1','yyyy.mm.dd')
         ) order by 工单状态,预计完工日期,工单单号
        `;
            return this.ora(needSql);
        });
    }

    async remainfunc(): Promise<RowDict> {
        return this.cached('remainfunc', async () => {
            const sql = `select inag001,sum(inag008) inag008 from inag_t join inaa_t on inagsite=inaasite and inag004=inaa001
            where inagsite='${this.site}' and inag008!=0 and inaa009='Y'
                and inag004 not in (select pscd002 from pscd_t where pscd001='${this.mrpVersion}' and pscdsite='${this.site}')
            group by inag001`;
            const remain = await this.ora(sql);
            const result: RowDict = {};
            for (const i of remain) result[i['INAG001']] = i['INAG008'];
            return result;
        });
    }

    async cjfunc(): Promise<RowDict> {
        return this.cached('cjfunc', async () => {
            const sql = `select SFBA006,sum(sfba016-sfaa050*sfba013/sfaa012 ) qty
            from sfaa_t , sfba_t
            where sfaadocno=sfbadocno and sfaasite='${this.site}'  and sfaastus not in('X','C','M','N')
            and sfba013>0
            group by SFBA006 having sum(sfba016-sfaa050*sfba013/sfaa012 )!=0`;
            const cj = await this.ora(sql);
            const result: RowDict = {};
            for (const i of cj) result[i['SFBA006']] = i['QTY'];
            return result;
        });
    }

    async itemsfunc(): Promise<RowDict> {
        return this.cached('itemsfunc', async () => {
            // 料件名称按 site 不区分（多语料件是全集团共享的）
            const sql = ` select imaal001,imaal003,imaal004 from imaal_t  where imaal002='zh_CN' `;
            const items = await this.ora(sql);
            const result: RowDict = {};
            for (const i of items) result[i['IMAAL001']] = i;
            return result;
        });
    }

    async vn_itemsfunc(): Promise<RowDict> {
        return this.cached('vn_itemsfunc', async () => {
            const sql = `select imaal001,imaal003,imaal004 from imaal_t  where imaal002='vi_VN'`;
            const items = await this.ora(sql);
            const result: RowDict = {};
            for (const i of items) result[i['IMAAL001']] = i;
            return result;
        });
    }

    async buyerfunc(): Promise<RowDict> {
        return this.cached('buyerfunc', async () => {
            const sql = `select pmdn001,ooag011,pmaal003,pmdl004 from
            (select * from
            (select pmdn001,pmdndocno,row_number() over(partition by pmdn001 order by pmdldocdt desc) as nb from
            (select distinct pmdn001,pmdndocno,pmdldocdt from pmdn_t
            left join pmdl_t on pmdnent=pmdlent and pmdnsite=pmdlsite and pmdndocno=pmdldocno
            where pmdnent=5 and pmdnsite='${this.site}' and pmdlstus!='X') A)
            where   nb=1 )
            left join pmdl_t on pmdndocno=pmdldocno
            left join (select  ooag001,MAX(ooag011) ooag011 from ooag_t where ooag004 in ('ALL','${this.site}') GROUP BY ooag001) on pmdl002=ooag001
                        left join   pmaal_t on pmaal001=pmdl004 where pmaal002='zh_CN'`;
            const buyer = await this.ora(sql);
            const result: RowDict = {};
            for (const i of buyer) result[i['PMDN001']] = i;
            return result;
        });
    }

    async testfunc(): Promise<RowDict> {
        return this.cached('testfunc', async () => {
            const sql = `select pmdt006,sum(COALESCE(pmdt020,0)-COALESCE(pmdt054,0)-COALESCE(pmdt055,0)) 在验量
            from pmdt_t left join pmds_t on pmdtdocno = pmdsdocno
            where pmdtdocno LIKE '%BJ%' and pmdsstus = 'Y' and pmdtsite='${this.site}'
             group by pmdt006 having sum(COALESCE(pmdt020,0)-COALESCE(pmdt054,0)-COALESCE(pmdt055,0))>0`;
            const tests = await this.ora(sql);
            const result: RowDict = {};
            for (const i of tests) result[i['PMDT006']] = i['在验量'];
            return result;
        });
    }

    async safetystock(): Promise<Row[]> {
        return this.cached('safetystock', async () => {
            const sql = `select imaf001,imaf026,imaf053 from imaf_t where imaf026>0 and imafsite='${this.site}'`;
            return this.ora(sql);
        });
    }

    async in_transit(): Promise<RowDict> {
        return this.cached('in_transit', async () => {
            const sql = `select pmdo001,sum(COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0)) as ztnum from pmdl_t,pmdo_t ,pmdn_t
            where pmdoent=pmdlent and pmdosite=pmdlsite and pmdodocno=pmdldocno and pmdndocno=pmdldocno and pmdnseq=pmdoseq
            and  pmdlstus ='Y' and pmdlsite='${this.site}' and pmdn045='1'
             and   substr(pmdldocno,4,4) not in (select pscc002 from  pscc_t where pscc001='${this.mrpVersion}'  and psccsite='${this.site}')
            and COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0)>0
            group by pmdo001`;
            const rows = await this.ora(sql);
            const result: RowDict = {};
            for (const i of rows) result[i['PMDO001']] = i['ZTNUM'];
            return result;
        });
    }

    async production_supply(): Promise<RowDict> {
        return this.cached('production_supply', async () => {
            const sql = `select sfac001,sum(sfac003-sfac005) qty from sfac_t,sfaa_t
            where sfacdocno=sfaadocno and sfaasite='${this.site}' and sfaastus in ('Y','F')
            and substr(sfaadocno,0,7) not IN ('${this.site}-GD04','${this.site}-GD09','${this.site}-GD10','${this.site}-GD15','${this.site}-GD19')
            group by sfac001`;
            const rows = await this.ora(sql);
            const result: RowDict = {};
            for (const i of rows) result[i['SFAC001']] = i['QTY'];
            return result;
        });
    }

    async substitute(): Promise<RowDict> {
        return this.cached('substitute', async () => {
            const sql = `select bmea001,bmea003,bmea008,bmea011,bmea012, bmea016, bmea007,bmea015
            from bmea_t  where bmea009 <SYSDATE and (bmea010 IS NULL OR bmea010 > sysdate)  and bmeasite='${this.site}'
            order by bmea015  desc`;
            const rows = await this.ora(sql);
            const result: RowDict = {};
            for (const i of rows) {
                const k = i['BMEA001'] + '_' + i['BMEA003'];
                if (!result[k]) result[k] = [];
                (result[k] as any[]).push(i);
            }
            return result;
        });
    }

    async purchase_order_detail(): Promise<RowDict> {
        return this.cached('purchase_order_detail', async () => {
            const sql = `
  select ooag013,ooag011,pmdo001,ztnum,ztnum as ztnum2,pmdl004,pmaal003,case when pmdlstus='N' then '未审核'||cgd else cgd end as cgd,
             pmdldocdt,pmdo013,
case when length(listagg(to_char(pmdacrtdt,'YYYY-MM-DD'),',') within group (order by pmdpdocno))>200 then listagg(to_char(pmdacrtdt,'YYYY-MM-DD'),',') within group (order by pmdpdocno) else '长度太长' end as  cjrq,
            pmdlstus ,pmdnua019 客户型号,pmdnua120 公司型号
            from(
             select distinct pmdl002,pmdo001,
             COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0) as ztnum,pmdl004,pmaal003,
              pmdldocno||'.'||pmdoseq||'.'||pmdoseq1||'.'||pmdoseq2 as cgd,
              pmdldocdt,pmdo013,pmdpdocno,pmdacrtdt,pmdlstus ,pmdnua019 ,pmdnua120
              from pmdo_t
              left join pmdl_t on pmdldocno=pmdodocno and pmdlent=pmdoent and pmdlsite=pmdosite
              left join pmdn_t on pmdndocno=pmdodocno and pmdnent=pmdoent and pmdnsite=pmdosite and pmdnseq=pmdoseq
              left join pmdp_t on pmdpdocno=pmdodocno and pmdpseq=pmdoseq
              left join pmda_t on pmdp003=pmdadocno and pmdpsite=pmdasite
              left join pmaal_t on pmaalent=pmdlent and pmaal001=pmdl004 and pmaal002='zh_CN'
             where pmdoent=5  and pmdosite='${this.site}' and pmdn045='1'
                and (COALESCE(pmdo006,0)-COALESCE(pmdo019,0)+COALESCE(pmdo017,0))>0
                and substr(pmdldocno,4,4) not in (select pscc002 from  pscc_t where pscc001='${this.mrpVersion}'  and psccsite='${this.site}')
                and  (pmdlstus ='Y' or pmdlstus ='N')
            union all
             select null pmdl002,pmdb004,pmdb006 - pmdb049 qty,'' pmdl004,'' pmaal003,
                    '请购'||pmdbdocno||'.'||pmdbseq cgd,pmdadocdt,null,pmdadocno,pmdacrtdt,pmdastus,null,null
                    from pmdb_t
                    left join pmda_t on pmdbsite = pmdasite and pmdbdocno = pmdadocno
                    where pmdbent = 5 and pmdb006 - pmdb049 > 0 and pmdb032 = '1'
                    and pmdastus = 'Y' and pmdbsite = '${this.site}'
         )
         left join ooag_t on ooag001 = pmdl002
         group by ooag013,ooag011,pmdo001,ztnum,pmdl004,pmaal003,cgd,pmdldocdt,pmdo013,pmdlstus,pmdnua019,pmdnua120
         order by pmdldocdt,cgd,pmdlstus`;
            const rows = await this.ora(sql);
            const result: RowDict = {};
            for (const i of rows) {
                if (!result[i['PMDO001']]) result[i['PMDO001']] = [];
                (result[i['PMDO001']] as any[]).push(i);
            }
            return result;
        });
    }

    async gd01(): Promise<RowDict> {
        return this.cached('gd01', async () => {
            const sql = `select sfaa010,sum(sfaa012-sfaa050) qty
                from sfaa_t
                where sfaasite='${this.site}'  and sfaastus in ('Y','F')
                and substr(sfaadocno,4,4) in ('GD01','GD16','GD35','GD36','GD30')  and sfaa012 -sfaa050>0
                group by sfaa010`;
            const rows = await this.ora(sql);
            const result: RowDict = {};
            for (const i of rows) result[i['SFAA010']] = i['QTY'];
            return result;
        });
    }

    async outsourcing_type(): Promise<RowDict> {
        return this.cached('outsourcing_type', async () => {
            const sql = `select imaa001,oocql004,imaa130 from imaa_t
            left join oocql_t on imaa128=oocql002 and oocql001='2004' and oocql003='zh_CN'`;
            const rows = await this.ora(sql);
            const result: RowDict = {};
            for (const i of rows) result[i['IMAA001']] = i;
            return result;
        });
    }

    async gd_bom(): Promise<RowDict> {
        return this.cached('gd_bom', async () => {
            const sql = `select sfaadocno 工单号,sfaa010 主件料号,sfaa012-sfaa050 未交量,sfba006 发料料号,sfba013/sfaa012 用量比例  ,
            sfba014 发料单位,'g'||sfbaseq 项次
            from sfaa_t
            left join sfba_t on sfaadocno=sfbadocno and sfaasite=sfbasite
            where sfaasite='${this.site}'  and sfaastus not in('X','C','M','N')
            and SFBA006!=sfaa010
            and sfaa012 -sfaa050>0 and sfba013>0
            and  substr(sfaadocno,0,7) not IN ('${this.site}-GD01','${this.site}-GD04','${this.site}-GD15','${this.site}-GD16','${this.site}-GD35','${this.site}-GD30','${this.site}-GD36')`;
            const rows = await this.ora(sql);

            const result: RowDict = {};
            for (const item of rows) {
                const partNumber = item['主件料号'];
                const workOrder = item['工单号'];
                if (!result[partNumber]) result[partNumber] = {};
                const key1 = workOrder + '_' + String(item['未交量']);
                if (!(result[partNumber] as any)[key1]) (result[partNumber] as any)[key1] = [];
                (result[partNumber] as any)[key1].push({
                    '主件': item['主件料号'],
                    '下阶': item['发料料号'],
                    'QPA': item['用量比例'],
                    '主件类别': 'W',
                    '下阶类别': 'W',
                    '发料单位': item['发料单位'],
                    '项次': item['项次'],
                });
            }
            const dd: RowDict = {};
            for (const i of Object.keys(result)) {
                const j = result[i];
                const d: Record<string, number> = {};
                for (const i1 of Object.keys(j)) {
                    const j1 = (j as any)[i1] as any[];
                    const sortedBom = [...j1].sort((a, b) => (a['下阶'] > b['下阶'] ? 1 : a['下阶'] < b['下阶'] ? -1 : 0));
                    const jj = JSON.stringify(sortedBom);
                    d[jj] = (d[jj] || 0) + Number(i1.split('_')[1]);
                }
                dd[i] = d as any;
            }
            return dd;
        });
    }
}
