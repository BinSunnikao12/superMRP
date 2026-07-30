/**
 * src/admin/web.ts
 * ============================================================
 * APS MRP 管理界面（HTML + JSON API）
 *
 * 端点：
 *   GET  /admin                — 管理主页（HTML）
 *   GET  /api/admin/raw/summary   — 21 张 raw_* 表的 row_count + 最后拉取时间
 *   GET  /api/admin/raw/:table    — 查指定 raw 表（带分页 + 搜索）
 *   GET  /api/admin/pull/log      — pull_log 列表（最近 50 条）
 *   POST /api/admin/pull/one      — 触发单个 apiKey 拉取（同步等待）
 */
import * as http from 'http';
import { URL } from 'url';
import { mysqlPool } from '../data/dbPools';
import { config } from '../config';
import { pullSite } from '../phases/puller';

const RAW_TABLES = [
    'raw_base', 'raw_bom', 'raw_need', 'raw_remain', 'raw_cj', 'raw_in_transit',
    'raw_purchase_order', 'raw_buyer', 'raw_testfunc', 'raw_production_supply',
    'raw_items', 'raw_safetystock', 'raw_substitute', 'raw_outsourcing_type',
    'raw_gd01', 'raw_gd_bom',
];

/** 简单的 HTML 转义 */
function esc(s: any): string {
    if (s == null) return '';
    return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]!));
}

function jsonResponse(res: http.ServerResponse, code: number, body: any): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}

function htmlResponse(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
}

function renderAdmin(): string {
    const tableList = RAW_TABLES.map(t =>
        `<button class="tbl-btn" onclick="loadTable('${t}')">${t}</button>`
    ).join(' ');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>APS MRP 管理后台</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
  header{background:#1e293b;padding:16px 24px;border-bottom:1px solid #334155}
  header h1{margin:0;font-size:20px}
  .container{padding:24px;max-width:1400px;margin:0 auto}
  .card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:16px}
  .card h2{margin:0 0 12px;font-size:15px;color:#93c5fd}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:6px 10px;border-bottom:1px solid #334155;text-align:left;white-space:nowrap}
  th{background:#0f172a;color:#93c5fd;position:sticky;top:0;z-index:1;font-weight:600}
  tr:hover{background:#334155}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
  .badge-ok{background:#16a34a;color:#fff}
  .badge-fail{background:#dc2626;color:#fff}
  .badge-run{background:#eab308;color:#000}
  .btn{padding:4px 10px;border:0;border-radius:4px;cursor:pointer;font-size:12px;background:#3b82f6;color:#fff;margin:2px}
  .btn:hover{background:#2563eb}
  .tbl-btn{padding:6px 12px;background:#475569;color:#fff;border:0;border-radius:4px;cursor:pointer;margin:2px}
  .tbl-btn:hover{background:#64748b}
  .tbl-btn.active{background:#3b82f6}
  input,select{padding:6px 10px;background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:4px}
  code{background:#0f172a;padding:2px 6px;border-radius:3px;font-size:12px}
</style>
</head>
<body>
<header><h1>📦 APS MRP 管理后台</h1></header>
<div class="container">

<div class="card">
  <h2>① 拉取状态总览</h2>
  <div id="summary">加载中...</div>
</div>

<div class="card">
  <h2>② 拉取日志（最近 20 条）</h2>
  <div id="logs">加载中...</div>
</div>

<div class="card">
  <h2>③ Raw 数据查询</h2>
  <div>选择表：
    ${tableList}
  </div>
  <div style="margin:12px 0">
    <label>搜索 (part_no / imafsite / sub_part 等任意列 LIKE)：</label>
    <input id="searchInput" placeholder="例如 27502232.459" style="width:300px" />
    <label>site：</label>
    <select id="siteFilter">
      <option value="">全部</option>
      <option value="ALL">ALL</option>
      <option value="LG">LG</option>
      <option value="YN">YN</option>
      <option value="QU">QU</option>
      <option value="FN">FN</option>
      <option value="GX">GX</option>
    </select>
    <button class="btn" onclick="loadTable(currentTable)">查询</button>
    <span id="rowCount" style="margin-left:12px;color:#93c5fd"></span>
  </div>
  <div id="tableData" style="max-height:600px;overflow:auto">点击上方表名开始查询</div>
</div>

<div class="card">
  <h2>④ 触发拉取</h2>
  <div>
    选基地：
    <select id="pullSite">
      ${config.sites.map(s => `<option value="${s}">${s}</option>`).join('')}
    </select>
    <button class="btn" onclick="triggerPull()">▶ 全 16 接口拉取（耗时 ~10-30 分钟）</button>
    <span id="pullStatus" style="margin-left:12px"></span>
  </div>
</div>

</div>

<script>
let currentTable = 'raw_base';

async function loadSummary() {
  const r = await fetch('/api/admin/raw/summary');
  const data = await r.json();
  const tbl = '<table><tr><th>表名</th><th>行数</th><th>最后拉取</th></tr>'
    + data.tables.map(t => \`<tr>
        <td><code>\${t.name}</code></td>
        <td style="text-align:right">\${t.count.toLocaleString()}</td>
        <td>\${t.last_pulled || '<i style="color:#64748b">未拉取</i>'}</td>
       </tr>\`).join('')
    + '</table>';
  document.getElementById('summary').innerHTML = tbl;
}

async function loadLogs() {
  const r = await fetch('/api/admin/pull/log');
  const data = await r.json();
  const tbl = '<table><tr><th>基地</th><th>接口</th><th>开始</th><th>耗时</th><th>行数</th><th>状态</th><th>错误</th></tr>'
    + data.logs.map(l => \`<tr>
        <td>\${l.site}</td>
        <td><code>\${l.api_key}</code></td>
        <td>\${new Date(l.started_at).toLocaleString('zh-CN')}</td>
        <td>\${l.duration_ms ? (l.duration_ms/1000).toFixed(1) + 's' : '-'}</td>
        <td style="text-align:right">\${(l.total_rows || 0).toLocaleString()}</td>
        <td><span class="badge badge-\${l.status}">\${l.status}</span></td>
        <td style="color:#f87171">\${l.error ? l.error.slice(0, 50) : ''}</td>
       </tr>\`).join('')
    + '</table>';
  document.getElementById('logs').innerHTML = tbl;
}

async function loadTable(t) {
  currentTable = t;
  document.querySelectorAll('.tbl-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  const search = document.getElementById('searchInput').value;
  const site = document.getElementById('siteFilter').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (site) params.set('site', site);
  params.set('limit', '50');
  document.getElementById('tableData').innerHTML = '加载中...';
  const r = await fetch('/api/admin/raw/' + t + '?' + params.toString());
  const data = await r.json();
  if (!data.rows || data.rows.length === 0) {
    document.getElementById('tableData').innerHTML = '<i style="color:#64748b">无数据</i>';
    document.getElementById('rowCount').textContent = '0 行';
    return;
  }
  const cols = Object.keys(data.rows[0]);
  const tbl = '<table><tr>' + cols.map(c => \`<th>\${c}</th>\`).join('') + '</tr>'
    + data.rows.map(r => '<tr>' + cols.map(c => \`<td>\${escapeHtml(r[c])}</td>\`).join('') + '</tr>').join('')
    + '</table>';
  document.getElementById('tableData').innerHTML = tbl;
  document.getElementById('rowCount').textContent = data.rows.length + ' / ' + (data.total || '?') + ' 行';
}

function escapeHtml(v) {
  if (v == null) return '<i style="color:#64748b">null</i>';
  const s = String(v);
  return s.length > 80 ? s.slice(0, 80) + '...' : s;
}

async function triggerPull() {
  const site = document.getElementById('pullSite').value;
  document.getElementById('pullStatus').innerHTML = '<span style="color:#eab308">⏳ 拉取中...</span>';
  try {
    const r = await fetch('/api/admin/pull/one?site=' + site);
    const data = await r.json();
    document.getElementById('pullStatus').innerHTML =
      '<span style="color:#16a34a">✓ 完毕 ' + data.total_rows + ' 行 / ' + data.duration_ms + 'ms</span>';
    loadSummary();
    loadLogs();
  } catch (e) {
    document.getElementById('pullStatus').innerHTML = '<span style="color:#dc2626">✗ 失败 ' + e.message + '</span>';
  }
}

loadSummary();
loadLogs();
</script>
</body>
</html>`;
}

async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, p: string, urlObj: URL): Promise<boolean> {
    if (p === '/admin' || p === '/admin/') {
        htmlResponse(res, renderAdmin());
        return true;
    }

    if (p === '/api/admin/raw/summary') {
        const conn = await mysqlPool().getConnection();
        try {
            const tables: any[] = [];
            for (const t of RAW_TABLES) {
                const [c] = await conn.execute(`SELECT COUNT(*) AS c FROM ${t}`);
                const [p2] = await conn.execute(
                    `SELECT MAX(pulled_at) AS last FROM ${t}`
                ) as any;
                tables.push({
                    name: t,
                    count: (c as any[])[0].c,
                    last_pulled: (p2 as any[])[0].last ? new Date((p2 as any[])[0].last).toISOString() : null,
                });
            }
            jsonResponse(res, 200, { tables });
        } finally { conn.release(); }
        return true;
    }

    const m = p.match(/^\/api\/admin\/raw\/(.+)$/);
    if (m) {
        const table = m[1];
        if (!RAW_TABLES.includes(table)) {
            jsonResponse(res, 400, { error: 'unknown table' });
            return true;
        }
        const search = urlObj.searchParams.get('search') || '';
        const site = urlObj.searchParams.get('site') || '';
        const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '50', 10), 500);
        const conn = await mysqlPool().getConnection();
        try {
            let where = 'WHERE 1=1';
            const params: any[] = [];
            if (site) { where += ' AND site = ?'; params.push(site); }
            if (search) { where += ' AND (CAST(part_no AS CHAR) LIKE ? OR CAST(sub_part AS CHAR) LIKE ? OR CAST(pmdo001 AS CHAR) LIKE ? OR CAST(cc_name AS CHAR) LIKE ?)'; const like = '%' + search + '%'; params.push(like, like, like, like); }
            const [rows] = await conn.execute(
                `SELECT * FROM ${table} ${where} ORDER BY id DESC LIMIT ${limit}`, params
            ) as any;
            const [c2] = await conn.execute(`SELECT COUNT(*) AS c FROM ${table} ${where}`, params) as any;
            jsonResponse(res, 200, { rows: rows as any[], total: (c2 as any[])[0].c });
        } finally { conn.release(); }
        return true;
    }

    if (p === '/api/admin/pull/log') {
        const conn = await mysqlPool().getConnection();
        try {
            const [rows] = await conn.execute(
                `SELECT site, api_key, started_at, finished_at, duration_ms, page_count, total_rows, status, error
                 FROM pull_log ORDER BY id DESC LIMIT 50`,
            ) as any;
            jsonResponse(res, 200, { logs: rows as any[] });
        } finally { conn.release(); }
        return true;
    }

    if (p === '/api/admin/pull/one' && req.method === 'POST') {
        const site = urlObj.searchParams.get('site') || 'LG';
        const t0 = Date.now();
        // 简单复用 puller 入口
        try {
            const { pullSite } = await import('../phases/puller');
            // pullSite 内部会写 pull_log；这里只关心总耗时
            await pullSite(site);
            jsonResponse(res, 200, { ok: true, total_rows: 0, duration_ms: Date.now() - t0 });
        } catch (e: any) {
            jsonResponse(res, 500, { ok: false, error: e.message });
        }
        return true;
    }

    return false;
}

export { handleAdmin, renderAdmin };
