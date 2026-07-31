# APS MRP - Node.js + TypeScript 复刻版（Docker 化 + 下载服务）

> 完整复刻同目录 `../python/` 下 Python APS MRP 系统的所有业务逻辑，
> 并升级为 **Docker Compose 编排**（MRP 服务 + MySQL 8.0 容器，共享 `aps-net` 网络）。
> 跑完任务后内置 **HTTP 下载服务**，浏览器/curl 即可拿报告。
>
> 在此版本基础上做了 5 项关键优化（详见 [优化点](#优化点)）。

## 目录结构

```text
nodejs_ts/
├── src/
│   ├── main.ts            # 入口：5 基地并发跑，跑完启 HTTP 服务
│   ├── config.ts          # 配置中心（统一从 env 读）
│   ├── cache/
│   │   └── ttlLru.ts      # LRU + TTL 缓存（10 分钟 TTL，命中率统计）
│   ├── excel/
│   │   └── excel.ts       # Excel 报告生成（流式 writeBuffer）
│   ├── compute/
│   │   ├── compute.ts     # MRP 运算核心
│   │   └── methods.ts     # BOM 展开工具
│   ├── httpServer.ts      # 报告下载服务（Node 原生 http）
│   └── data/
│       ├── dataOracle.ts  # Oracle ERP（连接池 + 缓存）
│       ├── dataMysql.ts   # MySQL 配置 + 回写
│       ├── dataMes.ts     # 低代码平台 MES
│       └── dbPools.ts     # 三个连接池统一管理
├── Dockerfile             # 多阶段构建
├── docker-compose.yml     # mrp-mysql + aps-runner 编排
├── .env.example           # 环境变量样例
├── package.json
├── tsconfig.json
└── README.md
```

## 与 Python 版的关键映射

| Python | Node.js / TypeScript |
| --- | --- |
| `openpyxl` | `exceljs`（流式 writeBuffer） |
| `cx_Oracle` | `oracledb`（thin mode + 连接池） |
| `pymysql` | `mysql2/promise`（连接池） |
| `pandas` | 纯逻辑 SimpleDataFrame |
| `datetime` | `dayjs` |
| `math.ceil` | `Math.ceil` |
| `inf / isnan / isinf` | `Number.POSITIVE_INFINITY / Number.isNaN / Number.isFinite` |

## 快速开始

### 1. 本地开发

```bash
cd nodejs_ts
cp .env.example .env
# 改 .env：MRP_ORACLE_CONNECT_STRING / MRP_MES_* 等
npm install
npm run build
npm start
```

### 1.5 单表拉取（imaf_t 物料主档）

```bash
# 只拉物料主表 raw_base：5 个基地并发，全量约 200 万行
# 全部成功后清理源端已删除的旧行，并逐站核对本地总数
npm run pull:raw-base

# 拉取进度查看
npm run admin  # 浏览器 http://localhost:8080/
```

拉取后 raw_base 会有 imafsite + 中文 label 列（料件编号/品名/规格/补给策略/...），pull_state 表记每个基地的 last_successful_time。

该命令会先自动执行 TypeScript build，避免误跑旧的 `dist`。
同步使用固定时间窗口；只有分页总数完全吻合时才推进水位。
如果任一站点超时、漏页或入库失败，命令会以非 0 状态退出，并保留该站点原水位供下次重跑。

> 固定窗口依赖低代码接口支持 `upperPullTime`。本地
> `CE/ApiV8Code/鼎捷模块/tiptop_query_imaf_t.js` 更新后，需要先 push 到平台。

### 2. Docker 一键起

```bash
cd nodejs_ts
cp .env.example .env
docker compose up -d --build
# 第一次启动会下载 mysql:8.0 镜像 + 构建 aps-runner 镜像
```

```bash
# 查看日志
docker compose logs -f aps-runner

# 跑完后浏览器打开
open http://localhost:8080

# 单独重跑任务
docker compose restart aps-runner
```

### 3. 本地查看结果

跑完任务后：

```bash
# 浏览器（推荐）
open http://localhost:8080

# 文件清单（JSON）
curl http://localhost:8080/api/files

# 单个基地清单
curl http://localhost:8080/api/files/LG

# 下载指定文件
curl -OJ "http://localhost:8080/api/download/LG/LG_250728120000.xlsx"

# 健康检查
curl http://localhost:8080/health

# 文件本地路径（容器外）
ls -la ./output/LG/
ls -la ./output/YN/
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 简易 HTML 下载页（点击文件名下载） |
| GET | `/health` | 健康检查 + 缓存命中率 |
| GET | `/api/sites` | 已配置的基地列表 |
| GET | `/api/files` | 所有基地的文件清单（按时间倒序） |
| GET | `/api/files/:site` | 单个基地的文件清单 |
| GET | `/api/download/:site/:f` | 下载指定 xlsx（Content-Disposition: attachment） |
| DELETE | `/api/files/:site/:f` | 删除指定文件 |

**示例响应 `/api/files`：**

```json
{
  "LG": [
    {
      "name": "LG_250728120000.xlsx",
      "size": 482301,
      "mtime": "2026-07-28T12:00:32.000Z"
    }
  ],
  "YN": [
    {
      "name": "YN_250728120015.xlsx",
      "size": 312889,
      "mtime": "2026-07-28T12:00:47.000Z"
    }
  ]
}
```

## 优化点

| # | 优化 | 收益 | 实现 |
| --- | --- | --- | --- |
| 1 | **Oracle/MySQL/MES 连接池** | 每次不再新建连接，并发从 1 提到 poolSize | `src/data/dbPools.ts` |
| 2 | **LRU + TTL 缓存** (10 分钟) | 多基地连跑时只查一次 Oracle；命中率高时基本零 DB 压力 | `src/cache/ttlLru.ts` |
| 3 | **5 基地 `Promise.allSettled` 并发** | 总耗时从 Σ(t_i) 降到 ≈ max(t_i) | `src/main.ts` |
| 4 | **BOM 静态数据外置缓存** | bom_dict / gd_bom_dict 跨基地复用 | `dataOracle.cached()` |
| 5 | **Excel 流式 writeBuffer** | 大文件不一次性驻留内存 | `src/excel/excel.ts` |

> **关于 BOM 展开 memoize 的取舍**：原版会"扣库存"——
> 同一 `(主件, 数量)` 第二次展开时剩余库存已被前一次扣减，结果必然不同。
> 简单 memoize 会算错业务。优化点放在"不变量"上（`bom_dict` 静态数据），
> 是更稳妥的选择。

## 缓存命中率

`main.ts` 会在跑完打印缓存命中率：

```text
[main] 缓存命中率: 87.3% (335/384)
```

调高 `CACHE_TTL_SECONDS` 和 `CACHE_MAX_ENTRIES` 可以命中更多；调低则更"新鲜"。

## 数据库选型说明

**为什么 MySQL 容器，不用 SQLite：**

- MRP 每天写 mrp/zj_data/cg_data 三张表，**单次 5~10 万行**；
- MySQL 8.0 InnoDB 多核并发写 + 大缓冲池（compose 里默认 1G）扛得住；
- SQLite 在多基地并发 + 大量 INSERT 时会触发 SQLITE_BUSY 锁等待；
- 业务侧（leadtime_conf / holiday 等配置）也用 MySQL，便于统一运维。

## 网络架构

```text
            ┌────────────┐
            │  aps-net   │  (bridge, name=aps-net)
            └─────┬──────┘
       ┌─────────┴─────────┐
       │                   │
┌──────┴──────┐    ┌───────┴────────┐
│  mrp-mysql  │    │   aps-runner   │
│  MySQL 8.0  │◄───│  APS MRP 任务  │
│  :13306→3306│    │  5基地并发     │
└─────────────┘    │  + HTTP下载   │
                  │  :8080        │
                  └────────────────┘
                       │
                       ├──► Oracle ERP  (10.x.x.x:1521)
                       ├──► MES 低代码  (10.x.x.x:3306)
                       └──► 输出到 /data/output (挂 ./output)
```

## 常见问题

### 看不到 Excel 文件

- 任务是否真的跑完？看 `docker compose logs aps-runner` 最后是否有 `缓存命中率` 那行
- 端口是否被占用？改 `APS_HTTP_PORT=8081` 然后重启
- 容器内文件路径：`docker compose exec aps-runner ls /data/output/LG/`

### MySQL 连不上

```bash
docker compose ps           # 看 mrp-mysql 是否 healthy
docker compose logs mrp-mysql
docker compose exec mrp-mysql mysql -uroot -p"loctek@2023" -e "SHOW DATABASES;"
```

### Oracle 客户端连不上

thin mode 不需要 instantclient，但需要 `MRP_ORACLE_CONNECT_STRING` 用 EZCONNECT 格式：

```text
MRP_ORACLE_CONNECT_STRING=192.168.0.199:1521/topprd
```

如果公司 VPN/防火墙不通，容器会卡在 Oracle pool init；MRP 任务会卡住，但 HTTP 服务能起来（健康检查仍通过），可以先看报告历史。

### 想关掉常驻服务，跑一次就退

把 `main.ts` 里最后 `startHttpServer` 那段挪到 `if (process.env.APS_ONE_SHOT) { ... }` 里，或加 `--once` 命令行参数。
