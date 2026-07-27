/**
 * 同步飞书文档 → goals/feishu-originals/
 *
 * 行为：
 *  - 启动（或附加到）一个 Chrome 实例（remote-debugging-port=9222）
 *  - 用 CDP 打开每个飞书 URL
 *  - 抓取正文（docx 类型用 .docx-text-block；office viewer 用通用 span）
 *  - 抓取图片：过滤头像等噪声图，下载到 0N-xxx-assets/ 目录
 *  - 检测删除线（用户划线部分） → 标记为 ~~删除线~~，人工二次过滤
 *  - 跟 goals/feishu-originals/0N-*.md 的上次快照做 diff
 *  - 报告：每个文档「无改动」「新增」「删除」「修改」
 *  - 有改动时：写入新版本（覆盖） + 在 stdout 输出 diff
 *
 * 运行：
 *   npx tsx goals/sync-feishu-docs.ts
 *
 * 前置：
 *   macOS 上 Chrome 装在 /Applications/Google Chrome.app
 *   脚本会自动启动 Chrome with --remote-debugging-port=9222
 *   用户需要在 Chrome 里已经登录飞书（或在脚本提示后登录）
 *   复用一个 user-data-dir 让登录态保留
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
      "https://loctek.feishu.cn",
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isChromeRunning()) {
      ok("Chrome 已就绪");
      await waitForLogin();
      return child;
    }
  }
  throw new Error("Chrome 启动超时（15s）");
}

async function waitForLogin(): Promise<void> {
  info("请在弹出的 Chrome 窗口里登录飞书（扫码 / SSO）");
  info("等待登录完成...");
  const startTime = Date.now();
  const timeout = 5 * 60 * 1000;
  let firstCheck = true;
  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const targets = await listTargets();
      const page = targets.find((t) => t.type === "page");
      if (!page) continue;
      const url = page.url;
      const isLoggedIn =
        url.startsWith("https://loctek.feishu.cn") &&
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

async function navigateAndWait(
  session: CDPSession,
  url: string,
  timeoutMs = 60_000,
  waitSelector = "",
  minCount = 0
): Promise<void> {
  // 关键: 设置 viewport 高度很大,让飞书 docx 一次性渲染所有 block(否则懒加载只渲染可见区域)
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 8000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.send("Page.navigate", { url });
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
  // 飞书 docx 是 SPA: navigate 后等 React/Editor 完成渲染
  // 等到 minCount 个 selector 元素出现,或者最多 15s
  if (waitSelector) {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const count = (await evaluate(
        session,
        `document.querySelectorAll(${JSON.stringify(waitSelector)}).length`
      )) as number;
      if (count >= minCount) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function evaluate(session: CDPSession, expression: string): Promise<unknown> {
  try {
    const result = (await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result?.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate exception: ${desc}`);
    }
    return result.result.value;
  } catch (e) {
    // 抛出错误让上层看到
    throw e;
  }
}

// ---------- 抓取策略 ----------

const DOCX_EXTRACTOR_WITH_HEADINGS = `(async () => {
  // 飞书 docx 是懒加载: 滚动到底才能拿到所有 block
  async function scrollToEnd() {
    const scrollContainer = document.querySelector('.docx-scroll-container, .bear-web-x-container');
    let lastCount = 0;
    for (let i = 0; i < 15; i++) {
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 1500));
      const c = document.querySelectorAll('.docx-text-block').length;
      if (c === lastCount) break;
      lastCount = c;
    }
    if (scrollContainer) scrollContainer.scrollTop = 0;
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 1500));
  }
  await scrollToEnd();
  const all = document.querySelectorAll('.docx-text-block');
  const leaves = [];
  all.forEach(b => {
    const t = (b.innerText || '').replace(/[\u200b]/g, '').trim();
    if (!t) return;
    let hasStrikethrough = false;
    b.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.textDecorationLine && cs.textDecorationLine.includes('line-through')) {
        hasStrikethrough = true;
      }
      if (el.tagName === 'S' || el.tagName === 'DEL' || el.tagName === 'STRIKE') {
        hasStrikethrough = true;
      }
    });
    const wrapper = b.closest('[data-block-type]');
    const type = wrapper ? wrapper.getAttribute('data-block-type') : 'text';
    leaves.push({ type, text: t, strikethrough: hasStrikethrough });
  });
  const lines = [];
  let title = null;
  leaves.forEach(l => {
    if (l.type === 'heading1') {
      title = l.text;
      lines.push('# ' + l.text);
    } else if (l.type === 'heading2') {
      lines.push('## ' + l.text);
    } else if (l.type === 'heading3') {
      lines.push('### ' + l.text);
    } else if (l.type === 'bullet') {
      lines.push('- ' + l.text.replace(/^[•·\-]\s*/, ''));
    } else if (l.type === 'numbered') {
      lines.push('1. ' + l.text.replace(/^[a-zA-Z0-9][.．)]\s*/, ''));
    } else if (l.type === 'table') {
      lines.push('【表格】\n' + l.text);
    } else {
      if (!title && (/^《.+》$/.test(l.text) || /^(?:📋|🗂|📁)\s*.+/.test(l.text))) {
        title = l.text;
      }
      if (l.strikethrough) {
        lines.push('~~[删除线] ' + l.text + '~~');
      } else {
        lines.push(l.text);
      }
    }
  });
  const images = [];
  const seen = new Set();
  document.querySelectorAll('img').forEach(img => {
    const src = img.src || '';
    if (!src || src.startsWith('data:')) return;
    if (seen.has(src)) return;
    seen.add(src);
    if (src.includes('/static-resource/v1/v3_00ig_')) return;
    if (src.includes('avatar_url')) return;
    images.push(src);
  });
  return { title, text: lines.join('\n'), images };
})()`;

const OFFICE_VIEWER_EXTRACTOR = `(() => {
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
  let title = null;
  for (let i = 0; i < Math.min(text.length, 8); i++) {
    const t = text[i];
    if (t.length >= 4 && t.length <= 60 && !t.includes('方案') === false && !t.startsWith('版本') && !t.startsWith('日期') && !t.startsWith('适用')) {
      title = t;
      break;
    }
  }
  const images = [];
  const seenImg = new Set();
  document.querySelectorAll('img').forEach(img => {
    const src = img.src || '';
    if (!src || src.startsWith('data:')) return;
    if (seenImg.has(src)) return;
    seenImg.add(src);
    if (src.includes('/static-resource/v1/v3_00ig_')) return;
    if (src.includes('avatar_url')) return;
    images.push(src);
  });
  return { title, text: text.join('\\n'), images };
})()`;

interface DocSpec {
  index: number;
  url: string;
  token: string;
  renderer: "docx" | "office-viewer";
  filename: string;
}

function parseDocSpecs(md: string): DocSpec[] {
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

// ---------- 图片下载 ----------

function makeImageName(url: string, index: number): string {
  // 用 URL 里的 path hash + 序号 命名,后缀从 URL 推断
  const m = url.match(/\/([A-Za-z0-9_-]{20,})\?/) || url.match(/\/([A-Za-z0-9_-]{20,})$/);
  const hash = m ? m[1].slice(-12) : `img${index}`;
  let ext = ".png";
  const fmtMatch = url.match(/[?&]format=([a-z]+)/);
  if (fmtMatch) ext = "." + fmtMatch[1];
  else if (url.includes(".webp")) ext = ".webp";
  else if (url.includes(".jpg") || url.includes(".jpeg")) ext = ".jpg";
  return `${hash}${ext}`;
}

async function downloadImage(url: string, filePath: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: {
        // 飞书图片服务器需要 referer 才能下载
        Referer: "https://loctek.feishu.cn/",
      },
    });
    if (!res.ok) {
      warn(`  下载图片失败 (${res.status}): ${url.slice(0, 60)}...`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(filePath, buf);
    return true;
  } catch (e) {
    warn(`  下载图片出错: ${(e as Error).message}`);
    return false;
  }
}

// ---------- 文件名工具 ----------

function sanitizeFilename(title: string, fallback: string): string {
  let s = title
    .replace(/^《\s*/, "")
    .replace(/\s*》$/, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!s) return fallback;
  if (s.length > 50) s = s.slice(0, 50);
  return s;
}

function buildFilename(index: number, title: string | null, token: string): string {
  const idx = String(index).padStart(2, "0");
  if (title) {
    return `${idx}-${sanitizeFilename(title, token)}.md`;
  }
  return `${idx}-${token}.md`;
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
    diffLines: diffLines.slice(0, 200),
  };
}

// ---------- 主流程 ----------

interface Extraction {
  title: string | null;
  text: string;
  images: string[];
}

async function main() {
  info("=== 飞书文档同步脚本 ===");
  info(`Chrome debug port: ${DEBUG_PORT}`);
  info(`原始目录: ${ORIGINALS_DIR}`);

  if (!(await isChromeRunning())) {
    await startChrome();
  } else {
    ok("Chrome 已在运行（可能复用已有登录态）");
  }

  const specs = await readURLIndex();
  if (specs.length === 0) {
    err("未在 goals/feishuDocs.md 找到任何飞书 URL");
    process.exit(1);
  }
  info(`发现 ${specs.length} 个飞书文档`);

  const { session } = await attachToAnyPage();

  let changedCount = 0;
  const summary: Array<{ index: number; title: string; status: string }> = [];

  try {
    for (const spec of specs) {
      info(`\n${BOLD}[文档 ${spec.index}]${RESET} ${spec.url}`);
      try {
        await navigateAndWait(
          session,
          spec.url,
          60_000,
          spec.renderer === "docx" ? ".docx-text-block" : "",
          spec.renderer === "docx" ? 30 : 0
        );

        const extractor =
          spec.renderer === "docx"
            ? DOCX_EXTRACTOR_WITH_HEADINGS
            : OFFICE_VIEWER_EXTRACTOR;
        const extracted = (await evaluate(session, extractor)) as Extraction;

        const title = extracted?.title ?? null;
        const rawContent = extracted?.text ?? "";
        const images: string[] = extracted?.images ?? [];

        if (!rawContent || rawContent.trim().length < 5) {
          warn(`  抓取内容为空（可能需要登录或文档加载失败）`);
          warn(`    extracted 类型: ${typeof extracted} /  keys: ${extracted ? Object.keys(extracted).join(",") : "n/a"}`);
          warn(`    title: ${title} / text len: ${rawContent.length} / images len: ${images.length}`);
          summary.push({ index: spec.index, title: spec.filename, status: "❌ 抓取为空" });
          continue;
        }

        // 下载图片到 0N-xxx-assets/ 目录
        let imageDir = "";
        let imageDownloaded = 0;
        if (images.length > 0) {
          const stem = buildFilename(spec.index, title, spec.token).replace(/\.md$/, "");
          imageDir = join(ORIGINALS_DIR, `${stem}-assets`);
          await mkdir(imageDir, { recursive: true });
          for (let i = 0; i < images.length; i++) {
            const url = images[i];
            const name = makeImageName(url, i);
            const path = join(imageDir, name);
            const ok = await downloadImage(url, path);
            if (ok) imageDownloaded++;
          }
          info(`  图片: 下载 ${imageDownloaded}/${images.length} 到 ${basename(imageDir)}/`);
        }

        // 把图片引用加到 markdown 末尾
        let newContent = rawContent.trim() + "\n";
        if (images.length > 0 && imageDownloaded > 0) {
          const stem = buildFilename(spec.index, title, spec.token).replace(/\.md$/, "");
          const assetDir = `${basename(imageDir)}`;
          newContent += `\n## 文档图片\n\n`;
          for (let i = 0; i < images.length; i++) {
            const name = makeImageName(images[i], i);
            newContent += `![图片 ${i + 1}](./${assetDir}/${name})\n\n`;
          }
        }

        const newFilename = buildFilename(spec.index, title, spec.token);
        const oldFilename = spec.filename;

        if (oldFilename !== newFilename && existsSync(join(ORIGINALS_DIR, oldFilename))) {
          if (!existsSync(join(ORIGINALS_DIR, newFilename))) {
            await writeSnapshot(ORIGINALS_DIR, newFilename, newContent);
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

  console.log(`\n${BOLD}=== 总结 ===${RESET}`);
  for (const s of summary) {
    console.log(`  文档 ${s.index}: ${s.status}`);
  }
  console.log(
    `${BOLD}${changedCount === 0 ? GREEN : YELLOW}共 ${specs.length} 个文档，${changedCount} 个有改动${RESET}`
  );

  process.exit(0);
}

main().catch((e) => {
  err(e.stack || e.message);
  process.exit(1);
});