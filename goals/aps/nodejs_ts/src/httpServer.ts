/**
 * src/httpServer.ts
 * ============================================================
 * APS MRP 报告下载服务（Node.js + TypeScript）
 *
 * 在 MRP 任务跑完后启动，常驻监听：
 *   GET    /health                  - 健康检查
 *   GET    /api/sites               - 已处理基地列表
 *   GET    /api/files               - 所有基地的 xlsx 文件清单（按基地分组，按时间倒序）
 *   GET    /api/files/:site         - 单个基地的文件清单
 *   GET    /api/download/:site/:f   - 下载指定 xlsx
 *   DELETE /api/files/:site/:f      - 删除指定 xlsx
 *   GET    /                        - 简易 HTML 浏览器（点击下载）
 *
 * 用 Node 18+ 自带 http 即可，不引 express，零额外依赖
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { config } from './config';
import { cachePool } from './cache/ttlLru';
import { handleAdmin, renderAdmin } from './admin/web';

const PORT = parseInt(process.env.APS_HTTP_PORT || '8080', 10);
const HOST = process.env.APS_HTTP_HOST || '0.0.0.0';

function contentType(filename: string): string {
    if (filename.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
    if (filename.endsWith('.csv')) return 'text/csv; charset=utf-8';
    if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
    return 'application/octet-stream';
}

function safeJoin(root: string, sub: string): string | null {
    // 防止路径穿越
    const target = path.resolve(root, sub);
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
        return null;
    }
    return target;
}

function listFilesForSite(site: string, outputDir: string): { name: string; size: number; mtime: string }[] {
    const siteDir = path.join(outputDir, site);
    if (!fs.existsSync(siteDir)) return [];
    return fs.readdirSync(siteDir)
        .filter(f => f.endsWith('.xlsx'))
        .map(name => {
            const st = fs.statSync(path.join(siteDir, name));
            return { name, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function renderIndex(): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>APS MRP 报告下载</title>
<style>
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; color: #1f2937; }
  h1 { color: #0f172a; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
  h2 { color: #1e40af; margin-top: 28px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; margin: 6px 0; }
  .card a { color: #1d4ed8; text-decoration: none; font-weight: 500; }
  .card a:hover { text-decoration: underline; }
  .size { color: #6b7280; font-size: 12px; margin-left: 8px; }
  .time { color: #9ca3af; font-size: 12px; float: right; }
  .empty { color: #9ca3af; font-style: italic; }
  pre { background: #0f172a; color: #e5e7eb; padding: 12px; border-radius: 6px; overflow-x: auto; }
  button { background: #1d4ed8; color: white; border: 0; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: #1e40af; }
</style>
</head>
<body>
  <h1>APS MRP 报告下载</h1>
  <div class="meta">
    基地: ${config.sites.join(', ')} ·
    缓存命中: ${(() => {
        const stats = cachePool.allStats();
        const totalHits = Object.values(stats).reduce((a, s) => a + s.hits, 0);
        const totalMisses = Object.values(stats).reduce((a, s) => a + s.misses, 0);
        const total = totalHits + totalMisses;
        return total === 0 ? '0%' : ((totalHits / total) * 100).toFixed(1) + '%';
    })()} ·
    TTL: ${config.cache.ttlSeconds}s
  </div>
  <div id="root">加载中...</div>
  <script>
    async function load() {
      const r = await fetch('/api/files');
      const data = await r.json();
      const root = document.getElementById('root');
      if (Object.keys(data).length === 0) {
        root.innerHTML = '<p class="empty">暂无报告，请确认 MRP 任务已跑完</p>';
        return;
      }
      root.innerHTML = Object.entries(data).map(([site, files]) => {
        if (!files.length) return '<h2>' + site + '</h2><p class="empty">无文件</p>';
        return '<h2>' + site + '</h2>' + files.map(f =>
          '<div class="card">' +
            '<a href="/api/download/' + site + '/' + encodeURIComponent(f.name) + '">' + f.name + '</a>' +
            '<span class="size">' + (f.size/1024).toFixed(1) + ' KB</span>' +
            '<span class="time">' + new Date(f.mtime).toLocaleString('zh-CN') + '</span>' +
            '<button style="margin-left:12px" onclick="del(\\'' + site + '\\',\\'' + f.name + '\\')">删除</button>' +
          '</div>'
        ).join('');
      }).join('');
    }
    async function del(site, name) {
      if (!confirm('确认删除 ' + site + '/' + name + ' ?')) return;
      const r = await fetch('/api/files/' + site + '/' + encodeURIComponent(name), { method: 'DELETE' });
      if (r.ok) load();
      else alert('删除失败: ' + r.statusText);
    }
    load();
  </script>
</body>
</html>`;
}

function jsonResponse(res: http.ServerResponse, code: number, body: any): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}

function streamFile(res: http.ServerResponse, filePath: string, downloadName: string): void {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
        'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
}

function notFound(res: http.ServerResponse, msg = 'Not Found'): void {
    jsonResponse(res, 404, { error: msg });
}

function badRequest(res: http.ServerResponse, msg: string): void {
    jsonResponse(res, 400, { error: msg });
}

export function startHttpServer(outputDir: string): http.Server {
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host}`);
            const p = url.pathname;

        // 健康检查
        if (p === '/health' || p === '/api/health') {
            const stats = cachePool.allStats();
            const totalHits = Object.values(stats).reduce((a, s) => a + s.hits, 0);
            const totalMisses = Object.values(stats).reduce((a, s) => a + s.misses, 0);
            return jsonResponse(res, 200, {
                status: 'ok',
                sites: config.sites,
                cache: { hits: totalHits, misses: totalMisses, ttl: config.cache.ttlSeconds },
                uptime: process.uptime(),
            });
        }

        // 简易 HTML
        if (p === '/' || p === '/index.html') {
            const html = renderAdmin();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
            return res.end(html);
        }

        // 管理后台路由（含 HTML + JSON API）
        if (await handleAdmin(req, res, p, url)) return;

        // 已处理基地列表
        if (p === '/api/sites') {
            return jsonResponse(res, 200, { sites: config.sites });
        }

        // 所有基地的文件
        if (p === '/api/files') {
            const out: Record<string, any[]> = {};
            for (const s of config.sites) {
                out[s] = listFilesForSite(s, outputDir);
            }
            return jsonResponse(res, 200, out);
        }

        // 单个基地的文件
        const siteMatch = p.match(/^\/api\/files\/([^/]+)$/);
        if (siteMatch) {
            const site = siteMatch[1];
            if (!config.sites.includes(site)) return badRequest(res, `unknown site: ${site}`);
            return jsonResponse(res, 200, listFilesForSite(site, outputDir));
        }

        // 下载
        const dlMatch = p.match(/^\/api\/download\/([^/]+)\/(.+)$/);
        if (dlMatch) {
            const site = dlMatch[1];
            const file = decodeURIComponent(dlMatch[2]);
            if (!config.sites.includes(site)) return badRequest(res, `unknown site: ${site}`);
            const filePath = safeJoin(path.join(outputDir, site), file);
            if (!filePath || !fs.existsSync(filePath)) return notFound(res, 'file not found');
            return streamFile(res, filePath, file);
        }

        // 删除
        if (req.method === 'DELETE') {
            const delMatch = p.match(/^\/api\/files\/([^/]+)\/(.+)$/);
            if (delMatch) {
                const site = delMatch[1];
                const file = decodeURIComponent(delMatch[2]);
                if (!config.sites.includes(site)) return badRequest(res, `unknown site: ${site}`);
                const filePath = safeJoin(path.join(outputDir, site), file);
                if (!filePath || !fs.existsSync(filePath)) return notFound(res, 'file not found');
                fs.unlinkSync(filePath);
                return jsonResponse(res, 200, { ok: true, deleted: `${site}/${file}` });
            }
        }

            notFound(res);
        } catch (error) {
            console.error('[http] request failed:', error);
            if (!res.headersSent) {
                jsonResponse(res, 500, {
                    error: (error as Error).message || 'Internal Server Error',
                });
            } else {
                res.end();
            }
        }
    });

    server.listen(PORT, HOST, () => {
        console.log(`[http] 下载服务已启动 → http://${HOST}:${PORT}`);
        console.log(`[http] 浏览器打开: http://localhost:${PORT}/`);
    });

    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[http] 端口 ${PORT} 被占用，自动改用 ${PORT + 1}`);
            server.listen(PORT + 1, HOST);
        } else {
            console.error('[http] 启动失败:', err);
        }
    });

    return server;
}
