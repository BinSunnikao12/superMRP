# 多 Agent 编排系统 —— 使用手册

一个「项目经理（PM）+ 多岗位并行」的自动化系统。你给一个项目目标，PM 自动拆解成任务，
用你的 5 个 MiniMax 账号**并行**分派给「开发 / 设计 / 测试 / 文案」等角色去做，做完 PM 审查再决定下一轮，
直到项目完成、到达时限、或预算耗尽。目标是让它**连续无人值守工作数小时**，且这套流程**换个项目就能复用**。

---

## 0. 一句话架构

> **"项目经理"不是一个 AI，而是这段编排代码本身**（`orchestrator.ts`）。
> 它做确定性的调度；每个"打工的"角色才是一次真正的 AI 调用（`worker.ts` 里的 `query()`），
> 每个 worker 绑定一个不同的账号 key —— 这就是"5 个账号一起干活"的实现方式。

```
你写目标(goals/*.md)
      │
      ▼
 orchestrator ── PM拆解 ──▶ [任务1 任务2 任务3 任务4]
   (调度代码)                 │    │    │    │
                          acct1 acct2 acct3 acct4   ← 5个账号并行，各用各的key
                             │    │    │    │
                             ▼    ▼    ▼    ▼
                          都在 workspace/ 里写真实文件
                             │
                          PM审查 ──▶ 还缺就再派一轮，够了就收工
```

---

## 1. 首次准备

```bash
cd /Users/maojiashun/study/mixed
npm install                 # 只需一次
cp .env.example .env        # 已经建好；把 5 个 MINIMAX_KEY_ 填成你的真实 key
```

`.env` 关键项：

| 变量 | 作用 | 默认 |
|---|---|---|
| `MINIMAX_KEY_1..5` | 5 个账号 key（填几个就用几个） | — |
| `KEY_FALLBACK` | `on`=某个 key 用完自动换下一个，全用完才停；`off`=只用第 1 个 | `off` |
| `PER_KEY_TOKEN_BUDGET` | 每个 key 的 token 预算（达到即视为耗尽） | `1000000` |

---

## 2. 怎么跑起来

**先冒烟（强烈建议，10 秒确认环境没问题）：**

```bash
npx tsx src/smoke.ts
```

看到 `✅ 冒烟通过` + `workspace/hello.html` 出现，就说明 key、端点、文件写入都正常。

**正式启动（跑健身房官网这个练手项目）：**

```bash
npm start
# 等价于 npx tsx src/orchestrator.ts
```

**换成你自己的项目**：写一个新的目标文件，把路径传进去：

```bash
npx tsx src/orchestrator.ts goals/我的项目.md
```

**常用调参（环境变量，临时覆盖）：**

```bash
# 开启多 key 轮换，每个 key 上限 80万 token，最长跑 10 小时
KEY_FALLBACK=on PER_KEY_TOKEN_BUDGET=800000 LIMIT_MIN=600 npm start

# 快速试跑：最多 2 分钟、最多 2 轮
LIMIT_MIN=2 MAX_ROUNDS=2 npm start
```

| 环境变量 | 含义 | 默认 |
|---|---|---|
| `LIMIT_MIN` | 最长运行分钟数（10 小时 = 600） | `600` |
| `TOKEN_BUDGET` | 全局 token 总预算 | `8000000` |
| `MAX_ROUNDS` | 最多多少轮 PM 拆解-执行 | `20` |
| `KEY_FALLBACK` / `PER_KEY_TOKEN_BUDGET` | 见上表 | — |

---

## 3. 怎么判断"它在跑 / 跑到哪了"

系统会把**每个角色的实时动作**写进 `logs/<角色>.md`，边跑边追加。判断手段：

**A. 实时观战（最常用）** —— 开另一个终端：
```bash
cd /Users/maojiashun/study/mixed
tail -f logs/*.md            # 同时盯所有角色
tail -f logs/pm.md           # 只盯项目经理的调度决策
```
你会看到类似：
```
[10:24] 📋 拆解出 4 个任务
[10:24] —— 第 1 轮：计划并行 4 个任务（可用账号=5/5）——
[developer] 🔧 Write({"file_path":".../index.html"...})
[designer]  💬 已完成配色与排版规范...
[pm] 🔎 第 1 轮审查：项目达成，收工
```
- `🔧` = 某角色在调用工具（写文件 / 跑命令）
- `💬` = 角色在说话（阶段小结）
- `✅` = 该角色本轮完成（带 token 数）
- `pm` 里的 `——第N轮——`、`审查` = 调度进展

**B. 看产出长没长** —— 文件在变多/变大就是在干活：
```bash
ls -la workspace/            # 网站文件都生成在这
```

**C. 看进程还在不在**：
```bash
ps aux | grep "tsx src/orchestrator" | grep -v grep
```

**D. 跑完的总结** —— 结束后看：
```bash
cat workspace/RUN_REPORT.json    # 几轮、总token、每个key各花多少、各角色产出
```

**判断"卡住了"**：如果 `tail -f` 超过 3~5 分钟没有任何新行，且进程还在，多半是某个 worker 卡在长响应或限流。见下一节干预。

---

## 4. 怎么干预它

### 4.1 停止

- **前台运行**：在那个终端按 `Ctrl + C`。
- **后台/找不到终端**：
  ```bash
  pkill -f "tsx src/orchestrator"     # 停掉编排器
  # 或更精准：
  ps aux | grep "tsx src/orchestrator" | grep -v grep   # 拿到 PID
  kill <PID>
  ```
- 停止是**安全的**：已经写到 `workspace/` 的文件都在，不会回滚。

### 4.2 中途改方向

系统是"一轮一轮"跑的，**每轮之间**是天然的干预点：

1. **改目标**：编辑 `goals/xxx.md`（改需求），下次启动生效。
2. **改角色能力/语气**：编辑 `src/roles.ts` 里对应角色的 system prompt。
3. **直接改产出**：`workspace/` 里的文件你可以手动改，下一轮 worker 会读到你改过的版本（它们被要求"先看已有文件再动手"）。
4. **加/减账号**：编辑 `.env` 的 `MINIMAX_KEY_`。
5. **控制花费**：调小 `TOKEN_BUDGET` 或 `PER_KEY_TOKEN_BUDGET`，防止跑太久烧太多。

### 4.3 限流 / 某个 key 挂了怎么办

- 开 `KEY_FALLBACK=on`：某个 key 报配额/429 错误时，`worker.ts` 会自动 `markExhausted` 把它踢出，
  后续轮次自动改用其它活着的 key；**5 个全耗尽**才会优雅停机（日志里会打 `🔚 所有 key 都已耗尽`）。
- 想临时只用某几个 key：把 `.env` 里不想用的那几行 `MINIMAX_KEY_` 留空即可。

### 4.4 安全边界（重要）

- worker 以 `permissionMode: bypassPermissions` 无人值守运行，**不会弹权限确认**。
- 用两道栏收敛风险：① 每个 worker 的 `cwd` 被限定在 `workspace/`；② 只开放 `Read/Write/Edit/Bash/Glob/Grep`，**不给联网工具**。
- 尽管如此，`Bash` 仍有一定风险 —— **首次跑新项目时，建议用 `tail -f logs/*.md` 盯前 10 分钟**，确认行为正常再离开。

---

## 5. 预览产出（健身房官网）

```bash
cd workspace
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080  （或直接双击 workspace/index.html）
```

---

## 6. 文件地图（想改哪、看哪）

| 文件 | 作用 | 你可能要改 |
|---|---|---|
| `.env` | 5 个 key + 开关 | ✅ 填 key、调预算 |
| `goals/*.md` | 项目需求 | ✅ 换项目就写新的 |
| `src/roles.ts` | 各角色 system prompt | ✅ 调岗位/语气 |
| `src/orchestrator.ts` | 主循环、调度、停止闸门 | 进阶：改并发/轮次逻辑 |
| `src/worker.ts` | 单次 AI 调用封装 + 限流兜底 | 进阶：改工具白名单 |
| `src/manager.ts` | PM 拆解 / 审查（出 JSON） | 进阶：改拆解策略 |
| `src/accountPool.ts` | 账号轮换与耗尽跟踪 | 一般不用改 |
| `src/config.ts` | 端点、模型、账号读取 | 换模型/端点时 |
| `src/log.ts` | 日志落盘 | 一般不用改 |
| `logs/*.md` | 实时运行流水 | 只读，用来观战 |
| `workspace/` | 所有产出 + RUN_REPORT.json | 产物；可手动改 |

---

## 7. 复用到别的项目

1. `goals/新项目.md` 写需求。
2. （可选）`src/roles.ts` 增删岗位，比如加个 `"reviewer"`（记得在 `RoleName`、`ROLE_PROMPTS`、
   `manager.ts` 的 `VALID_ROLES` 三处同步）。
3. `npx tsx src/orchestrator.ts goals/新项目.md`。

调度、并行、多 key 轮换、时限/预算闸门全部照旧复用。

---

## 8. 已知限制 / 排错

| 现象 | 原因 / 处理 |
|---|---|
| 冒烟 `tokens=0` | SDK 版本要 ≥0.2.73（本项目已装 0.3.x）；或 key 错。 |
| PM "拆解出 0 个任务" | MiniMax-M2 偶尔输出被截断。日志会打印它的原始输出；重跑一次通常就好。 |
| 某角色一直没动静 | 可能限流。开 `KEY_FALLBACK=on` 让它换 key；或 `Ctrl+C` 重跑。 |
| 想更省钱 | 调小 `TOKEN_BUDGET`、`MAX_ROUNDS`；或减少 `goals` 里的栏目。 |
| macOS 下子进程静默退出 | 不要用 `sandbox-exec` 包裹本程序（已知与 SDK 冲突）。 |

---

## 9. v0.2 — 后台面板（Web Admin）

在命令行编排器之上，加了**可视化后台**：在浏览器里看每个 run、每个 role、每个账号的实时用量，
点 runId 可以看实时事件流。**只本机访问**（`127.0.0.1`），不上云、不需认证。

### 9.1 启动

需要开 2~3 个终端：

```bash
# 终端 1：跑编排（和 v0.1 完全一样）
npm start                                # 跑默认项目

# 终端 2：跑后台 API（127.0.0.1:8787）
npm run server

# 终端 3：跑前端开发服务器（Vite，127.0.0.1:5173，代理 /api 到 8787）
npm run web

# 然后浏览器打开 http://127.0.0.1:5173
```

或者不写代码就只要看仪表盘：

```bash
npm run server &     # 后台
npm run web          # 前台
# 浏览 http://127.0.0.1:5173
```

### 9.2 你能看到什么

- **Dashboard**：
  - 5 张 KPI：账号数、累计 tokens（按 role/按 key）、live run 数、历史 run 数、`KEY_FALLBACK` 状态
  - **用量占比条**：按 role、按 key（含 `已用/预算%` 进度条，超过 70% 转黄、>90% 转红）
  - 最近 5 个 run 的链接
- **运行历史**：所有本月 run 的表格，点击进详情
- **Run 详情**：
  - 状态徽章、当前轮、总 tokens、停止原因
  - 按 role / 按 account 的 token 分布
  - **实时事件流**（SSE）：run.task.start / text / tool / done / account.exhausted
  - 心跳保活，client 断开自动清理

### 9.3 怎么工作的（架构 1 分钟）

```
  orchestrator (npm start)         后台 API (npm run server)         Web (npm run web)
        │                                │                                │
        ├── emit() ──▶ .admin/events/ ◀── fileTracker tail ──▶ 内存 map ──┤
        │              usage-YYYY-MM.jsonl  （冷启动回放当月）              │
        │                                ├── streamSSE ──────────────────┤
        │                                │  GET /api/v1/runs/:id/events   │
        │                                │                                │
        └── writeFile RUN_REPORT.json ───┴── readFile ──▶ runs 列表 ──────┘
```

**关键：编排器是真相源，文件是事件日志，server 只是 tail + 投影**。所以：
- 你可以只跑 server + web，不跑 orchestrator（看历史）
- 你可以只跑 orchestrator，不跑 server/web（用 `tail -f logs/*.md`）
- 两个进程是**完全解耦**的，没有任何 socket 直连

### 9.4 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/whoami` | 心跳 / 版本 |
| GET | `/api/v1/orchestrator/status` | 账号、key_fallback 开关、live run 摘要、池快照 |
| GET | `/api/v1/runs` | 本月所有 run 列表（重建自 JSONL） |
| GET | `/api/v1/runs/:runId` | 单个 run 详细快照（从 JSONL 聚合） |
| GET | `/api/v1/runs/:runId/events` | **SSE**：该 run 的实时事件流 |
| GET | `/api/v1/stream` | **SSE**：所有 run 的全局事件流 |
| GET | `/api/v1/usage?groupBy=role\|account\|project` | 用量聚合 |

事件流的事件类型：`run.start` / `run.round` / `run.task.start` / `run.task.text` / `run.task.tool` / `run.task.done` / `run.task.error` / `run.round.done` / `run.done` / `account.exhausted`。心跳 `ping` 15s 一次。

### 9.5 之后要做的（v0.3+）

- ✅ **PM 迭代记录**：每轮结束自动在 `goals/<项目>/iterations/ROUND-N.md`（+ `LATEST.md`）写「做了什么 / 什么没做 / 下一步」。由编排器确定性落盘，PM 负责「缺口」分析。
- ✅ **Slice 2 项目隔离**：`--project <id>` 选项目；每个项目独立 goals/workspace/skills/kb/iterations/session，互不干扰。老用法（无参 / `goals/foo.md`）自动归 legacy 项目 `gym-website`，零搬迁。新增 `/api/v1/projects` 项目发现。
- ✅ **Slice 3 单角色聊天 + Skill/KB 库 + 安装前预览确认**（后台新增两页）：
  - 「💬 单角色聊天」：选角色 + 项目，流式对话；默认只读工具、cwd 限项目 workspace；已安装 skill/kb 自动作上下文。
  - 「📦 Skill/KB 库」：全局库 CRUD；「安装到项目」前先预览（新增/覆盖-并排 diff/内容一致），确认才落盘。
- ⏳ 角色 / provider CRUD
- ⏳ OpenAI 协议 provider 接入（v1.1）

详见 `docs/DESIGN-v0.3.md`（设计评审）。
