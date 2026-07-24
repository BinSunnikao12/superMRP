# 设计评审 v0.3 —— 迭代记录 + 项目隔离 + 单角色聊天 + Skill/KB

> 状态：草案 → 本次落地【第 1 部分：PM 迭代记录】，其余为后续 Slice 的设计约定。
> 关联：`readme.md` §9.5（v0.3+ 路线图）、`src/orchestrator.ts`、`src/manager.ts`、`src/roles.ts`。

---

## 0. 背景与本文目的

现状（v0.2）：

- **PM 不是一个 AI，而是 `orchestrator.ts` 这段编排代码**。真正的 AI 调用有两类：
  - `manager.ts` 里的 `decomposeTask()` / `review()` —— 用 `tools: []` 的 PM 纯文本推理，**只输出 JSON，不碰文件**。
  - `worker.ts` 里的 `runWorker()` —— 每个岗位一次 `query()`，绑定一个账号 key，在 `workspace/` 里写真实文件。
- Web 后台（`web/` + `src/server/app.ts`）目前**只读**：Dashboard / 运行历史 / Run 详情 / SSE 事件流。

本文解决三件事，按优先级：

1. **【本次落地】** 每轮迭代后，在 `goals/<project>/iterations/` 自动生成一份「做了什么 / 没做什么 / 下一步」的迭代记录。
2. **【设计约定，后续实现】** 项目隔离（Slice 2）：每个项目独立 cwd / goals / skills / kb。
3. **【设计约定，后续实现】** Web Slice 3：单角色聊天 + 全局 Skill/KB 库 →「安装前预览确认」安装到项目。

---

## 1. PM 迭代记录（本次落地）

### 1.1 需求

用户希望：PM 角色在**每轮迭代结束后**，往 `goals/` 目录写一个文件，记录：

- **做了什么**（本轮各岗位产出、改动的文件）
- **什么没做 / 还缺什么**（PM 审查发现的缺口）
- **下一步要做什么**（下一批任务，或「收工」）

### 1.2 关键决策（已与用户确认）

> **由编排器确定性地写文件，而不是指望 PM 模型自己记得调 Write 工具。**

原因：当前 PM 调用是 `tools: []`，物理上没有写文件的能力；其输出还要被 `extractObjects()` 当 JSON 解析。让 PM「自己写文件」既不可靠（模型可能忘记、路径写错、破坏 JSON 解析），又要给 PM 放开 Write 工具、放宽 cwd 限制，得不偿失。

因此采用**混合**方案：

- **`roles.ts`**：在 PM system prompt 里**声明**「每轮结束你要产出一段结构化迭代总结」这项职责（满足用户「改岗位职责」的直觉，也让 PM 的 `review` 输出更聚焦）。
- **`manager.ts`**：新增 `summarizeIteration()`，让 PM 用一次纯文本调用产出 **Markdown**（不是 JSON）总结；**若模型输出为空/异常，orchestrator 用确定性模板兜底**，保证每轮必有记录。
- **`orchestrator.ts`**：在每轮 `review()` 之后调用写盘逻辑，落到 `goals/<project>/iterations/ROUND-<n>.md`。

### 1.3 落盘位置与格式

```
goals/
  gym-website/
    REQUIREMENTS.md
    DESIGN.md
    SPEC.md
    iterations/                 ← 新增
      ROUND-1.md
      ROUND-2.md
      ...
      LATEST.md                 ← 始终指向最近一轮（覆盖写，方便一眼看当前进度）
```

> 注意：`loadGoals()` 的 `fileWeight()` 已把 `^ROUND[-_]?\d+` 权重降到 20（最低），所以这些迭代记录**会被下一轮 PM 读到但排在最后**，形成「记忆」而不喧宾夺主。`iterations/` 是一层子目录，`loadGoals()` 的「一层子目录 .md 并入」逻辑天然覆盖它。

单个 `ROUND-N.md` 结构：

```markdown
# 第 N 轮迭代记录 · <projectId>

- runId: run-xxxx
- 时间: 2026-07-23 10:24:31
- 本轮账号并行数: 4 / 5
- 本轮 tokens≈: 123,456（累计 456,789）

## ✅ 做了什么
- [developer/acct1] 实现首页 Hero + 导航锚点（index.html, css/hero.css）
- [designer/acct2] 产出 4 级绿色色板与字体层级（design-tokens.css）
- ...

## ⚠️ 什么没做 / 还缺什么
（来自 PM 审查）
- 移动端 375px 断点下产品矩阵溢出，未处理
- 联系表单缺手机号格式校验

## ➡️ 下一步
- [developer] 修复 375px 产品矩阵栅格
- [tester] 针对表单补前端校验测试
（若 PM 判定收工，则显示「项目达成，收工」）
```

### 1.4 数据来源映射

| 记录区块 | 数据来源 |
|---|---|
| 元信息（runId/轮次/tokens） | orchestrator 循环内已有变量 |
| ✅ 做了什么 | 本轮 `results: WorkerResult[]` —— role/account/finalText 摘要 + **新增的 `changedFiles`** |
| ⚠️ 没做/缺什么 | `summarizeIteration()` 让 PM 从 goal + 本轮产出中提炼；兜底为「（本轮 PM 未给出缺口说明）」 |
| ➡️ 下一步 | `review()` 已返回的 `next: Task[]`（空数组=收工）|

为支持「做了什么」列出文件，`WorkerResult` 增补 `changedFiles?: string[]`（worker 已在内部用 `changedFiles` Set 收集，只需一并 return）。

### 1.5 改动清单（本次）

| 文件 | 改动 |
|---|---|
| `src/roles.ts` | PM prompt 增加「迭代记录」职责描述 |
| `src/worker.ts` | `WorkerResult` 增 `changedFiles?: string[]`；return 时带上 |
| `src/manager.ts` | 新增 `summarizeIteration(goal, results, next, round, account)` → Markdown 字符串（PM 调用 + 兜底） |
| `src/iterationLog.ts`（新） | `writeIterationRecord()`：组装 Markdown 落盘到 `goals/<project>/iterations/ROUND-N.md` + `LATEST.md` |
| `src/telemetry/eventTypes.ts` | 新增事件 `run.iteration`（round, recordPath, next 数）|
| `src/orchestrator.ts` | review 之后调用 `writeIterationRecord()` 并 `emit` 事件；把 project 目录路径解析出来 |

### 1.6 项目目录解析（本次最小实现）

当前 orchestrator `PROJECT_ID = "gym-website"` 是硬编码，`GOAL_INPUT` 默认是 `goals/` 整个目录。迭代记录需要一个「项目子目录」来放 `iterations/`。本次规则（保持向后兼容，Slice 2 再泛化）：

- 若 `GOAL_INPUT` 是**目录**且其下存在名为 `<PROJECT_ID>/` 的子目录 → 记录写到 `goals/<PROJECT_ID>/iterations/`。
- 若 `GOAL_INPUT` 是**单文件**（如 `goals/x.md`）→ 记录写到该文件同级的 `iterations/`。
- 兜底：写到 `goals/iterations/`。

---

## 2. 项目隔离（Slice 2 · ✅ 已落地）

目标：一套编排代码，多个项目互不干扰。**实现采用「就地按 id 命名空间」布局**（而非另起 `projects/` 顶层目录），对现有内容零搬迁、零风险。

### 2.1 目录布局（实际落地）

```
goals/                         ← legacy 项目 gym-website 的目标（根目录，保持原样）
  gym-website/iterations/      ← legacy 迭代记录
  <id>/                        ← 新项目 foo 的目标：goals/foo/ + goals/foo/iterations/
workspace/                     ← legacy gym-website 的产出（根 workspace，归它独占）
  <id>/                        ← 新项目 foo 的产出：worker cwd = workspace/foo
skills/<id>/                   ← 项目级技能（Slice 3 安装目标）
kb/<id>/                       ← 项目级知识库
.admin/events/                 ← 全局 telemetry（跨项目单流，每条事件带 projectId）
.admin/sessions/<id>/          ← 项目 session 元信息
library/skills, library/kb     ← 预留：Slice 3 全局库源目录（与 skills/<id> 不撞名）
```

### 2.2 关键决策（经三方架构评审 + 对抗式向后兼容审查）

- **中央路径模块 `src/projectPaths.ts`**：唯一路径真相源。纯函数 `resolveProject()`（不读 argv、无副作用）+ `parseCli()` + `ensureProjectDirs()` + `listProjects()`。
- **规范 legacy id = `gym-website`**：老用法（无参 / `goals/foo.md` / `goals/`）一律归到它名下，沿用根 `goals/` + 根 `workspace/`。**绝不用合成 `default`**——那会割裂历史 telemetry。根 workspace 明确归 gym-website 独占，不是共享。
- **新项目**（`--project foo`）：`goals/foo`、`workspace/foo`、`skills/foo`、`kb/foo`、`goals/foo/iterations`、`.admin/sessions/foo`。
- **零搬迁**：启动只 `mkdir -p`，绝不移动/覆盖任何已有文件。canonical 迁移留作日后可选命令。
- **telemetry 保持全局**：事件仍写 `.admin/events/`（单流），每条带 `projectId`；面板不变。**事件路径改为绝对**（`GLOBAL.eventsDir`），修掉「从别的 CWD 启动 server 读不到事件」的坑；并修复 tracker「目录不存在就永不 watch」的 bug。
- **路径穿越防护**：项目 id 严格正则 `^[a-z0-9][a-z0-9_-]{0,63}$`，`resolveProject` 对越出仓库根的路径抛错。

### 2.3 用法

```bash
npx tsx src/orchestrator.ts                    # legacy gym-website，用根 goals/ + workspace/
npx tsx src/orchestrator.ts goals/foo.md       # legacy，指定单目标文件
npx tsx src/orchestrator.ts --project foo      # 隔离项目 foo：goals/foo, workspace/foo, ...
npx tsx src/orchestrator.ts --project foo goals/foo.md   # 隔离项目 foo，指定目标路径
npx tsx src/orchestrator.ts --help             # 用法
```

### 2.4 新增 API（项目发现）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/projects` | 列所有项目摘要（相对路径，不泄露绝对路径） |
| GET | `/api/v1/projects/:id` | 单项目详情 + 六个目录相对路径 |
| GET | `/api/v1/runs?project=<id>` | 按项目过滤历史 run |

### 2.5 改动清单（Slice 2）

| 文件 | 改动 |
|---|---|
| `src/projectPaths.ts`（新） | 中央路径解析 + 发现 + CLI 解析 + 目录 ensure |
| `src/orchestrator.ts` | 删除硬编码 `WORKSPACE/PROJECT_ID/DEFAULT_GOALS_DIR/resolveProjectDir`，改用 resolver；RUN_REPORT 用 `RUN_REPORT_FILE` |
| `src/smoke.ts` | 改用 resolver，支持 `--project` |
| `src/iterationLog.ts` | 入参 `projectDir` → `iterationsDir`（消除双重 join） |
| `src/telemetry/{eventTypes,ui,fileTracker}.ts` | 事件路径改绝对 `GLOBAL.eventsDir`；tracker 先 `mkdir` 再 watch |
| `src/server/app.ts` | 新增 `/api/v1/projects[/:id]` + `?project=` 过滤；`.admin/events` 字面量改 `GLOBAL.eventsDir` |
| `web/src/api/client.ts` | 新增 `ProjectSummary/ProjectDetail` + `listProjects()/getProject()` |
| `tests/`（新） | 纯解析器 26 条断言 + PM overhaul 23 条单测 |

> roadmap（未做）：角色 / provider CRUD（`src/roles.ts` 静态表 → 可持久化配置）。

---

## 3. Web Slice 3 · 单角色聊天 + Skill/KB + 安装前预览确认（✅ 已落地）

### 3.1 单角色聊天（`src/chat.ts` + `POST /api/v1/chat`）

在后台里对**单个角色**发起一次性对话（不走完整 orchestrator 编排），用于调试岗位 prompt / 让某角色单独干一件小事 / 快速问答。

- `src/chat.ts`：`async function* chat({role, projectId, message, resume?, accountId?, allowWrite?})` —— 包一层 `query()`，以 async generator 逐块吐 `text` / `tool` / `done`。
- **安全**：默认只读工具（`Read/Glob/Grep`），cwd 限定项目 `workspace/`；`allowWrite=true` 才放开 `Write/Edit`。不给 `Bash`。

#### 3.1.1 聊天记录持久化 + 项目记忆（Slice 3.1，✅ 已落地）

用户反馈：① 聊天记录刷新就没了，要作为**项目资产**存下来；② 角色要**记得这个项目做过什么**。

- **持久化（`src/chatStore.ts`）**：一个「会话线程」= 一个 JSON 文件，落 `.admin/sessions/<projectId>/chats/<threadId>.json`（`.admin` 已 gitignore，持久但不进版本库）。存 role/title/时间/SDK sessionId/消息数组。服务端在 `/chat` 里自动把**用户消息 + 助手回复 + 工具调用**追加落盘；首条用户消息自动做标题。
- **项目记忆（`src/projectMemory.ts`）**：把散落磁盘的项目资产汇总注入 chat system prompt——
  - `goals/<id>/iterations/LATEST.md` + `ROUND-*.md`（PM 每轮「做了什么/没做什么/下一步」）
  - `workspace/<id>/RUN_REPORT.json`（轮数、token、各角色产出）
  - `workspace/<id>/**` 产出文件树（限深 3 / 60 项）
  实测：问 developer「你们对这个项目做了什么」，能准确答出「2 轮迭代、5 角色、9 区块、CSS/JS 模块、SVG 资源、README、测试报告」。
- **跨重启连续性**：SDK 的 `resume`（sessionId）在 server 重启后会失效；因此打开旧线程发消息时，把**磁盘里的历史消息重放进 prompt**，保证话题连续。
- 新增线程路由：`GET/POST /api/v1/projects/:id/threads`、`GET/DELETE …/threads/:threadId`；`/chat` 增加 `threadId` 入参并先发 `thread` 事件告知前端线程 id。
- 前端 `Chat.tsx` 重做：左栏会话线程列表（可切项目/新建/删除），点开加载历史，刷新不丢。

- **上下文注入**：把该项目已安装的 skill/kb 内容拼进 system prompt（各截断 2000 字）。
- **多轮**：`done` 事件带 `sessionId`，前端下一句用它 `resume`。
- 后端 `POST /api/v1/chat` 用 `streamSSE` 转发；前端用 `fetch + ReadableStream` 读（`EventSource` 不支持 POST body）。
- 前端页「💬 单角色聊天」：选角色 + 选项目 + 只读/写开关 + 流式气泡 + Cmd/Ctrl+Enter 发送。

### 3.2 全局 Skill/KB 库 →「安装到项目」（`src/skillStore.ts`）

> **「安装」= 把全局库里的一个 skill/kb 条目（一个 .md 文件）复制进某个项目的 `skills/<id>/` 或 `kb/<id>/`。**

```
library/skills/<name>.md     ← 全局技能库（源，Slice 2 已预留命名空间）
library/kb/<name>.md         ← 全局知识库（源）
skills/<projectId>/<name>.md ← 安装目标（副本）
kb/<projectId>/<name>.md
```

数据模型（v1 最简、可安全 CRUD）：一个条目 = 一个 `.md` 文件；条目名严格正则 `^[a-z0-9][a-z0-9_-]{0,63}$`，禁止 `..`、`/`、`\`；所有读写 assert 落在仓库根内。

后端路由（`src/server/app.ts`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/library/:kind` | 列全局库条目（kind = skill\|kb） |
| GET | `/api/v1/library/:kind/:name` | 读单条内容 |
| PUT | `/api/v1/library/:kind/:name` | 新增/覆盖（upsert） |
| DELETE | `/api/v1/library/:kind/:name` | 删除 |
| GET | `/api/v1/projects/:id/installed/:kind` | 列某项目已安装 |
| GET | `/api/v1/install-preview?kind=&name=&project=` | **预览**（不写盘） |
| POST | `/api/v1/install` | 确认安装（可带 `confirmOverwrite`） |
| GET | `/api/v1/roles` | 可选角色列表（给聊天下拉） |

### 3.3 安装前预览确认（交互）

1. 用户在库里点某条目的「装 ⤵」。
2. 前端调 `install-preview` → 后端返回 `action`：
   - `new`：项目里还没有 → 弹窗显示「将写入的内容」。
   - `overwrite`：已存在且不同 → 弹窗**并排 diff**（项目现有版本 vs 库版本）。
   - `identical`：内容一致 → 标「无需安装」，不给确认按钮。
3. 用户确认 → `POST /install`（overwrite 场景自动带 `confirmOverwrite=true`）真正落盘；取消 → 什么都不动。
4. **服务端二次保护**：`install()` 内部若发现 overwrite 但未带 `confirmOverwrite`，直接抛错——即使有人跳过预览直接打 API 也不会误覆盖。
5. worker/chat 运行该项目时，从 `skills/<id>/`、`kb/<id>/` 读到已安装内容。

### 3.4 安全边界（沿用现状）

- 全部只本机 `127.0.0.1`，不认证、不上云。CORS 显式放开 `GET/POST/PUT/DELETE`。
- 写路由限定在 `library/` `skills/` `kb/` 白名单目录内，条目名 + 路径穿越（`..`）双重拒绝（已测：`../../etc/passwd` 被拦）。

### 3.5 改动清单（Slice 3）

| 文件 | 改动 |
|---|---|
| `src/skillStore.ts`（新） | 全局库 CRUD + install-preview + install（路径守卫） |
| `src/chat.ts`（新） | 单角色流式聊天（async generator） |
| `src/server/app.ts` | 新增 library/install/chat/roles 路由；CORS 放开写方法 |
| `web/src/api/client.ts` | 新增 library/install/chat/roles 客户端函数 + 类型 |
| `web/src/pages/Library.tsx`（新） | 库管理 + 编辑器 + 安装预览弹窗（并排 diff） |
| `web/src/pages/Chat.tsx`（新） | 单角色聊天页（fetch+ReadableStream 读 SSE） |
| `web/src/App.tsx` | 侧栏加「💬 单角色聊天」「📦 Skill/KB 库」 |
| `web/src/styles.css` | 按钮/输入/弹窗/diff/聊天气泡样式 |

### 3.6 验证结果

- ✅ src + web 双 typecheck 通过；`vite build` 通过（38 模块）。
- ✅ 库 CRUD → install-preview(new) → install → installed 列表 → 再 preview(identical) 全链路实测。
- ✅ overwrite 守卫：preview 出 diff、无 confirm 被拒、带 confirm 成功覆盖。
- ✅ 路径穿越 `../../etc/passwd` 被拒；chat 非法 role / 空消息被拒。
- ✅ chat SSE 真实模型联调：`text` 流 + `done`（带 sessionId / token 数）。

---

## 4. 落地进度

1. ✅ 第 1 部分（PM 迭代记录）。
2. ✅ Slice 2 项目隔离（`--project` + 中央 projectPaths + 项目发现 API）。
3. ✅ Slice 3（单角色聊天 + Skill/KB 库 + 安装前预览确认）。
4. ⏳ 角色 / provider CRUD。
5. ⏳ v1.1：OpenAI 协议 provider 接入。

