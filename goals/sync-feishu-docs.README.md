# sync-feishu-docs

把 `goals/feishuDocs.md` 里列出的飞书文档**自动同步到本地**，`goals/feishu-originals/0N-文档名.md`，并对每次同步结果做 diff。

## 用法

```bash
# 在项目根目录运行
npx tsx goals/sync-feishu-docs.ts
```

> 脚本本身**就在 `goals/` 下**，属于需求资料目录的一部分。
> 【项目脚手架代码】(`src/`、`web/`、`scripts/`) 与【需求资料】(`goals/`) 是分开的——脚本跟需求走。

## 第一次跑

1. 脚本会启动一个独立的 Chrome（remote-debugging-port=9222）
2. 打开飞书首页，**请在弹出的 Chrome 窗口里登录飞书**（扫码 / SSO）
3. 脚本会自动检测登录状态（最长 5 分钟）
4. 登录后，脚本抓取 5 份文档 → 写入 `goals/feishu-originals/`
5. 不 kill Chrome，登录态会保留在 `~/.cache/mrp-chrome-profile/`

## 之后每次跑

```bash
npx tsx goals/sync-feishu-docs.ts
```

- 脚本会**复用** Chrome 进程（如果 9222 端口已被占用）
- 如果 Chrome 已关闭，脚本会自动启动同一 profile → 登录态保留
- 对比上次抓取内容，输出：
  - `🆕 首次入库`
  - `✓ 无改动`
  - `🔄 有改动 (+X -Y)`  +  diff 详情
  - `❌ 抓取为空`（可能需要重新登录）

## 文件命名

文件名格式：`0N-文档标题.md`

- 编号 0N 按 `goals/feishuDocs.md` 里 URL 出现的顺序
- 标题来自抓取内容（docx 取 h1 或《》引号标题，office-viewer 取前 8 行第一个中长度合适的字符串）
- 标题清洗：去除《》、空格、特殊符号
- 旧文件名（token 命名）会在下次跑时自动迁移

## 配置文件

- `goals/feishuDocs.md` — URL 列表（每行一个 URL）
- `goals/feishu-originals/` — 抓取快照（脚本维护，**不要手动编辑**）
- `~/.cache/mrp-chrome-profile/` — Chrome profile（登录态）

## 局限

- 文档 5 是 `office-viewer` 类型（飞书在线打开），**只能抓到大纲 + 首页**。后续 9 页需要手动在浏览器里导出 PDF 或下载 docx
- 抓取依赖飞书页面 DOM 结构（`.docx-text-block` / `[data-block-type]`），如果飞书改版可能需要更新 extractor
- 单测脚本时如果看到"抓取为空"，通常是没登录或登录态过期
