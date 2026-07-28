# 集团 MRP 系统需求 v0.6（开发就绪版 · MVP-1）

> **演进**：v0.5 已归档到 [archive/v0.5-2026-07-24.md](./archive/v0.5-2026-07-24.md)
> **当前版本**：v0.6 — 2026-07-24
> **本次关键变化**（v0.5 → v0.6）：
> 1. 新增 §12 工程规范：**`src/mrp/` 下所有代码必须使用中文注释**（函数说明、参数解释、TODO、文件头注释都需中文）
> 2. §4 代码骨架前增加"中文注释"提示
> 3. 历史记录新增 v0.6 条目

---

## 0. 一句话定位

实现 MRP 核心算法：**主计划 → 第一层毛需求 → 净需求（含自制/采购优先级）→ 多角贸易识别**。

**MVP-1 范围**：1 据点（LG），单层 BOM 演示（最深 3 层），手工 Excel 上传主计划 + JSON 静态基础资料 → 点击"运行"→ 看净需求表（含优先级拆解）。预计 4 周完成。

---

## 1. 完整需求分解流程（图 4）

```
              主计划 A
                ↓
        ┌───────┴────────┐
        ↓                ↓
   自制备料 B         外购备料 E
        ↓                ↓
   是否存在制工单?   是否存在多角需求?
        ↓                ↓
   是否存在途订单?   是否存在制工单?
        ↓                ↓
   ┌────┼────┐         ┌──┼──┐
   工单  采购  展开     工单  多角  外购
   余量  订单  BOM      余量  贸易  需求
                              ↓
                          是否自制?
                          ┌───┴──┐
                          ↓      ↓
                       其他据点  其他据点
                       自制需求  采购需求
                          ↓
                       ┌──┼──┐
                       工单  展开
                       余量  BOM
```

> 完整图见 [`02-...-assets/image-full-decompose-flow.png`](feishu-originals/02-集团MRP需求分解与执行系统需求文档-assets/img3.png)

---

## 2. 核心算法（飞书文档 2 + 4 张图）

### 2.1 时间倒推（前置）

```
第一层:
  预计完工时间 = 主计划 A 的开工时间
  预计开工时间 = 预计完工时间 - 生产提前期/采购提前期

下阶:
  预计完工时间 = 上一层开工时间
  预计开工时间 = 预计完工时间 - 生产提前期/采购提前期
```

### 2.2 净需求公式

```
净需求[头层] = 毛需求 - 领用在制 - 库存 - 多角在途
净需求[下阶] = 上层净需求 × BOM用量 - 领用在制 - 库存 - 多角在途
```

### 2.3 自制物料优先级（图 1）

```
净需求 B=100（自制）
        ↓
   B 下阶毛需求: B1=100, B2=200, B3=300（按 BOM 用量 × B 净需求）
        ↓
   B 下阶可用供给:
     领用在制: B1=20, B2=30, B3=60（先消耗）
     库存数量: B1=100, B2=50, B3=60（再消耗）
        ↓
   最终净需求: B1=0, B2=120, B3=180
```

### 2.4 采购物料优先级（图 2）

```
采购件 D=100
        ↓
   ┌─ 自制工单 D=30（依净需求方法拆解）─┐  ┌─ 采购需求 D=70（外购请购单）─┐
```

### 2.5 多角贸易（图 3）

```
LG 采购需求 S=1000
        ↓
   是否存在多角?
     ┌─ 是 → GX 自制需求 S=800 (S1=800, S2=400, S3=1600)
     └─ 否 → GN 净需求 S=200 → 结束
```

### 2.6 MVP-1 排除项（飞书文档划线剔除）

- ❌ 采购单位批量修正（飞书文档划线剔除）
- ❌ 最小起订量修正（飞书文档划线剔除）
- ❌ 料件 XS12（飞书文档划线剔除）
- ❌ **d.ii 采购物料的供应商/业务员/自制转采购规则**（飞书文档划线剔除）
- ❌ 数据字段定义（第 5 章，飞书文档划线剔除）
- ❌ 多角贸易的实际调拨（V0.5 仅识别+打标记）
- ❌ 安全库存参与计算（飞书文档未定义）

---

## 3. 数据模型（TypeScript）

`src/mrp/types.ts`：

```typescript
// 主计划（Excel 导入或 JSON）
export interface MasterPlanItem {
  materialCode: string;       // 通常 "A"
  site: string;               // "LG" | ...
  quantity: number;
  startTime: string;          // ISO date
  endTime: string;            // ISO date
}

// BOM（静态 JSON）
export interface BOMItem {
  parentCode: string;
  childCode: string;
  quantity: number;
  level: number;              // 1,2,3
}

// 基础资料（静态 JSON）
export type SupplyType = "self" | "purchase" | "subcontract";

export interface MaterialMaster {
  code: string;
  name: string;
  supplyType: SupplyType;
  productionLeadTime?: number;     // 天
  procurementLeadTime?: number;    // 天
}

// 库存 / 在制 / 在途
export interface InventoryRecord {
  materialCode: string;
  site: string;
  availableQty: number;            // 库存
  wipQty: number;                  // 领用在制
  inTransitQty: number;            // 多角在途
}

// 多角贸易 / 呆滞物料
export interface TransferCandidate {
  fromSite: string;
  toSite: string;
  materialCode: string;
  availableQty: number;
}

// MRP 运算输出
export interface NetRequirement {
  materialCode: string;
  level: number;                   // 0 = 头层
  netQty: number;
  startTime: string;
  endTime: string;
  supplyType: SupplyType;
  priorityBreakdown?: {
    selfMakeQty?: number;
    purchaseQty?: number;
    notes?: string;
  };
  transferCandidates?: TransferCandidate[];
}
```

---

## 4. 代码骨架

```
src/mrp/
├── types.ts                          # §3 数据模型
├── data/                              # 示例静态数据
│   ├── master-plan.example.json
│   ├── bom.example.json
│   ├── material.example.json
│   ├── inventory.example.json
│   └── transfer.example.json
├── calc/
│   ├── parse.ts                       # Excel/JSON 解析
│   ├── explode.ts                     # BOM 逐层展开
│   ├── net-requirement.ts             # 净需求公式
│   ├── priority-self.ts               # 自制物料优先级
│   ├── priority-purchase.ts           # 采购物料优先级
│   ├── multi-region.ts                # 多角贸易
│   └── run.ts                         # 主入口
├── store.ts                           # 内存存储
└── api/run.ts                         # POST /mrp/run
```

---

## 5. 接口定义

### 5.1 后端 API（Hono）

```
POST /mrp/run
请求:  MRPCalcInput
响应:  { results: NetRequirement[]; warnings: string[]; executionTime: number }
```

### 5.2 前端 API

```typescript
export async function runMRP(input: MRPInput): Promise<MRPOutput>
export async function loadExampleData(): Promise<MRPInput>
export async function exportCSV(results: NetRequirement[]): Promise<Blob>
```

---

## 6. 示例数据契约

`master-plan.example.json`：
```json
[{ "materialCode": "A", "site": "LG", "quantity": 100, "startTime": "2026-08-01", "endTime": "2026-08-10" }]
```

`bom.example.json`：
```json
[
  { "parentCode": "A", "childCode": "B", "quantity": 1, "level": 1 },
  { "parentCode": "B", "childCode": "B1", "quantity": 1, "level": 2 },
  { "parentCode": "B", "childCode": "B2", "quantity": 2, "level": 2 },
  { "parentCode": "B", "childCode": "B3", "quantity": 3, "level": 2 }
]
```

`material.example.json`：
```json
[
  { "code": "A", "name": "成品", "supplyType": "self", "productionLeadTime": 7 },
  { "code": "B", "name": "组件", "supplyType": "self", "productionLeadTime": 7 },
  { "code": "B1", "name": "零件1", "supplyType": "purchase", "procurementLeadTime": 14 },
  { "code": "B2", "name": "零件2", "supplyType": "purchase", "procurementLeadTime": 14 },
  { "code": "B3", "name": "零件3", "supplyType": "purchase", "procurementLeadTime": 14 },
  { "code": "D", "name": "外购件", "supplyType": "purchase", "procurementLeadTime": 14 }
]
```

`inventory.example.json`：
```json
[
  { "materialCode": "B",  "site": "LG", "availableQty": 0,   "wipQty": 50,  "inTransitQty": 0 },
  { "materialCode": "B1", "site": "LG", "availableQty": 100, "wipQty": 20,  "inTransitQty": 0 },
  { "materialCode": "B2", "site": "LG", "availableQty": 50,  "wipQty": 30,  "inTransitQty": 0 },
  { "materialCode": "B3", "site": "LG", "availableQty": 60,  "wipQty": 60,  "inTransitQty": 0 },
  { "materialCode": "D",  "site": "LG", "availableQty": 0,   "wipQty": 0,   "inTransitQty": 0 }
]
```

`transfer.example.json`：
```json
[{ "fromSite": "GX", "toSite": "LG", "materialCode": "D", "availableQty": 800 }]
```

---

## 7. 验收用例（必须全部通过）

### 用例 1：B 下阶分解（基于图 1）

```
输入:  A 计划 100, 开工 2026-08-01
       BOM: A→B(1), B→B1(1)+B2(2)+B3(3)
       库存: B1=100, B2=50, B3=60
       在制: B1=20, B2=30, B3=60
期望:  B 净需求: 100
       B1=0, B2=120, B3=180
```

### 用例 2：D 采购优先级（基于图 2）

```
输入:  D 净需求 100, D 是 purchase, 库存/在制=0
期望:  priorityBreakdown: selfMake=30, purchase=70
```

### 用例 3：多角贸易（基于图 3）

```
输入:  LG D 净需求 1000, transfer: GX→LG D=800
期望:  transferCandidates: [{ fromSite: "GX", toSite: "LG", materialCode: "D", availableQty: 800 }]
```

### 用例 4：完整分解路径（图 4）

```
输入:  A 主计划 → B 自制 → B 下阶 B1/B2/B3
       A 主计划 → E 外购 → 触发多角/制工单/外购
期望:  路径 1: B → 工单余量/采购订单/展开 BOM
       路径 2: E → 多角贸易/外购需求 → 是否自制 → 其他据点自制/采购需求
```

---

## 8. Web 端页面

- `UploadPage.tsx` — 上传主计划 Excel
- `MRPRunPage.tsx` — 选择/编辑基础资料 + 点击"运行 MRP"
- `ResultPage.tsx` — 表格展示 + 优先级拆解视图

---

## 9. 单元测试

`tests/mrp/`：
- `net-requirement.test.ts` — 用例 1
- `priority-purchase.test.ts` — 用例 2
- `multi-region.test.ts` — 用例 3
- `full-decompose.test.ts` — 用例 4
- `explode.test.ts` — BOM 展开
- `priority-self.test.ts` — 在制余量匹配

---

## 10. 里程碑（4 周）

| 周 | 任务 |
|----|------|
| W1 | types.ts + 5 份示例数据 + 单元测试骨架 + net-requirement.ts |
| W2 | explode.ts + priority-self.ts + priority-purchase.ts + 用例 1/2 通过 |
| W3 | multi-region.ts + 后端 API (POST /mrp/run) + 用例 3 通过 |
| W4 | Web 端 3 个页面 + 集成测试 + README |

---

## 11. 待办（开发期间遇到再处理）

- 业务方确认事项：见 [archive/v0.4-2026-07-24.md](./archive/v0.4-2026-07-24.md) §11
- d.ii 完整规则（已划线剔除）—— **MVP-1 不实现**
- 多角贸易实际调拨 —— V0.5 仅识别+打标记
- 文档 2 第 5 章 数据字段定义 —— 已划线剔除，V0.5 不实现

---

## 12. 工程规范（必须遵守）

### 12.1 代码注释必须用中文

**`src/mrp/**` 下所有代码必须使用中文注释**（包括但不限于函数/方法 JSDoc、行内注释、TODO 标记、文件头注释）。

理由：
1. 团队内部沟通语言是中文，降低阅读成本
2. 业务术语（如"净需求"、"在制"）翻译为英文会丢失语义
3. AI 助手（Claude 等）可以直接基于中文规范上下文工作

示例：

```typescript
/**
 * 计算净需求
 *
 * 公式: 净需求 = 毛需求 - 领用在制 - 库存 - 多角在途
 *
 * @param grossDemand   毛需求数量
 * @param inventory     该料件当前库存/在制/在途
 * @returns             净需求计算结果（含开工/完工时间）
 */
export function calcNetRequirement(
  grossDemand: number,
  inventory: InventoryRecord,
): NetRequirement {
  // 先减去在制(最直接可用),再减去库存,最后扣多角在途
  const wip = inventory.wipQty;
  const stock = inventory.availableQty;
  const inTransit = inventory.inTransitQty;

  const net = Math.max(0, grossDemand - wip - stock - inTransit);

  return {
    materialCode: inventory.materialCode,
    netQty: net,
    // TODO: 后续接入 v0.3 后的提前期倒推
  };
}
```

允许但**不鼓励**：
- 函数名/变量名：保持英文（这是代码标准实践）
- 第三方库 API 注释：保持英文
- 技术术语首次出现时：**中英对照**（如"净需求 (Net Requirement)"）

**反例（不允许）**：
```typescript
// Calculate net requirement
// Fetch inventory record
export function calcNetRequirement(gross, inv) { ... }
```

### 12.2 其他

- TypeScript `strict: true`（项目已有）
- 单元测试覆盖率 ≥ 80%（核心算法模块）
- 错误处理：算法模块抛明确的 Error 类型而非 string

---

## 附：算法图（已下载到 feishu-originals/）

| 图 | 文件 | 内容 |
|----|------|------|
| 图 1 | `02-...-assets/img0.png` | 自制 B 下阶分解 |
| 图 2 | `02-...-assets/img1.png` | 采购 D 优先级 |
| 图 3 | `02-...-assets/img2.png` | 多角贸易流程 |
| 图 4 | `02-...-assets/img3.png` | 完整分解路径 |

---

## 附：历史

- v0.1 (2026-07-24) — 初始版 [归档](./archive/v0.1-2026-07-24.md)
- v0.2 (2026-07-24) — MVP-1 1 个月范围 [归档](./archive/v0.2-2026-07-24.md)
- v0.3 (2026-07-24) — 划线内容/采购优先级/多角贸易 [归档](./archive/v0.3-2026-07-24.md)
- v0.4 (2026-07-24) — 开发就绪版（接口/数据模型/验收用例）[归档](./archive/v0.4-2026-07-24.md)
- v0.5 (2026-07-24) — 完整 4 张算法图 + d.ii 剔除 [归档](./archive/v0.5-2026-07-24.md)
- **v0.6 (2026-07-24) — 当前** — 新增 §12 工程规范：`src/mrp/` 下代码必须用中文注释
- **v0.5 (2026-07-24) — 当前** — 增加第 4 张流程图 + 完整文档 2 章节 + 确认 d.ii 规则剔除