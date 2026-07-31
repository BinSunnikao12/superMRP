/**
 * src/admin/web.ts
 * ============================================================
 * APS MRP 管理后台（HTML + JSON API）
 *
 * 端点：
 *   GET  /admin                — 管理主页（HTML，3 个 tab）
 *   GET  /api/admin/raw/summary — 16 张 raw_* 表 + pull_state 总览（按 site 分组）
 *   GET  /api/admin/raw/:table  — 查 raw 表（带分页 + 搜索）
 *   GET  /api/admin/pull/log    — pull_log 最近 20 条
 *   POST /api/admin/pull/one    — 触发单个 apiKey 拉取
 *
 * 设计：
 *   - 3 个 tab 切换（Dashboard / Log / Query）
 *   - 字段中文 label（用 src/admin/schema.ts）
 *   - 分页 50 行/页
 *   - 紧凑布局：flex 居中 + sticky thead，无最大滚动条
 */
import * as http from 'http';
import { URL } from 'url';
import { mysqlPool } from '../data/dbPools';
import { config } from '../config';
import { RAW_SCHEMA } from './schema';

const RAW_TABLES = Object.keys(RAW_SCHEMA);

/** HTML 转义 */
function esc(s: any): string {
    if (s == null) return '';
    return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]!));
}

/** JSON API 响应 */
function jsonResponse(res: http.ServerResponse, code: number, body: any): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
}

/** HTML 响应 */
function htmlResponse(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
}

// ============================================================================
// HTML 渲染：3 个 tab + 紧凑布局
// ============================================================================
function renderAdmin(): string {
    const tableOptions = RAW_TABLES.map(t => `<option value="${t}">${t}</option>`).join('');
    const sites = config.sites.join(', ') || 'LG,YN,QU,FN,GX';
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>APS MRP 管理后台</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;font-size:13px}
  /* header 紧凑 */
  header{background:linear-gradient(90deg,#1e293b,#334155);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #475569}
  header h1{margin:0;font-size:16px;font-weight:600;color:#f1f5f9}
  header .meta{font-size:11px;color:#94a3b8}
  /* tabs */
  .tabs{display:flex;background:#1e293b;padding:0 20px;border-bottom:1px solid #334155}
  .tab{padding:10px 16px;cursor:pointer;color:#94a3b8;font-size:13px;border-bottom:2px solid transparent;transition:all 0.2s}
  .tab:hover{color:#e2e8f0}
  .tab.active{color:#60a5fa;border-bottom-color:#3b82f6;font-weight:600}
  /* 内容区：紧凑布局，高度自适应 */
  .container{padding:14px 20px;max-width:1600px;margin:0 auto}
  .panel{display:none}
  .panel.active{display:block}
  /* 卡片 */
  .card{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:12px;margin-bottom:10px}
  .card h2{margin:0 0 8px;font-size:13px;color:#93c5fd;font-weight:600}
  /* 表格 */
  table{width:100%;border-collapse:collapse;font-size:12px;table-layout:auto}
  th,td{padding:5px 8px;border-bottom:1px solid #334155;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
  th{background:#0f172a;color:#93c5fd;position:sticky;top:0;z-index:1;font-weight:600;font-size:11px;text-transform:none}
  tr:hover td{background:#334155}
  /* dashboard 卡片网格 */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
  .site-card{background:#0f172a;border:1px solid #334155;border-radius:5px;padding:10px}
  .site-card h3{margin:0 0 6px;font-size:13px;color:#60a5fa}
  .site-card .metric{display:flex;justify-content:space-between;font-size:11px;margin:2px 0;color:#cbd5e1}
  .site-card .metric span:last-child{color:#fbbf24;font-weight:600}
  /* 输入控件 */
  input,select{padding:4px 8px;background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:3px;font-size:12px}
  button{padding:4px 10px;border:0;border-radius:3px;cursor:pointer;font-size:12px;background:#3b82f6;color:#fff;margin-left:4px}
  button:hover{background:#2563eb}
  button:disabled{background:#475569;cursor:wait}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;color:#fff}
  .badge-ok{background:#16a34a}
  .badge-fail{background:#dc2626}
  .badge-running{background:#eab308;color:#000}
  code{background:#0f172a;padding:1px 5px;border-radius:2px;font-size:11px;color:#fbbf24;font-family:ui-monospace,Menlo,monospace}
  /* 分页 */
  .pagination{margin-top:10px;text-align:right;color:#94a3b8;font-size:12px}
  .pagination button{margin:0 2px;padding:2px 8px;font-size:11px}
  .pagination .cur{background:#3b82f6}
  /* 表格内长字段 */
  .truncate{max-width:200px;overflow:hidden;text-overflow:ellipsis}
  .null-val{color:#64748b;font-style:italic}
</style>
</head>
<body>
<header>
  <h1>📦 APS MRP 管理后台</h1>
  <div class="meta">据点: <code>${sites}</code> · 缓存 TTL: ${config.cache.ttlSeconds}s</div>
</header>
<div class="tabs">
  <div class="tab active" data-tab="dashboard">① 拉取状态总览</div>
  <div class="tab" data-tab="log">② 拉取日志</div>
  <div class="tab" data-tab="query">③ Raw 数据查询</div>
</div>
<div class="container">

<!-- Panel 1: Dashboard -->
<div id="panel-dashboard" class="panel active">
  <div class="card"><h2>22 张 Raw 表总览（按 site 分组）</h2><div id="dashboard-grid" class="grid">加载中...</div></div>
</div>

<!-- Panel 2: Log -->
<div id="panel-log" class="panel">
  <div class="card"><h2>最近 20 条 pull_log</h2><div id="log-list">加载中...</div></div>
</div>

<!-- Panel 3: Query -->
<div id="panel-query" class="panel">
  <div class="card">
    <h2>Raw 数据查询（带分页 + 中文 label + 搜索）</h2>
    <div style="margin-bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:8px">
      <label>表：</label>
      <select id="qTable">${tableOptions}</select>
      <label>据点：</label>
      <select id="qSite">
        <option value="">全部</option>
        <option value="ALL">ALL</option>
        <option value="LG">LG</option>
        <option value="YN">YN</option>
        <option value="QU">QU</option>
        <option value="FN">FN</option>
        <option value="GX">GX</option>
      </select>
      <label>搜索：</label>
      <input id="qSearch" placeholder="料号 / 单号 / 关键字" style="width:200px" />
      <button id="qGo">查询</button>
      <button id="qReset">重置</button>
      <span id="qInfo" style="margin-left:auto;color:#94a3b8"></span>
    </div>
    <div id="qResult" style="max-height:60vh;overflow:auto;border:1px solid #334155;border-radius:4px"></div>
    <div id="qPager" class="pagination"></div>
  </div>
</div>

</div>

<script>
const API = '/api/admin';

// ============ Tab 切换 ============
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('panel-' + t.dataset.tab);
    target.classList.add('active');
    if (t.dataset.tab === 'dashboard') loadDashboard();
    if (t.dataset.tab === 'log') loadLog();
    if (t.dataset.tab === 'query') loadQuery(1);
  });
});

// ============ Dashboard ============
async function loadDashboard() {
  const r = await fetch(API + '/raw/summary');
  const data = await r.json();
  const grid = document.getElementById('dashboard-grid');
  const sites = ['ALL','LG','YN','QU','FN','GX'];
  let html = '';
  for (const site of sites) {
    const rows = data.tables.filter(t => (site === 'ALL' ? true : t.latest_site === site));
    const totalRows = rows.reduce((s, t) => s + (t.count || 0), 0);
    const lastPulled = rows.reduce((max, t) => {
      if (!t.last_pulled) return max;
      return !max || new Date(t.last_pulled) > new Date(max) ? t.last_pulled : max;
    }, null);
    html += '<div class="site-card">' +
      '<h3>' + site + (site === 'ALL' ? '（所有据点）' : '') + '</h3>' +
      '<div class="metric"><span>表数</span><span>' + rows.length + '</span></div>' +
      '<div class="metric"><span>总行数</span><span>' + totalRows.toLocaleString() + '</span></div>' +
      '<div class="metric"><span>最后拉取</span><span>' + (lastPulled ? new Date(lastPulled).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '<i style="color:#64748b">无</i>') + '</span></div>' +
      '</div>';
  }
  grid.innerHTML = html;
}

// ============ Log ============
async function loadLog() {
  const r = await fetch(API + '/pull/log');
  const data = await r.json();
  if (!data.logs || data.logs.length === 0) {
    document.getElementById('log-list').innerHTML = '<i style="color:#64748b">暂无日志</i>';
    return;
  }
  const rows = data.logs.map(l => {
    const dur = l.duration_ms ? (l.duration_ms/1000).toFixed(1) + 's' : '-';
    const cls = l.status === 'ok' ? 'badge-ok' : (l.status === 'failed' ? 'badge-fail' : 'badge-running');
    return '<tr>' +
      '<td><code>' + esc(l.site) + '</code></td>' +
      '<td><code>' + esc(l.api_key) + '</code></td>' +
      '<td>' + new Date(l.started_at).toLocaleString('zh-CN') + '</td>' +
      '<td>' + dur + '</td>' +
      '<td style="text-align:right">' + (l.total_rows || 0).toLocaleString() + '</td>' +
      '<td><span class="badge ' + cls + '">' + esc(l.status) + '</span></td>' +
      '<td class="truncate" style="color:#f87171">' + (l.error ? esc(l.error.slice(0, 80)) : '') + '</td>' +
      '</tr>';
  }).join('');
  document.getElementById('log-list').innerHTML =
    '<table><thead><tr><th>据点</th><th>接口</th><th>开始</th><th>耗时</th><th>行数</th><th>状态</th><th>错误</th></tr></thead><tbody>' +
    rows + '</tbody></table>';
}

// ============ Query ============
let currentPage = 1;
const PAGE_SIZE = 50;

async function loadQuery(page = 1) {
  currentPage = page;
  const table = document.getElementById('qTable').value;
  const site = document.getElementById('qSite').value;
  const search = document.getElementById('qSearch').value;
  const params = new URLSearchParams();
  if (site) params.set('site', site);
  if (search) params.set('search', search);
  params.set('page', String(page));
  params.set('pageSize', String(PAGE_SIZE));

  document.getElementById('qResult').innerHTML = '<i style="color:#94a3b8;padding:20px;display:block;text-align:center">加载中...</i>';
  const r = await fetch(API + '/raw/' + table + '?' + params.toString());
  const data = await r.json();
  if (!data.rows || data.rows.length === 0) {
    document.getElementById('qResult').innerHTML = '<i style="color:#64748b;padding:20px;display:block;text-align:center">无数据</i>';
    document.getElementById('qPager').innerHTML = '';
    document.getElementById('qInfo').textContent = '0 行';
    return;
  }

  // 用 schema 中文 label 作表头
  const COLS = window.__SCHEMA__[table] || [];
  const labelByName = {};
  COLS.forEach(c => labelByName[c.name] = c.label);

  const cols = COLS.length > 0 ? COLS.map(c => c.name).filter(n => n in data.rows[0]) : Object.keys(data.rows[0]);
  const headHtml = cols.map(n => '<th title="' + esc(labelByName[n] || n) + '">' + esc(labelByName[n] || n) + '</th>').join('');
  const bodyHtml = data.rows.map(r =>
    '<tr>' + cols.map(n => {
      const v = r[n];
      let cell;
      if (v == null) cell = '<span class="null-val">null</span>';
      else if (v instanceof Date) cell = v.toLocaleString('zh-CN');
      else if (typeof v === 'object') cell = '<code>' + esc(JSON.stringify(v).slice(0, 60)) + '</code>';
      else {
        const s = String(v);
        cell = s.length > 60 ? esc(s.slice(0, 60)) + '...' : esc(s);
      }
      return '<td title="' + esc(String(v)) + '">' + cell + '</td>';
    }).join('') + '</tr>'
  ).join('');
  document.getElementById('qResult').innerHTML =
    '<table><thead><tr>' + headHtml + '</tr></thead><tbody>' + bodyHtml + '</tbody></table>';

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));
  document.getElementById('qInfo').textContent = '第 ' + currentPage + ' / ' + totalPages + ' 页 · 共 ' + (data.total || 0).toLocaleString() + ' 行';
  document.getElementById('qPager').innerHTML =
    '<button onclick="loadQuery(1)" ' + (currentPage === 1 ? 'disabled' : '') + '>« 首页</button>' +
    '<button onclick="loadQuery(' + (currentPage - 1) + ')" ' + (currentPage === 1 ? 'disabled' : '') + '>‹ 上一页</button>' +
    '<span style="margin:0 8px">' + currentPage + ' / ' + totalPages + '</span>' +
    '<button onclick="loadQuery(' + (currentPage + 1) + ')" ' + (currentPage >= totalPages ? 'disabled' : '') + '>下一页 ›</button>' +
    '<button onclick="loadQuery(' + totalPages + ')" ' + (currentPage >= totalPages ? 'disabled' : '') + '>末页 »</button>';
}

document.getElementById('qGo').addEventListener('click', () => loadQuery(1));
document.getElementById('qReset').addEventListener('click', () => {
  document.getElementById('qSearch').value = '';
  document.getElementById('qSite').value = '';
  loadQuery(1);
});
document.getElementById('qTable').addEventListener('change', () => loadQuery(1));
document.getElementById('qSite').addEventListener('change', () => loadQuery(1));
document.getElementById('qSearch').addEventListener('keypress', e => { if (e.key === 'Enter') loadQuery(1); });

// 默认表
document.getElementById('qTable').value = 'raw_base';

// 初始化：把 schema 嵌入页面供前端用
window.__SCHEMA__ = ${JSON.stringify(RAW_SCHEMA)};

// 默认加载 Dashboard
loadDashboard();
loadLog();
</script>
</body>
</html>`;
}

// ============================================================================
// API handlers
// ============================================================================
async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, p: string, urlObj: URL): Promise<boolean> {
    // HTML
    if (p === '/admin' || p === '/admin/') {
        htmlResponse(res, renderAdmin());
        return true;
    }

    // ① summary：所有 raw_* 表行数 + 最后拉取（按 site 分）
    if (p === '/api/admin/raw/summary') {
        const conn = await mysqlPool().getConnection();
        try {
            const tables: any[] = [];
            for (const t of RAW_TABLES) {
                // count + latest pulled_at + latest site（按 max(id) 找 site）
                const [c] = await conn.execute(`SELECT COUNT(*) AS c FROM ${t}`);
                const [p2] = await conn.execute(
                    `SELECT MAX(pulled_at) AS last, MAX(id) AS mid FROM ${t}`,
                ) as any;
                let latestSite: string | null = null;
                if (p2[0]?.mid) {
                    const [s2] = await conn.execute(
                        `SELECT site FROM ${t} WHERE id = ?`, [p2[0].mid],
                    ) as any;
                    latestSite = s2[0]?.site || null;
                }
                tables.push({
                    name: t,
                    count: (c as any[])[0].c,
                    last_pulled: p2[0]?.last ? new Date(p2[0].last).toISOString() : null,
                    latest_site: latestSite,
                });
            }
            jsonResponse(res, 200, { tables });
        } finally { conn.release(); }
        return true;
    }

    // ③ 查询 raw 表（带分页 + 中文 label 列头）
    const m = p.match(/^\/api\/admin\/raw\/(.+)$/);
    if (m) {
        const table = m[1];
        if (!RAW_TABLES.includes(table)) {
            jsonResponse(res, 400, { error: 'unknown table: ' + table });
            return true;
        }
        const site = urlObj.searchParams.get('site') || '';
        const search = urlObj.searchParams.get('search') || '';
        const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1', 10));
        const pageSize = Math.min(500, Math.max(1, parseInt(urlObj.searchParams.get('pageSize') || '50', 10)));
        const offset = (page - 1) * pageSize;

        // 安全的列名列表（用 schema 定义的列）
        const COLS = RAW_SCHEMA[table] || [];
        const allowedCols = COLS.map(c => c.name);
        const conn = await mysqlPool().getConnection();
        try {
            const where: string[] = ['1=1'];
            const params: any[] = [];
            if (site) { where.push('site = ?'); params.push(site); }
            if (search) {
                // 在所有 VARCHAR 列上做 LIKE（避免 SQL 注入：表/列都是白名单）
                const searchable = allowedCols.filter(c => /_(no|code|name|id|doc|docno|uom)$/i.test(c) || ['part_no','sub_part','main_part','pmdo001','pmdl004','pmaal003','cgd','sfba006','sfbadocno','cc_name'].includes(c));
                if (searchable.length > 0) {
                    const like = '%' + search + '%';
                    where.push('(' + searchable.map(c => `CAST(${c} AS CHAR) LIKE ?`).join(' OR ') + ')');
                    params.push(...searchable.map(() => like));
                }
            }
            const whereSql = 'WHERE ' + where.join(' AND ');

            const [rows] = await conn.execute(
                `SELECT * FROM ${table} ${whereSql} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`,
                params,
            ) as any;
            const [c] = await conn.execute(
                `SELECT COUNT(*) AS c FROM ${table} ${whereSql}`, params,
            ) as any;

            // 把 Date 对象转 ISO 字符串方便前端
            const normalized = (rows as any[]).map(r => {
                const out: any = {};
                for (const k of Object.keys(r)) {
                    const v = r[k];
                    if (v instanceof Date) out[k] = v.toISOString();
                    else out[k] = v;
                }
                return out;
            });

            jsonResponse(res, 200, {
                table,
                columns: COLS,                // 中文 label
                rows: normalized,
                total: (c as any[])[0].c,
                page, pageSize,
            });
        } finally { conn.release(); }
        return true;
    }

    // ② 拉取日志（最近 20 条）
    if (p === '/api/admin/pull/log') {
        const conn = await mysqlPool().getConnection();
        try {
            const [rows] = await conn.execute(
                `SELECT site, api_key, started_at, finished_at, duration_ms, page_count, total_rows, status, error
                 FROM pull_log ORDER BY id DESC LIMIT 20`,
            ) as any;
            const normalized = (rows as any[]).map(r => {
                const out: any = {};
                for (const k of Object.keys(r)) {
                    const v = r[k];
                    out[k] = v instanceof Date ? v.toISOString() : v;
                }
                return out;
            });
            jsonResponse(res, 200, { logs: normalized });
        } finally { conn.release(); }
        return true;
    }

    return false;
}

export { handleAdmin, renderAdmin };
