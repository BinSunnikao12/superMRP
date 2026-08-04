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
  /* Raw 查询：左侧字段对照，右侧数据表 */
  .query-layout{display:grid;grid-template-columns:minmax(440px,36%) minmax(0,1fr);gap:10px;align-items:start}
  .field-guide{max-height:60vh;overflow:auto;border:1px solid #334155;border-radius:4px;background:#0f172a}
  .field-guide h3{position:sticky;top:0;z-index:2;margin:0;padding:8px;background:#172033;border-bottom:1px solid #334155;color:#93c5fd;font-size:12px}
  .field-guide table{table-layout:fixed}
  .field-guide th,.field-guide td{padding:5px 7px;max-width:180px}
  .field-guide td:first-child{color:#fbbf24;font-family:ui-monospace,Menlo,monospace}
  .query-table{max-height:60vh;overflow:auto;border:1px solid #334155;border-radius:4px}
  .empty-row{text-align:center;color:#64748b;padding:24px}
  @media (max-width:900px){.query-layout{grid-template-columns:1fr}.field-guide{max-height:240px}}
  /* 实时同步：工业运行控制台 */
  .sync-hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#111827 0%,#172554 55%,#0f172a 100%);border:1px solid #1d4ed8;border-radius:10px;padding:20px;margin-bottom:12px}
  .sync-hero:after{content:"";position:absolute;width:260px;height:260px;border:42px solid rgba(59,130,246,.08);border-radius:50%;right:-90px;top:-120px}
  .sync-head{position:relative;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .sync-kicker{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#60a5fa;margin-bottom:7px}
  .sync-title{font-size:24px;font-weight:700;letter-spacing:-.02em;color:#f8fafc;margin:0 0 5px}
  .sync-sub{color:#94a3b8;font-size:12px}
  .live-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid #334155;border-radius:999px;background:rgba(15,23,42,.75);font-size:11px;font-weight:700}
  .live-dot{width:8px;height:8px;border-radius:50%;background:#64748b}.is-live .live-dot{background:#22c55e;box-shadow:0 0 0 5px rgba(34,197,94,.13);animation:pulse 1.6s infinite}.is-failed .live-dot{background:#ef4444;box-shadow:0 0 0 5px rgba(239,68,68,.12)}
  @keyframes pulse{50%{box-shadow:0 0 0 9px rgba(34,197,94,0)}}
  .global-progress{position:relative;z-index:1;margin-top:22px}.progress-meta{display:flex;justify-content:space-between;align-items:end;margin-bottom:8px}.progress-number{font-size:34px;line-height:1;font-weight:750;color:#f8fafc;font-variant-numeric:tabular-nums}.progress-detail{text-align:right;color:#94a3b8;font-size:11px;line-height:1.7}
  .track{height:8px;background:#0f172a;border:1px solid #334155;border-radius:999px;overflow:hidden}.fill{height:100%;width:0;background:linear-gradient(90deg,#2563eb,#38bdf8,#22c55e);border-radius:999px;transition:width .5s ease}
  .sync-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.sync-stat{background:#111827;border:1px solid #334155;border-radius:7px;padding:11px}.sync-stat .label{color:#64748b;font-size:10px;letter-spacing:.08em;text-transform:uppercase}.sync-stat .value{color:#e2e8f0;font-size:17px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .site-progress-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:9px}.progress-card{background:#111827;border:1px solid #334155;border-radius:8px;padding:12px;transition:border-color .2s,transform .2s}.progress-card:hover{border-color:#475569;transform:translateY(-1px)}.progress-card.running{border-color:#1d4ed8}.progress-card.completed{border-color:#166534}.progress-card.failed{border-color:#7f1d1d}
  .progress-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.site-name{font-size:15px;font-weight:750;color:#f8fafc}.stage{font-size:10px;padding:2px 7px;border-radius:999px;background:#1e293b;color:#94a3b8}.running .stage{background:#172554;color:#60a5fa}.completed .stage{background:#052e16;color:#4ade80}.failed .stage{background:#450a0a;color:#f87171}
  .site-counts{display:flex;justify-content:space-between;margin-top:8px;color:#94a3b8;font-size:10px}.site-counts strong{color:#e2e8f0;font-weight:650}.sync-foot{display:flex;justify-content:space-between;color:#64748b;font-size:10px;margin-top:10px}
  @media(max-width:760px){.sync-head{display:block}.live-pill{margin-top:12px}.sync-stats{grid-template-columns:repeat(2,1fr)}.progress-number{font-size:28px}}
</style>
</head>
<body>
<header>
  <h1>📦 APS MRP 管理后台</h1>
  <div class="meta">据点: <code>${sites}</code> · 缓存 TTL: ${config.cache.ttlSeconds}s</div>
</header>
<div class="tabs">
  <div class="tab active" data-tab="monitor">① 实时同步</div>
  <div class="tab" data-tab="dashboard">② 数据总览</div>
  <div class="tab" data-tab="log">③ 拉取日志</div>
  <div class="tab" data-tab="query">④ Raw 数据查询</div>
</div>
<div class="container">

<!-- Panel 0: Real-time sync monitor -->
<div id="panel-monitor" class="panel active">
  <div id="sync-monitor" class="sync-hero">加载实时进度...</div>
  <div class="sync-stats">
    <div class="sync-stat"><div class="label">当前对象</div><div class="value">raw_base</div></div>
    <div class="sync-stat"><div class="label">同步阶段</div><div id="sync-stage" class="value">检测中</div></div>
    <div class="sync-stat"><div class="label">实时速度</div><div id="sync-speed" class="value">计算中</div></div>
    <div class="sync-stat"><div class="label">预计剩余</div><div id="sync-eta" class="value">计算中</div></div>
  </div>
  <div class="card"><h2>站点进度</h2><div id="site-progress-grid" class="site-progress-grid">加载中...</div></div>
</div>

<!-- Panel 1: Dashboard -->
<div id="panel-dashboard" class="panel">
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
    <div class="query-layout">
      <aside id="qFields" class="field-guide"></aside>
      <div id="qResult" class="query-table"></div>
    </div>
    <div id="qPager" class="pagination"></div>
  </div>
</div>

</div>

<script>
const API = '/api/admin';
let previousSyncSample = null;

// 浏览器端也需要独立的 HTML 转义函数；服务端同名函数不会进入页面脚本作用域。
function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[<>&"]/g, c => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;'
  })[c]);
}

// ============ Tab 切换 ============
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('panel-' + t.dataset.tab);
    target.classList.add('active');
    if (t.dataset.tab === 'monitor') loadSyncMonitor();
    if (t.dataset.tab === 'dashboard') loadDashboard();
    if (t.dataset.tab === 'log') loadLog();
    if (t.dataset.tab === 'query') loadQuery(1);
  });
});

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '计算中';
  if (seconds < 60) return Math.ceil(seconds) + ' 秒';
  if (seconds < 3600) return Math.ceil(seconds / 60) + ' 分钟';
  return (seconds / 3600).toFixed(1) + ' 小时';
}

function checkpointStage(c, live) {
  if (c.status === 'completed') return '已完成';
  if (c.status === 'failed') return '等待续传';
  if (!live) return '无活动';
  if (Number(c.last_completed_page) >= Number(c.total_pages)) return '校验与收尾';
  return '分页拉取';
}

async function loadSyncMonitor() {
  const r = await fetch(API + '/raw/summary');
  const data = await r.json();
  const checkpoints = data.checkpoints || [];
  const serverNow = new Date(data.server_time || Date.now()).getTime();
  const totalRows = checkpoints.reduce((s, c) => s + Number(c.total_rows || 0), 0);
  const pulledRows = checkpoints.reduce((s, c) => s + Number(c.pulled_rows || 0), 0);
  const percent = totalRows ? pulledRows / totalRows * 100 : 0;
  const liveRows = checkpoints.filter(c => c.status === 'running' && serverNow - new Date(c.updated_at).getTime() < 30000);
  const hasFailure = checkpoints.some(c => c.status === 'failed');
  const allDone = checkpoints.length > 0 && checkpoints.every(c => c.status === 'completed');
  const isLive = liveRows.length > 0;
  let statusText = '尚未开始';
  let statusClass = '';
  let phase = '等待任务';
  if (allDone) { statusText = '同步已完成'; phase = '完成校验'; }
  else if (isLive) { statusText = '正在同步'; statusClass = 'is-live'; phase = liveRows.some(c => Number(c.last_completed_page) < Number(c.total_pages)) ? '分页拉取' : '校验收尾'; }
  else if (hasFailure) { statusText = '同步已中断'; statusClass = 'is-failed'; phase = '等待续传'; }
  else if (checkpoints.length) { statusText = '暂未检测到活动'; phase = '状态检查'; }

  let speed = 0;
  const now = Date.now();
  if (previousSyncSample && pulledRows >= previousSyncSample.rows) {
    speed = (pulledRows - previousSyncSample.rows) / Math.max(1, (now - previousSyncSample.time) / 1000);
  }
  previousSyncSample = { rows: pulledRows, time: now };
  const remaining = Math.max(0, totalRows - pulledRows);
  document.getElementById('sync-stage').textContent = phase;
  document.getElementById('sync-speed').textContent = speed > 0 ? Math.round(speed).toLocaleString() + ' 行/秒' : '采样中';
  document.getElementById('sync-eta').textContent = speed > 0 ? formatDuration(remaining / speed) : '计算中';

  const latest = checkpoints.reduce((max, c) => Math.max(max, new Date(c.updated_at || 0).getTime()), 0);
  const windowText = checkpoints[0]
    ? (checkpoints[0].mode === 'full' ? '全量起点' : esc(String(checkpoints[0].last_pull_time || '').slice(0,19))) +
      ' → ' + esc(String(checkpoints[0].upper_pull_time || '').slice(0,19))
    : '-';
  document.getElementById('sync-monitor').className = 'sync-hero ' + statusClass;
  document.getElementById('sync-monitor').innerHTML =
    '<div class="sync-head"><div><div class="sync-kicker">MRP DATA PIPELINE / LIVE</div>' +
    '<h2 class="sync-title">物料主表全量同步</h2><div class="sync-sub">接口 tiptop_query_imaf_t · 固定窗口 ' + windowText + '</div></div>' +
    '<div class="live-pill"><span class="live-dot"></span>' + statusText + '</div></div>' +
    '<div class="global-progress"><div class="progress-meta"><div class="progress-number">' + percent.toFixed(1) + '%</div>' +
    '<div class="progress-detail">' + pulledRows.toLocaleString() + ' / ' + totalRows.toLocaleString() + ' 行<br>剩余 ' + remaining.toLocaleString() + ' 行</div></div>' +
    '<div class="track"><div class="fill" style="width:' + Math.min(100, percent).toFixed(2) + '%"></div></div>' +
    '<div class="sync-foot"><span>每 3 秒刷新 · 30 秒无断点更新即判定非活动</span><span>最近更新 ' + (latest ? new Date(latest).toLocaleTimeString('zh-CN') : '-') + '</span></div></div>';

  document.getElementById('site-progress-grid').innerHTML = checkpoints.map(c => {
    const sitePercent = c.total_rows ? Number(c.pulled_rows) / Number(c.total_rows) * 100 : 0;
    const live = c.status === 'running' && serverNow - new Date(c.updated_at).getTime() < 30000;
    const visualStatus = c.status === 'completed' ? 'completed' : (c.status === 'failed' || !live ? 'failed' : 'running');
    return '<div class="progress-card ' + visualStatus + '"><div class="progress-card-head"><span class="site-name">' + esc(c.site) + '</span><span class="stage">' + checkpointStage(c, live) + '</span></div>' +
      '<div class="track"><div class="fill" style="width:' + Math.min(100, sitePercent).toFixed(2) + '%"></div></div>' +
      '<div class="site-counts"><span>页 <strong>' + c.last_completed_page + ' / ' + c.total_pages + '</strong></span><span><strong>' + sitePercent.toFixed(1) + '%</strong></span></div>' +
      '<div class="site-counts"><span>累计 <strong>' + Number(c.pulled_rows || 0).toLocaleString() + '</strong></span><span>剩余 <strong>' + Math.max(0, Number(c.total_rows)-Number(c.pulled_rows)).toLocaleString() + '</strong></span></div></div>';
  }).join('') || '<i style="color:#64748b">暂无同步断点</i>';
}

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
    const checkpoint = (data.checkpoints || []).find(c => c.site === site);
    const progress = checkpoint && checkpoint.total_pages > 0
      ? ((checkpoint.last_completed_page / checkpoint.total_pages) * 100).toFixed(1) + '%'
      : (checkpoint ? '100.0%' : '-');
    html += '<div class="site-card">' +
      '<h3>' + site + (site === 'ALL' ? '（所有据点）' : '') + '</h3>' +
      '<div class="metric"><span>表数</span><span>' + rows.length + '</span></div>' +
      '<div class="metric"><span>总行数</span><span>' + totalRows.toLocaleString() + '</span></div>' +
      '<div class="metric"><span>最后拉取</span><span>' + (lastPulled ? new Date(lastPulled).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '<i style="color:#64748b">无</i>') + '</span></div>' +
      (checkpoint ?
        '<div class="metric"><span>raw_base 断点</span><span>' + esc(checkpoint.status) + '</span></div>' +
        '<div class="metric"><span>页进度</span><span>' + checkpoint.last_completed_page + ' / ' + checkpoint.total_pages + '（' + progress + '）</span></div>' +
        '<div class="metric"><span>已拉行数</span><span>' + Number(checkpoint.pulled_rows || 0).toLocaleString() + '</span></div>'
        : '') +
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

function getQueryColumns(table, rows = []) {
  const schemaCols = window.__SCHEMA__[table] || [];
  return schemaCols.length > 0 ? schemaCols.map(c => c.name) : (rows[0] ? Object.keys(rows[0]) : []);
}

function renderFieldGuide(table) {
  const schemaCols = window.__SCHEMA__[table] || [];
  const rows = schemaCols.map(c =>
    '<tr><td title="' + esc(c.name) + '">' + esc(c.name) + '</td>' +
    '<td title="' + esc(c.label) + '">' + esc(c.label) + '</td>' +
    '<td title="' + esc(c.sourceTable || '-') + '">' + esc(c.sourceTable || '-') + '</td>' +
    '<td title="' + esc(c.sourceField || '-') + '">' + esc(c.sourceField || '-') + '</td></tr>'
  ).join('');
  document.getElementById('qFields').innerHTML =
    '<h3>字段对照（' + schemaCols.length + '）</h3>' +
    '<table><thead><tr><th>本地字段</th><th>中文名称</th><th>来源表</th><th>原数据库字段</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="4" class="empty-row">暂无字段定义</td></tr>') +
    '</tbody></table>';
}

function renderQueryTable(table, rows, loading = false) {
  const schemaCols = window.__SCHEMA__[table] || [];
  const labelByName = {};
  schemaCols.forEach(c => labelByName[c.name] = c.label);
  const cols = getQueryColumns(table, rows);
  const headHtml = cols.map(n => '<th title="' + esc(n) + '">' + esc(labelByName[n] || n) + '</th>').join('');
  let bodyHtml;
  if (loading) {
    bodyHtml = '<tr><td colspan="' + Math.max(1, cols.length) + '" class="empty-row">加载中...</td></tr>';
  } else if (!rows || rows.length === 0) {
    bodyHtml = '<tr><td colspan="' + Math.max(1, cols.length) + '" class="empty-row">暂无数据</td></tr>';
  } else {
    bodyHtml = rows.map(r =>
      '<tr>' + cols.map(n => {
        const v = r[n];
        let cell;
        if (v == null) cell = '<span class="null-val">null</span>';
        else if (typeof v === 'object') cell = '<code>' + esc(JSON.stringify(v).slice(0, 60)) + '</code>';
        else {
          const s = String(v);
          cell = s.length > 60 ? esc(s.slice(0, 60)) + '...' : esc(s);
        }
        return '<td title="' + esc(String(v)) + '">' + cell + '</td>';
      }).join('') + '</tr>'
    ).join('');
  }
  document.getElementById('qResult').innerHTML =
    '<table><thead><tr>' + headHtml + '</tr></thead><tbody>' + bodyHtml + '</tbody></table>';
}

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

  renderFieldGuide(table);
  renderQueryTable(table, [], true);
  const r = await fetch(API + '/raw/' + table + '?' + params.toString());
  const data = await r.json();
  if (!data.rows || data.rows.length === 0) {
    renderQueryTable(table, []);
    document.getElementById('qPager').innerHTML = '';
    document.getElementById('qInfo').textContent = '0 行';
    return;
  }

  renderQueryTable(table, data.rows);

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

// #/pages/patient/index 映射到实时同步页；保留 hash 兼容现有访问地址。
if (location.hash === '#/pages/patient/index') {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'monitor'));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-monitor'));
}
loadSyncMonitor();
loadDashboard();
loadLog();
setInterval(loadSyncMonitor, 3000);
setInterval(loadDashboard, 10000);
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
            let checkpoints: any[] = [];
            const [exists] = await conn.execute(
                `SELECT COUNT(*) AS c FROM information_schema.tables
                 WHERE table_schema = DATABASE() AND table_name = 'raw_base_pull_checkpoint'`,
            ) as any;
            if (Number(exists[0]?.c || 0) > 0) {
                const [rows] = await conn.execute(
                    `SELECT site, api_key, mode, last_pull_time, upper_pull_time,
                            total_rows, total_pages, last_completed_page,
                            pulled_rows, status, error, started_at, updated_at
                     FROM raw_base_pull_checkpoint ORDER BY site`,
                ) as any;
                checkpoints = rows;
            }
            jsonResponse(res, 200, {
                tables,
                checkpoints,
                server_time: new Date().toISOString(),
            });
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
