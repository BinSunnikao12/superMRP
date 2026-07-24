/**
 * 同步飞书文档 → goals/feishu-originals/
 *
 * 行为：
 *  - 启动（或附加到）一个 Chrome 实例（remote-debugging-port=9222）
 *  - 用 CDP 打开每个飞书 URL
 *  - 抓取正文（docx 类型用 .docx-text-block；office viewer 用通用 span）
 *  - 跟 goals/feishu-originals/0N-*.md 的上次快照做 diff
 *  - 报告：每个文档「无改动」「新增」「删除」「修改」
 *  - 有改动时：写入新版本（覆盖） + 在 stdout 输出 diff
 *
 * 运行：
 *   tsx scripts/sync-feishu-docs.ts
 *
 * 前置：
 *   macOS 上 Chrome 装在 /Applications/Google Chrome.app
 *   脚本会自动启动 Chrome with --remote-debugging-port=9222
 *   用户需要在 Chrome 里已经登录飞书（或在脚本提示后登录）
 *   复用一个 user-data-dir 让登录态保留
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 脚本位于 goals/ 下,GOALS_DIR 就是 __dirname
const GOALS_DIR = __dirname;
const ORIGINALS_DIR = join(GOALS_DIR, "feishu-originals");
const URL_INDEX = join(GOALS_DIR, "feishuDocs.md");

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9222;
const USER_DATA_DIR = `${process.env.HOME}/.cache/mrp-chrome-profile`;

// ---------- 工具函数 ----------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function log(color: string, label: string, msg: string) {
  console.log(`${color}${BOLD}[${label}]${RESET} ${msg}`);
}

function info(msg: string) {
  log(CYAN, "INFO", msg);
}

function ok(msg: string) {
  log(GREEN, "OK", msg);
}

function warn(msg: string) {
  log(YELLOW, "WARN", msg);
}

function err(msg: string) {
  log(RED, "ERR", msg);
}

// ---------- Chrome 进程管理 ----------

async function isChromeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function startChrome(): Promise<ChildProcess> {
  info(`启动 Chrome: ${CHROME_PATH}`);
  info(`  debug-port=${DEBUG_PORT}, user-data-dir=${USER_DATA_DIR}`);
  info(`  ⚠️  首次启动使用全新 profile，需要手动登录飞书`);
  info(`  登录态会保留在 ${USER_DATA_DIR}，下次启动自动复用`);
  const child = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "https://loctek.feishu.cn", // 打开飞书首页,方便用户登录
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  child.unref();

  // 等待端口就绪
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isChromeRunning()) {
      ok("Chrome 已就绪");
      // 这里检测登录态
      await waitForLogin();
      return child;
    }
  }
  throw new Error("Chrome 启动超时（15s）");
}

async function waitForLogin(): Promise<void> {
  // 等待用户登录飞书:
  // 1. 打开飞书首页
  // 2. 用户扫码登录
  // 3. 检测到 home.feishu.cn / loctek.feishu.cn 不再跳转 → 登录成功
  info("请在弹出的 Chrome 窗口里登录飞书（扫码 / SSO）");
  info("等待登录完成...");
  const startTime = Date.now();
  const timeout = 5 * 60 * 1000; // 5 分钟超时
  let firstCheck = true;
  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const targets = await listTargets();
      const page = targets.find((t) => t.type === "page");
      if (!page) continue;
      const url = page.url;
      // 登录态检测:URL 不再是 accounts.feishu.cn/login...
      const isLoggedIn = url.startsWith("https://loctek.feishu.cn") &&
                          !url.includes("/accounts/page/login") &&
                          !url.includes("login_redirect_times");
      if (isLoggedIn) {
        ok(`登录检测成功（当前 URL: ${url.slice(0, 60)}）`);
        return;
      }
      if (firstCheck) {
        info(`  当前 URL: ${url.slice(0, 60)}`);
        firstCheck = false;
      }
    } catch {
      // 忽略
    }
  }
  warn("登录等待超时（5 分钟），继续执行。后续可能因为未登录导致抓取失败。");
}

// ---------- CDP 客户端 ----------

interface CDPSession {
  id: number;
  ws: WebSocket;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}

async function connectToPage(targetId: string): Promise<CDPSession> {
  const wsUrl = `ws://localhost:${DEBUG_PORT}/devtools/page/${targetId}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });

  let msgId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };

  const send = (method: string, params?: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");

  return {
    id: msgId,
    ws,
    send,
    close: () => ws.close(),
  };
}

async function listTargets(): Promise<Array<{ id: string; url: string; type: string }>> {
  const res = await fetch(`http://localhost:${DEBUG_PORT}/json`);
  return res.json();
}

async function attachToAnyPage(): Promise<{ session: CDPSession; targetId: string }> {
  const targets = await listTargets();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("找不到任何 page 类型的标签页");
  const session = await connectToPage(page.id);
  return { session, targetId: page.id };
}

async function createNewPage(url: string): Promise<CDPSession> {
  // PUT /json/new 创建新标签
  const res = await fetch(
    `http://localhost:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`
  );
  const target = await res.json();
  return connectToPage(target.id);
}

async function navigateAndWait(session: CDPSession, url: string, timeoutMs = 60_000): Promise<void> {
  await session.send("Page.navigate", { url });
  // 等 navigate 事件完成
  const navP = new Promise<void>((resolve) => {
    const handler = (ev: { data: string }) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Page.loadEventFired") {
        session.ws.removeEventListener("message", handler as unknown as EventListener);
        resolve();
      }
    };
    session.ws.addEventListener("message", handler as unknown as EventListener);
  });
  await Promise.race([
    navP,
    new Promise((_, reject) => setTimeout(() => reject(new Error("navigate timeout")), timeoutMs)),
  ]);
  // 飞书 docx 渲染是异步的，再等 1.5s
  await new Promise((r) => setTimeout(r, 1500));
}

async function evaluate(session: CDPSession, expression: string): Promise<unknown> {
  const result = (await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value: unknown } };
  return result.result.value;
}

// ---------- 抓取策略 ----------

const DOCX_EXTRACTOR = `(() => {
  const all = document.querySelectorAll('.docx-text-block');
  const lines = [];
  all.forEach(b => {
    const t = (b.innerText || '').replace(/​/g, '').trim();
    if (t) lines.push(t);
  });
  return lines.join('\\n');
})()`;

const DOCX_EXTRACTOR_WITH_HEADINGS = `(() => {
  // 抓所有 [data-block-type] 叶子(没有 [data-block-type] 子节点的块)
  const page = document.querySelector('.docx-page-block') || document.body;
  const blocks = page.querySelectorAll('[data-block-type]');
  const leaves = [];
  blocks.forEach(b => {
    const childWithType = b.querySelector('[data-block-type]');
    if (!childWithType) {
      const type = b.getAttribute('data-block-type');
      const t = (b.innerText || '').replace(/​/g, '').trim();
      leaves.push({ type, text: t });
    }
  });
  const lines = [];
  let title = null;
  leaves.forEach(l => {
    if (!l.text) return;
    // 尝试从 h1 / 引号标题 / 默认首行提取标题
    if (l.type === 'heading1') {
      title = l.text;
      lines.push('# ' + l.text);
    } else if (l.type === 'heading2') {
      lines.push('## ' + l.text);
    } else if (l.type === 'heading3') {
      lines.push('### ' + l.text);
    } else if (l.type === 'bullet') {
      lines.push('- ' + l.text.replace(/^[•·\\-]\\s*/, ''));
    } else if (l.type === 'numbered') {
      lines.push('1. ' + l.text.replace(/^[a-zA-Z0-9][.．)]\\s*/, ''));
    } else if (l.type === 'table') {
      lines.push('【表格】\\n' + l.text);
    } else {
      // 普通 text 行:用作标题候选
      if (!title && (/^《.+》$/.test(l.text) || /^(?:📋|🗂|📁)\\s*.+/.test(l.text))) {
        title = l.text;
      }
      lines.push(l.text);
    }
  });
  return { title, text: lines.join('\\n') };
})()`;

const OFFICE_VIEWER_EXTRACTOR = `(() => {
  // office viewer 渲染:从所有可见 span/div 提取非噪声文本
  const all = document.querySelectorAll('span, p, div');
  const text = [];
  const seen = new Set();
  all.forEach(el => {
    const t = (el.innerText || '').trim();
    if (!t || t.length < 2) return;
    if (t.includes('页面') || t.includes('100%') || t.includes('字数') || t.includes('行 :') || t.includes('列 :') || t.includes('节 :') || t === '100%' || t.startsWith('mmmmm')) return;
    if (seen.has(t)) return;
    seen.add(t);
    text.push(t);
  });
  // 尝试从结果里找出标题(飞书 office viewer 的标题通常在最前面)
  // 优先级:出现在 5 行内、长度 < 60、不含特殊符号的字符串
  let title = null;
  for (let i = 0; i < Math.min(text.length, 8); i++) {
    const t = text[i];
    if (t.length >= 4 && t.length <= 60 && !t.includes('方案') === false && !t.startsWith('版本') && !t.startsWith('日期') && !t.startsWith('适用')) {
      title = t;
      break;
    }
  }
  return { title, text: text.join('\\n') };
})()`;

interface DocSpec {
  index: number;
  url: string;
  token: string;
  renderer: "docx" | "office-viewer";
  filename: string;
}

function parseDocSpecs(md: string): DocSpec[] {
  // 抓形如 https://loctek.feishu.cn/docx/XXX 或 /file/YYY 的 URL
  const re = /https:\/\/loctek\.feishu\.cn\/(docx|file)\/([A-Za-z0-9]+)/g;
  const specs: DocSpec[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(md)) !== null) {
    const [, kind, token] = m;
    const url = m[0];
    const renderer: DocSpec["renderer"] = kind === "file" ? "office-viewer" : "docx";
    const idx = String(++i).padStart(2, "0");
    const filename = `${idx}-${token}.md`;
    specs.push({ index: i, url, token, renderer, filename });
  }
  return specs;
}

// ---------- Diff ----------

interface DiffSummary {
  changed: boolean;
  added: number;
  removed: number;
  unchanged: number;
  diffLines: string[];
}

function lineDiff(oldText: string, newText: string): DiffSummary {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => !oldSet.has(l));
  const removed = oldLines.filter((l) => !newSet.has(l));
  const unchanged = newLines.filter((l) => oldSet.has(l)).length;

  // 简单行级 diff 输出（类似 unified diff 的最简版）
  const diffLines: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined && n !== undefined) {
      diffLines.push(`${RED}- ${o}${RESET}`);
      diffLines.push(`${GREEN}+ ${n}${RESET}`);
    } else if (o !== undefined) {
      diffLines.push(`${RED}- ${o}${RESET}`);
    } else if (n !== undefined) {
      diffLines.push(`${GREEN}+ ${n}${RESET}`);
    }
 }

  return {
    changed: added.length > 0 || removed.length > 0,
    added: added.length,
    removed: removed.length,
    unchanged,
    diffLines: diffLines.slice(0, 200), // 截断防止刷屏
  };
}

// ---------- 文件名工具 ----------

function sanitizeFilename(title: string, fallback: string): string {
  // 去除《》、空格、特殊符号,保留中文/英文/数字
  let s = title
    .replace(/^《\s*/, "")
    .replace(/\s*》$/, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!s) return fallback;
  // 截断到 50 字
  if (s.length > 50) s = s.slice(0, 50);
  return s;
}

function buildFilename(index: number, title: string | null, token: string): string {
  const idx = String(index).padStart(2, "0");
  if (title) {
    return `${idx}-${sanitizeFilename(title, token)}.md`;
  }
  return `${idx}-${token}.md`; // 没有标题时退回 token
}

// ---------- 文件系统 ----------

async function readURLIndex(): Promise<DocSpec[]> {
  const md = await readFile(URL_INDEX, "utf-8");
  return parseDocSpecs(md);
}

async function loadExisting(dir: string, filename: string): Promise<string | null> {
  const path = join(dir, filename);
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

async function writeSnapshot(dir: string, filename: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf-8");
}

// ---------- 主流程 ----------

async function main() {
  info("=== 飞书文档同步脚本 ===");
  info(`Chrome debug port: ${DEBUG_PORT}`);
  info(`原始目录: ${ORIGINALS_DIR}`);

  // 1. 启动 Chrome
  if (!(await isChromeRunning())) {
    await startChrome();
  } else {
    ok("Chrome 已在运行");
  }

  // 2. 读 URL 列表
  const specs = await readURLIndex();
  if (specs.length === 0) {
    err("未在 goals/feishuDocs.md 找到任何飞书 URL");
    process.exit(1);
  }
  info(`发现 ${specs.length} 个飞书文档`);

  // 3. 接一个 page
  const { session } = await attachToAnyPage();

  // 4. 逐个抓取
  let changedCount = 0;
  const summary: Array<{ index: number; title: string; status: string }> = [];

  try {
    for (const spec of specs) {
      info(`\n${BOLD}[文档 ${spec.index}]${RESET} ${spec.url}`);
      try {
        await navigateAndWait(session, spec.url);

        const extractor =
          spec.renderer === "docx"
            ? DOCX_EXTRACTOR_WITH_HEADINGS
            : OFFICE_VIEWER_EXTRACTOR;
        const extracted = (await evaluate(session, extractor)) as
          | { title: string | null; text: string }
          | string;

        // 兼容老 extractor（返回纯字符串）
        const title = typeof extracted === "object" ? extracted.title : null;
        const rawContent = typeof extracted === "object" ? extracted.text : extracted;

        if (!rawContent || rawContent.trim().length < 5) {
          warn(`  抓取内容为空（可能需要登录或文档加载失败）`);
          summary.push({ index: spec.index, title: spec.filename, status: "❌ 抓取为空" });
          continue;
        }

        // 动态文件名（基于真实标题）
        const newFilename = buildFilename(spec.index, title, spec.token);
        const newContent = rawContent.trim() + "\n";

        // 检查是否要迁移旧文件（命名规则变化时）
        const oldFilename = spec.filename;
        if (oldFilename !== newFilename && existsSync(join(ORIGINALS_DIR, oldFilename))) {
          if (!existsSync(join(ORIGINALS_DIR, newFilename))) {
            await writeSnapshot(ORIGINALS_DIR, newFilename, newContent);
            const { unlink } = await import("node:fs/promises");
            await unlink(join(ORIGINALS_DIR, oldFilename));
            warn(`  文件名迁移: ${oldFilename} → ${newFilename}`);
            changedCount++;
            summary.push({ index: spec.index, title: newFilename, status: "📝 命名迁移 + 首次入库" });
            continue;
          }
        }

        const oldContent = await loadExisting(ORIGINALS_DIR, newFilename);

        if (oldContent === null) {
          await writeSnapshot(ORIGINALS_DIR, newFilename, newContent);
          ok(`  首次抓取 → 写入 ${newFilename} (${newContent.length} 字)`);
          changedCount++;
          summary.push({ index: spec.index, title: newFilename, status: "🆕 首次入库" });
        } else if (oldContent === newContent) {
          ok(`  「文档 ${spec.index}」${newFilename} 本次无改动 ✓`);
          summary.push({ index: spec.index, title: newFilename, status: "✓ 无改动" });
        } else {
          const diff = lineDiff(oldContent, newContent);
          await writeSnapshot(ORIGINALS_DIR, newFilename, newContent);
          warn(`  「文档 ${spec.index}」${newFilename} 有改动 (+${diff.added} -${diff.removed})`);
          if (diff.diffLines.length > 0) {
            console.log(`${DIM}  --- diff (前 ${diff.diffLines.length} 行) ---${RESET}`);
            for (const line of diff.diffLines) {
              console.log(`  ${line}`);
            }
            console.log(`${DIM}  --- /diff ---${RESET}`);
          }
          changedCount++;
          summary.push({
            index: spec.index,
            title: newFilename,
            status: `🔄 有改动 (+${diff.added} -${diff.removed})`,
          });
        }
      } catch (e) {
        err(`  「文档 ${spec.index}」抓取失败: ${(e as Error).message}`);
        summary.push({ index: spec.index, title: spec.filename, status: "💥 失败" });
      }
    }
  } finally {
    session.close();
  }

  // 5. 总结
  console.log(`\n${BOLD}=== 总结 ===${RESET}`);
  for (const s of summary) {
    console.log(`  文档 ${s.index}: ${s.status}`);
  }
  console.log(
    `${BOLD}${changedCount === 0 ? GREEN : YELLOW}共 ${specs.length} 个文档，${changedCount} 个有改动${RESET}`
  );

  // 不要 kill Chrome（用户可能还想留着登录态）
  process.exit(0);
}

main().catch((e) => {
  err(e.stack || e.message);
  process.exit(1);
});