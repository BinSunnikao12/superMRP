/**
 * src/admin/web.ts
 * ============================================================
 * APS MRP 管理后台（HTML + JSON API）
 *
 * 端点：
 *   GET  /admin                — 管理主页（HTML，3 个 tab）
 *   GET  /api/admin/raw/summary — 16 张 raw_* 表 + pull_state 总览（按 site 分组）
 *   GET  /api/admin/raw/:table  — 查 raw 表（带分页 + 搜索）
 *   GET  /api/admin/pull/log    — pull_log 分页与筛选
 *   POST /api/admin/pull/one    — 触发单个 apiKey 拉取
 *
 * 设计：
 *   - 3 个 tab 切换（Dashboard / Log / Query）
 *   - 字段中文 label（用 src/admin/schema.ts）
 *   - 分页 50 行/页
 *   - 紧凑布局：flex 居中 + sticky thead，无最大滚动条
 */
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { URL } from 'url';
import { mysqlPool } from '../data/dbPools';
import { config } from '../config';
import { RAW_SCHEMA } from './schema';

const RAW_TABLES = Object.keys(RAW_SCHEMA);

interface AdminSyncJob {
    mode: 'full' | 'sample';
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
    finishedAt?: string;
    currentSite?: string;
    currentApi?: string;
    rows: number;
    exitCode?: number;
    lines: string[];
}

let activeSyncProcess: ChildProcess | null = null;
let activeSyncJob: AdminSyncJob | null = null;

function appendSyncOutput(chunk: Buffer): void {
    if (!activeSyncJob) return;
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
        activeSyncJob.lines.push(line);
        if (activeSyncJob.lines.length > 80) activeSyncJob.lines.shift();
        const site = line.match(/基地\s+([A-Z]+)\s+开始拉取/);
        if (site) activeSyncJob.currentSite = site[1];
        const page = line.match(/\[([^\]]+)\].*total\s+(\d+)/);
        if (page) {
            activeSyncJob.currentApi = page[1];
            activeSyncJob.rows = Number(page[2]);
        }
    }
}

function startModuleSync(mode: 'full' | 'sample'): AdminSyncJob {
    if (activeSyncProcess && activeSyncJob?.status === 'running') {
        throw new Error('已有同步任务正在运行');
    }
    const script = path.resolve(process.cwd(), 'dist/phases/puller.js');
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (mode === 'sample') env.PULL_ROW_LIMIT = '1000';
    else delete env.PULL_ROW_LIMIT;
    activeSyncJob = {
        mode,
        status: 'running',
        startedAt: new Date().toISOString(),
        rows: 0,
        lines: [],
    };
    const child = spawn(process.execPath, [script, 'all'], {
        cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeSyncProcess = child;
    child.stdout?.on('data', appendSyncOutput);
    child.stderr?.on('data', appendSyncOutput);
    child.on('close', code => {
        if (!activeSyncJob) return;
        activeSyncJob.exitCode = code ?? 1;
        activeSyncJob.status = code === 0 ? 'completed' : 'failed';
        activeSyncJob.finishedAt = new Date().toISOString();
        activeSyncProcess = null;
    });
    return activeSyncJob;
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) reject(new Error('request body too large'));
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('invalid json')); }
        });
        req.on('error', reject);
    });
}

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
  body{font-family:"Avenir Next","DIN Alternate","Noto Sans SC",sans-serif;margin:0;background:#0a1017;color:#e2e8f0;font-size:13px;background-image:linear-gradient(rgba(148,163,184,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.025) 1px,transparent 1px);background-size:24px 24px}
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
  .brand{display:flex;align-items:center;gap:11px}.brand-mark{width:34px;height:34px;display:grid;place-items:center;border:1px solid #f59e0b;background:#111827;color:#fbbf24;font:800 11px/1 "DIN Alternate",sans-serif;box-shadow:5px 5px 0 #422006}.brand-copy strong{display:block;font-size:15px;letter-spacing:.06em}.brand-copy span{font-size:9px;letter-spacing:.2em;color:#64748b}
  .workbench-hero{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.55fr);gap:12px;margin-bottom:12px}.command-card{position:relative;overflow:hidden;background:linear-gradient(125deg,#111923 0%,#132233 60%,#17200f 100%);border:1px solid #334155;border-left:4px solid #f59e0b;border-radius:4px;padding:22px}.command-card:before{content:"MRP";position:absolute;right:-8px;bottom:-35px;font:900 116px/1 "DIN Alternate",sans-serif;color:rgba(255,255,255,.025)}.eyebrow{font-size:10px;letter-spacing:.22em;color:#f59e0b;text-transform:uppercase}.command-card h2{font-size:29px;letter-spacing:-.035em;margin:7px 0 5px;color:#f8fafc}.command-card p{max-width:680px;color:#94a3b8;margin:0;line-height:1.8}.command-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}.action-btn{position:relative;margin:0;padding:10px 15px;border:1px solid #475569;border-radius:3px;background:#17202b;color:#e2e8f0;font-weight:750;letter-spacing:.02em}.action-btn:hover{background:#202b38;border-color:#64748b}.action-btn.primary{background:#d97706;border-color:#f59e0b;color:#160c02}.action-btn.primary:hover{background:#f59e0b}.action-btn.compute{background:#0f766e;border-color:#14b8a6}.action-note{font-size:10px;color:#64748b;align-self:center}
  .shift-card{background:#101820;border:1px solid #263442;border-radius:4px;padding:17px}.shift-label{font-size:9px;letter-spacing:.2em;color:#64748b}.shift-status{font-size:22px;font-weight:800;margin:7px 0;color:#e2e8f0}.shift-line{height:1px;background:#263442;margin:13px 0}.shift-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px}.shift-meta b{display:block;font-size:16px;color:#f8fafc}.shift-meta span{font-size:9px;color:#64748b;letter-spacing:.08em}.run-terminal{margin-top:12px;background:#070b0f;border:1px solid #263442;border-radius:3px;padding:10px;height:92px;overflow:auto;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc}
  .formula-strip{display:grid;grid-template-columns:1.25fr repeat(4,1fr);gap:8px;margin-bottom:12px}.formula-main,.formula-chip{background:#101820;border:1px solid #263442;border-radius:4px;padding:13px}.formula-main{border-top:3px solid #f59e0b}.formula-main small,.formula-chip small{display:block;color:#64748b;font-size:9px;letter-spacing:.12em;margin-bottom:7px}.formula-main strong{font:700 14px/1.5 ui-monospace,monospace;color:#fbbf24}.formula-chip b{font-size:13px;color:#e2e8f0}.formula-chip p{font-size:10px;color:#64748b;margin:5px 0 0;line-height:1.5}
  .mrp-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}.mrp-toolbar h2{margin:0;font-size:14px;color:#e2e8f0}.mrp-toolbar select{min-width:100px}.preview-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}.preview-metric{padding:12px;background:#0c131b;border:1px solid #263442;border-radius:3px}.preview-metric span{display:block;color:#64748b;font-size:9px;letter-spacing:.1em}.preview-metric b{display:block;margin-top:4px;font-size:19px;font-variant-numeric:tabular-nums}.preview-metric.alert b{color:#fb923c}.net-positive{color:#fb923c;font-weight:800}.supply-value{color:#5eead4}.mrp-result{border:1px solid #263442;overflow:visible}.mode-badge{display:inline-block;padding:2px 7px;border:1px solid #475569;border-radius:999px;font-size:9px;color:#94a3b8}
  .freshness{display:flex;gap:14px;flex-wrap:wrap;color:#64748b;font-size:10px}.freshness b{color:#cbd5e1;font-weight:650}
  .formula-value{cursor:help;text-decoration:underline dotted rgba(251,191,36,.45);text-underline-offset:3px}.formula-tooltip{display:none;position:fixed;z-index:1000;max-width:420px;padding:11px 13px;border:1px solid #f59e0b;border-radius:4px;background:#080d13;color:#dbeafe;box-shadow:0 12px 36px rgba(0,0,0,.55);white-space:pre-line;font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none}.formula-tooltip.visible{display:block}
  .bom-link{cursor:zoom-in;border-bottom:1px dashed #f59e0b}.bom-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}.bom-title{font-size:22px;font-weight:800;color:#f8fafc}.bom-sub{margin-top:5px;color:#64748b;font-size:11px}.bom-path{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:10px 0;color:#94a3b8}.bom-node{padding:3px 8px;border:1px solid #334155;background:#0f172a;color:#fbbf24;border-radius:3px}.drillable{color:#fbbf24}.leaf{color:#64748b}.bom-actions{display:flex;gap:7px;align-items:center}
  .mrp-filters{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 10px}.mrp-filters input{min-width:220px}.sort-btn{background:#17202b;border:1px solid #475569}.sort-btn.active{background:#0f766e;border-color:#14b8a6}.bom-count{color:#fbbf24;font-weight:750}
  /* ===== 两栏工作区: 左解释 / 右表格+BOM ===== */
  .mrp-workspace{display:grid;grid-template-columns:minmax(340px,0.4fr) minmax(0,1fr);gap:12px;align-items:start}
  .mrp-explain{position:sticky;top:8px;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:14px;max-height:calc(100vh - 24px);overflow:auto}
  .mrp-explain-head{padding-bottom:8px;border-bottom:1px solid #263442;margin-bottom:10px}
  .mrp-list{min-width:0;display:flex;flex-direction:column;gap:10px}
  .mrp-detail-card{padding:14px}
  /* 公式解释 */
  .explain-block{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #263442}
  .explain-block:last-child{border-bottom:0;margin-bottom:0}
  .explain-h4{font-size:11px;color:#fbbf24;letter-spacing:.12em;margin:0 0 8px;text-transform:uppercase}
  .explain-step{display:inline-block;padding:5px 10px;border:1px solid #475569;background:#0f172a;border-radius:3px;font-size:12px;color:#cbd5e1;margin:2px 0}
  .explain-step.highlight{border-color:#f59e0b;background:#422006;color:#fde68a;font-weight:600}
  .explain-arrow{font-size:10px;color:#475569;margin:3px 0 3px 12px;font-family:ui-monospace,monospace}
  .explain-split{display:flex;gap:6px;margin:4px 0 4px 12px}
  .explain-branch{flex:1;padding:4px 8px;border:1px dashed #475569;border-radius:3px;font-size:11px;color:#94a3b8;text-align:center}
  .formula-row{padding:4px 8px;margin-bottom:3px;background:#0c131b;border:1px solid #1e293b;border-radius:3px;font-size:11px;font-family:ui-monospace,monospace;color:#cbd5e1;cursor:help;transition:border-color .15s}
  .formula-row:hover{border-color:#f59e0b;background:#172033}
  .formula-row b{color:#fbbf24}
  .glossary{display:grid;grid-template-columns:1fr 1fr;gap:3px}
  .glossary-row{padding:3px 6px;font-size:11px;background:#0c131b;border:1px solid #1e293b;border-radius:2px;cursor:help}
  .glossary-row:hover{border-color:#f59e0b}
  .glossary-row b{color:#93c5fd;display:block;font-size:10px}
  .glossary-row span{color:#64748b;font-size:10px}
  /* 响应式: 屏幕窄时降为单列 */
  @media(max-width:1180px){.mrp-workspace{grid-template-columns:1fr}.mrp-explain{position:static;max-height:480px}}
  .mrp-detail-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #263442}
  .mrp-detail-title{font-size:13px;font-weight:700;color:#93c5fd}
  .mrp-detail-back{background:#17202b;border:1px solid #475569;color:#cbd5e1;margin:0;padding:4px 10px}
  .mrp-detail-back:hover{background:#202b38}
  .mrp-detail-body{min-height:140px}
  .mrp-empty{padding:36px 12px;text-align:center;color:#64748b;font-size:12px;line-height:1.7}
  .mrp-empty .arrow{font-size:24px;color:#475569;margin-bottom:10px;display:block}
  .mrp-detail table{table-layout:fixed}
  .mrp-detail th{background:#0a1017;font-size:10px}
  .mrp-detail td{padding:4px 6px;font-size:11px;max-width:160px}
  .bom-list-item{padding:7px 9px;background:#0c131b;border:1px solid #1e293b;border-radius:3px;margin-bottom:5px;cursor:pointer;transition:border-color .15s}
  .bom-list-item:hover{border-color:#f59e0b;background:#101820}
  .bom-list-item.selected{border-color:#f59e0b;background:#172033}
  .bom-list-item b{color:#fbbf24;font-family:ui-monospace,Menlo,monospace}
  .bom-list-item .qty{color:#94a3b8;font-size:11px;margin-left:6px}
  /* 响应式: 屏幕窄时降为单列 */
  @media(max-width:1180px){.mrp-workspace{grid-template-columns:1fr}.mrp-detail{position:static;max-height:560px}}
  @media(max-width:1000px){.workbench-hero{grid-template-columns:1fr}.formula-strip{grid-template-columns:1fr 1fr}.preview-metrics{grid-template-columns:1fr 1fr}}@media(max-width:620px){.formula-strip{grid-template-columns:1fr}.preview-metrics{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div class="brand"><div class="brand-mark">APS</div><div class="brand-copy"><strong>物料需求计划控制台</strong><span>MANUFACTURING RESOURCE SIGNAL SYSTEM</span></div></div>
  <div class="meta">据点: <code>${sites}</code> · 缓存 TTL: ${config.cache.ttlSeconds}s</div>
</header>
<div class="tabs">
  <div class="tab active" data-tab="workbench">MRP 工作台</div>
  <div class="tab" data-tab="monitor">同步监控</div>
  <div class="tab" data-tab="dashboard">数据总览</div>
  <div class="tab" data-tab="log">运行日志</div>
  <div class="tab" data-tab="query">数据字典</div>
</div>
<div class="container">

<!-- Panel: MRP Workbench -->
<div id="panel-workbench" class="panel active">
  <div class="workbench-hero">
    <section class="command-card"><div class="eyebrow">Planning cycle / data command</div><h2>从源数据到净需求，一屏完成</h2><p>先选择样本或全量同步，再用当前 MySQL 快照生成净需求预览。同步不包含 raw_base；正式多级 BOM 计算将在下一阶段接入。</p><div class="command-actions"><button class="action-btn primary" id="syncSample">拉取每表 1000 条</button><button class="action-btn" id="syncFull">全量拉取其他模块</button><button class="action-btn compute" id="calcPreview">计算净需求预览</button><span class="action-note">五基地 · 失败保留旧快照 · 禁止并发</span></div></section>
    <aside class="shift-card"><div class="shift-label">CURRENT PLANNING RUN</div><div id="jobStatus" class="shift-status">等待指令</div><div class="shift-line"></div><div class="shift-meta"><div><b id="jobSite">—</b><span>当前基地</span></div><div><b id="jobRows">0</b><span>当前接口行数</span></div></div><div id="jobTerminal" class="run-terminal">系统就绪，等待同步任务。</div></aside>
  </div>
  <div class="formula-strip"><div class="formula-main"><small>核心净需求公式</small><strong>MAX(0, 毛需求 + 安全库存 − 库存 − 在制 − 特殊工单供给)</strong></div><div class="formula-chip"><small>毛需求</small><b>需求量 × QPA</b><p>工单/SFBA 与销售订单需求</p></div><div class="formula-chip"><small>使用顺序</small><b>库存 → 在制 → 特殊供给</b><p>按 Python demand() 顺序消耗</p></div><div class="formula-chip"><small>损耗与批量</small><b>CEIL(净需×损耗÷批量)</b><p>正式递归计算阶段应用</p></div><div class="formula-chip"><small>采购信号</small><b>在途 / 在验单列</b><p>不擅自抵扣 Python 净需求</p></div></div>
  <div class="mrp-workspace">
    <!-- 左栏: 公式解释 + 术语表（粘性, 可滚动） -->
    <aside class="mrp-explain" id="mrpExplain">
      <div class="mrp-explain-head">
        <div class="mrp-detail-title">核心运算逻辑 / 计算依赖</div>
        <div style="font-size:10px;color:#64748b;margin-top:3px">悬停单元格看公式 · 点击料号看 BOM</div>
      </div>
      <div class="mrp-explain-body">
        <!-- 流程图 -->
        <div class="explain-block">
          <div class="explain-step" data-tip="毛需求 = 需求量 × QPA(QPA 分子/QPA 分母)">① 毛需求</div>
          <div class="explain-arrow">↓ 扣库存 → 扣在制 → 扣 GD01</div>
          <div class="explain-step highlight" data-tip="净需求 = max(0, 毛需求 − 可用库存 − 可用在制 − GD01可用工单数)">② 净需求</div>
          <div class="explain-arrow">↓ 加损耗/批量取整</div>
          <div class="explain-step highlight" data-tip="最终净需求 = ceil(净需求 × (1+损耗率/100) / 批量) × 批量 (生产批量 IMAE017 当前固定 1)">③ 最终净需求</div>
          <div class="explain-arrow">↓ 分叉</div>
          <div class="explain-split">
            <div class="explain-branch" data-tip="外购件不再展开 BOM,走采购需求明细">外购 → 采购</div>
            <div class="explain-branch" data-tip="自制件按成本中心/料号/日期聚合后,先匹配已有工单供给(按日期先到先得),剩余为生产需求">自制 → 生产</div>
          </div>
        </div>

        <!-- 5 个关键公式 -->
        <div class="explain-block">
          <h4 class="explain-h4">关键公式</h4>
          <div class="formula-row" data-tip="<b>公式</b>: 毛需求 = 需求数量 × QPA\n<b>来源</b>: 父件需求 × BOM 用量\n<b>示例</b>: 100 件 × QPA=2 → 200"><b>1. 毛需求</b>=需求量 × QPA</div>
          <div class="formula-row" data-tip="<b>公式</b>: 净需求 = max(0, 毛需求 − 可用库存 − 可用在制 − GD01)\n<b>扣减顺序</b>: 库存 → 在制 → GD01 (消耗性)\n<b>示例</b>: 200 − 50 − 30 − 0 = 120"><b>2. 净需求</b>=毛需求−库存−在制−GD01</div>
          <div class="formula-row" data-tip="<b>公式</b>: 最终净需求 = ceil(净需求 × (1+损耗率/100) / 批量) × 批量\n<b>示例</b>: 100 × 1.05 / 1 × 1 = 105 (向上取整)"><b>3. 取整</b>=ceil(净需×(1+损耗)/批量)×批量</div>
          <div class="formula-row" data-tip="<b>公式</b>: 预计开工 = 预计完工 − 前置时间\n<b>前置</b>=MySQL配置 → 否则固定+变动+QC+累计\n<b>特例</b>: LG 喷塑车间+1天; 虚拟件=0"><b>4. 倒推</b>开工=完工−前置</div>
          <div class="formula-row" data-tip="<b>公式</b>: 齐套数 = min(子件库存/子件BOM用量), 初始=∞\n<b>含义</b>: 当前库存能凑齐多少整套\n<b>示例</b>: B1=100, B2=50/2=25, B3=60/3=20 → 齐套=min=20"><b>5. 齐套</b>=min(库存/用量)</div>
        </div>

        <!-- 术语表 -->
        <div class="explain-block">
          <h4 class="explain-h4">术语速查</h4>
          <div class="glossary">
            <div class="glossary-row" data-tip="<b>毛需求</b> Gross Requirement: 未扣库存的原始需求量"><b>毛需求</b><span>=需求×QPA</span></div>
            <div class="glossary-row" data-tip="<b>净需求</b> Net Requirement: 扣完库存/在制/工单供给后仍需生产的量"><b>净需求</b><span>扣减后</span></div>
            <div class="glossary-row" data-tip="<b>QPA</b> Quantity Per Assembly: BOM 单位用量 (分子/分母)"><b>QPA</b><span>单位用量</span></div>
            <div class="glossary-row" data-tip="<b>前置时间</b> Lead Time: 从开工到完工所需天数"><b>前置时间</b><span>天数</span></div>
            <div class="glossary-row" data-tip="<b>齐套数</b> Kit Qty: 当前库存能完整配套的最大套数"><b>齐套数</b><span>配套数</span></div>
            <div class="glossary-row" data-tip="<b>虚拟件</b> Phantom Item: 不入库的结构层,用量向下穿透相乘"><b>虚拟件</b><span>类别X</span></div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 右栏: 净需求表 + BOM 钻取(嵌在表下方) -->
    <div class="mrp-list">
      <div class="card mrp-toolbar-card">
        <div class="mrp-toolbar"><div><h2>净需求信号预览 <span class="mode-badge">服务端分页实时计算</span></h2><div id="previewFreshness" class="freshness"><span>尚未计算</span></div></div><div><label>基地 </label><select id="mrpSite"><option>LG</option><option>YN</option><option>QU</option><option>GX</option><option>FN</option></select></div></div>
        <div class="mrp-filters"><input id="mrpKeyword" placeholder="搜索料号、名称或规格"/><select id="mrpBomFilter"><option value="all">全部 BOM 状态</option><option value="hasBom">仅有下阶物料</option><option value="noBom">仅无下阶物料</option></select><select id="mrpShortageFilter"><option value="all">全部需求状态</option><option value="shortage">仅净需求 &gt; 0</option><option value="covered">仅净需求 = 0</option></select><label>每页</label><select id="mrpPageSize"><option>20</option><option selected>50</option><option>100</option></select><button id="mrpSearch">筛选</button><button id="mrpReset">重置</button><span style="color:#64748b;font-size:11px">排序</span><button class="sort-btn active" data-sort="net_desc">净需求 ↓</button><button class="sort-btn" data-sort="gross_desc">毛需求 ↓</button><button class="sort-btn" data-sort="bom_desc">下阶数 ↓</button><button class="sort-btn" data-sort="part_asc">料号 ↑</button></div>
        <div id="previewMetrics" class="preview-metrics"></div>
        <div id="mrpResult" class="mrp-result"><div class="empty-row">同步数据后，点击"计算净需求预览"</div></div>
        <div id="mrpPager" class="pagination"></div>
      </div>
      <!-- BOM 详情内嵌在右栏底部 -->
      <div class="card mrp-detail-card" id="mrpDetail">
        <div class="mrp-detail-head"><div class="mrp-detail-title">BOM 详情 / 下阶钻取</div></div>
        <div class="mrp-detail-body">
          <div class="mrp-empty">
            <span class="arrow">↑</span>
            在右侧表格中<strong>点击料号</strong>或<strong>"查看 BOM"按钮</strong><br/>
            这里会显示该料件的 BOM 结构 + 各级下阶数量
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="formulaTooltip" class="formula-tooltip"></div>

<!-- Panel 0: Real-time sync monitor -->
<div id="panel-monitor" class="panel">
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
  <div class="card">
    <div class="mrp-toolbar"><h2>拉取运行历史</h2><span id="logInfo" class="mode-badge">加载中</span></div>
    <div style="margin-bottom:10px;display:flex;align-items:center;flex-wrap:wrap;gap:8px">
      <label>基地</label><select id="logSite"><option value="">全部</option><option>LG</option><option>YN</option><option>QU</option><option>GX</option><option>FN</option></select>
      <label>状态</label><select id="logStatus"><option value="">全部</option><option value="ok">成功</option><option value="failed">失败</option><option value="running">运行中</option></select>
      <label>接口</label><input id="logApi" placeholder="输入接口关键字" />
      <label>每页</label><select id="logPageSize"><option>20</option><option selected>50</option><option>100</option></select>
      <button id="logSearch">查询</button><button id="logReset">重置</button>
    </div>
    <div id="log-list">加载中...</div><div id="logPager" class="pagination"></div>
  </div>
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

<!-- BOM 逐层钻取页 -->
<div id="panel-bom" class="panel">
  <div class="card">
    <div class="bom-head"><div><div class="eyebrow">BILL OF MATERIAL / LEVEL DRILLDOWN</div><div id="bomTitle" class="bom-title">BOM 结构</div><div id="bomMeta" class="bom-sub"></div></div><div class="bom-actions"><button id="bomBack">← 返回净需求</button><label>每页</label><select id="bomPageSize"><option>20</option><option selected>50</option><option>100</option></select></div></div>
    <div id="bomPath" class="bom-path"></div><div id="bomResult" class="query-table">加载中...</div><div id="bomPager" class="pagination"></div>
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

// ============ Tab hash 路由 ============
const TAB_ROUTES = {
  workbench: '#/mrp/workbench',
  monitor: '#/sync/monitor',
  dashboard: '#/data/overview',
  log: '#/pull/logs',
  query: '#/data/dictionary',
};
const LEGACY_ROUTES = {'#/pages/patient/index': 'workbench'};

function activateTab(tabName) {
  const safeTab = TAB_ROUTES[tabName] ? tabName : 'workbench';
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === safeTab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + safeTab));
  if (safeTab === 'workbench') { loadSyncJob(); loadMrpPreview(); }
  if (safeTab === 'monitor') loadSyncMonitor();
  if (safeTab === 'dashboard') loadDashboard();
  if (safeTab === 'log') loadLog(1);
  if (safeTab === 'query') loadQuery(1);
}

function activateCurrentRoute() {
  if (location.hash.startsWith('#/bom/explorer')) {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-bom'));
    loadBomFromRoute();
    return;
  }
  const tabName = LEGACY_ROUTES[location.hash] || Object.keys(TAB_ROUTES).find(name => TAB_ROUTES[name] === location.hash);
  if (!tabName) {
    history.replaceState(null, '', TAB_ROUTES.workbench);
    activateTab('workbench');
    return;
  }
  activateTab(tabName);
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    const route = TAB_ROUTES[t.dataset.tab];
    if (location.hash === route) activateTab(t.dataset.tab);
    else location.hash = route;
  });
});
window.addEventListener('hashchange', activateCurrentRoute);

async function startSync(mode) {
  const label = mode === 'sample' ? '每表 1000 条样本同步' : '全量模块同步';
  if (!confirm('确认开始' + label + '？任务覆盖五个基地，但不包含 raw_base。')) return;
  const buttons = [document.getElementById('syncSample'), document.getElementById('syncFull')];
  buttons.forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + '/sync/start', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '启动失败');
    renderSyncJob(data.job);
  } catch (e) { alert(e.message); }
  finally { buttons.forEach(b => b.disabled = false); }
}

function renderSyncJob(job) {
  const status = document.getElementById('jobStatus');
  if (!job) { status.textContent = '等待指令'; return; }
  status.textContent = job.status === 'running' ? (job.mode === 'sample' ? '样本同步中' : '全量同步中') : (job.status === 'completed' ? '同步完成' : '同步失败');
  status.style.color = job.status === 'completed' ? '#5eead4' : job.status === 'failed' ? '#fb7185' : '#fbbf24';
  document.getElementById('jobSite').textContent = job.currentSite || '准备中';
  document.getElementById('jobRows').textContent = Number(job.rows || 0).toLocaleString();
  const terminal = document.getElementById('jobTerminal');
  terminal.textContent = (job.lines || []).slice(-12).join('\\n') || '任务已启动，等待第一批数据…';
  terminal.scrollTop = terminal.scrollHeight;
  document.getElementById('syncSample').disabled = job.status === 'running';
  document.getElementById('syncFull').disabled = job.status === 'running';
}

async function loadSyncJob() {
  try { const r = await fetch(API + '/sync/status'); const data = await r.json(); renderSyncJob(data.job); } catch {}
}

function fmtQty(v) { return Number(v || 0).toLocaleString('zh-CN', {maximumFractionDigits:2}); }
function htmlEsc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function explainAttr(v) { return htmlEsc(v).replace(/\\n/g, '&#10;'); }
function qtyCell(value, className, formula, source) {
  const explanation = '公式：' + formula + '\\n来源：' + source + '\\n结果：' + fmtQty(value);
  return '<td class="formula-value ' + (className || '') + '" data-explain="' + explainAttr(explanation) + '">' + fmtQty(value) + '</td>';
}

let mrpCurrentPage = 1;
let mrpCurrentSort = 'net_desc';
async function loadMrpPreview(page = 1) {
  mrpCurrentPage = page;
  const site = document.getElementById('mrpSite').value;
  const bomFilter = document.getElementById('mrpBomFilter').value;
  const shortage = document.getElementById('mrpShortageFilter').value;
  const keyword = document.getElementById('mrpKeyword').value.trim();
  const pageSize = document.getElementById('mrpPageSize').value;
  const result = document.getElementById('mrpResult');
  result.innerHTML = '<div class="empty-row">正在汇总 ' + site + ' 的需求与供给信号…</div>';
  const params = new URLSearchParams({site,bomFilter,shortage,sort:mrpCurrentSort,page:String(page),pageSize});
  if (keyword) params.set('keyword', keyword);
  const r = await fetch(API + '/mrp/preview?' + params.toString());
  const data = await r.json();
  if (!r.ok) { result.innerHTML = '<div class="empty-row">' + htmlEsc(data.error || '计算失败') + '</div>'; return; }
  const s = data.summary;
  const calculatedAt = data.calculated_at ? new Date(data.calculated_at).toLocaleString('zh-CN') : '-';
  const snapshotAt = data.snapshot_at ? new Date(data.snapshot_at).toLocaleString('zh-CN') : '暂无快照';
  document.getElementById('previewFreshness').innerHTML =
    '<span>计算完成 <b>' + htmlEsc(calculatedAt) + '</b></span>' +
    '<span>耗时 <b>' + fmtQty(data.duration_ms) + ' ms</b></span>' +
    '<span>数据快照 <b>' + htmlEsc(snapshotAt) + '</b></span>';
  document.getElementById('previewMetrics').innerHTML =
    '<div class="preview-metric formula-value" data-explain="' + explainAttr('公式：筛选后 COUNT(DISTINCT 料号)\\n来源：raw_need、raw_remain、raw_cj、raw_special_supply、raw_safetystock\\n结果：' + fmtQty(s.materials)) + '"><span>筛选物料</span><b>' + fmtQty(s.materials) + '</b></div>' +
    '<div class="preview-metric formula-value" data-explain="' + explainAttr('公式：Σ(每个物料的毛需求)\\n来源：raw_need.qty × qpa_num ÷ qpa_den\\n结果：' + fmtQty(s.gross_demand)) + '"><span>毛需求合计</span><b>' + fmtQty(s.gross_demand) + '</b></div>' +
    '<div class="preview-metric alert formula-value" data-explain="' + explainAttr('公式：Σ MAX(0, 毛需求 + 安全库存 - 库存 - 在制 - 特殊供给)\\n来源：raw_need、raw_safetystock、raw_remain、raw_cj、raw_special_supply\\n结果：' + fmtQty(s.net_demand)) + '"><span>净需求合计</span><b>' + fmtQty(s.net_demand) + '</b></div>' +
    '<div class="preview-metric alert formula-value" data-explain="' + explainAttr('公式：COUNT(净需求 > 0 的料号)\\n来源：全部物料净需求计算结果\\n结果：' + fmtQty(s.shortage_materials)) + '"><span>缺料物料数</span><b>' + fmtQty(s.shortage_materials) + '</b></div>';
  const head = ['料号','品名 / 规格','毛需求','安全库存','可用库存','可用在制','特殊供给','净需求','在途','在验','下阶数','操作'];
  const rows = data.rows.map(x => {
    const netFormula = 'MAX(0, ' + fmtQty(x.gross_demand) + ' + ' + fmtQty(x.safety_stock) + ' - ' + fmtQty(x.available_stock) + ' - ' + fmtQty(x.available_wip) + ' - ' + fmtQty(x.special_supply) + ')';
    return '<tr><td><code class="bom-link ' + (x.has_bom ? '' : 'leaf') + '" data-site="' + htmlEsc(site) + '" data-part="' + htmlEsc(x.part_no) + '" title="' + (x.has_bom ? '双击查看 BOM' : '没有下阶 BOM') + '">' + htmlEsc(x.part_no) + '</code></td><td><b>' + htmlEsc(x.name || '') + '</b><br><span style="color:#64748b">' + htmlEsc(x.spec || '') + '</span></td>' +
      qtyCell(x.gross_demand, '', 'Σ(qty × qpa_num ÷ qpa_den)', 'raw_need.qty、qpa_num、qpa_den') +
      qtyCell(x.safety_stock, '', 'Σ(qty)', 'raw_safetystock.qty') +
      qtyCell(x.available_stock, 'supply-value', 'Σ(qty)', 'raw_remain.qty') +
      qtyCell(x.available_wip, 'supply-value', 'Σ(qty)', 'raw_cj.qty') +
      qtyCell(x.special_supply, 'supply-value', 'Σ(qty)', 'raw_special_supply.qty') +
      qtyCell(x.net_demand, 'net-positive', netFormula, '上述需求与供给字段实时计算') +
      qtyCell(x.in_transit, '', 'Σ(qty)，仅展示、暂不抵扣净需求', 'raw_in_transit.qty') +
      qtyCell(x.inspecting, '', 'Σ(qty)，仅展示、暂不抵扣净需求', 'raw_testfunc.qty') +
      '<td class="bom-count">' + Number(x.bom_count || 0).toLocaleString() + '</td>' +
      '<td>' + (x.has_bom ? '<button class="bom-open" data-site="' + htmlEsc(site) + '" data-part="' + htmlEsc(x.part_no) + '">查看 BOM (' + Number(x.bom_count || 0).toLocaleString() + ')</button>' : '<span class="leaf">无下阶</span>') + '</td></tr>';
  }).join('');
  result.innerHTML = '<table><thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + (rows || '<tr><td colspan="12" class="empty-row">没有符合筛选条件的物料</td></tr>') + '</tbody></table>';
  const totalPages = Math.max(1, data.totalPages || 1);
  document.getElementById('mrpPager').innerHTML = '<button onclick="loadMrpPreview(1)" ' + (page === 1 ? 'disabled' : '') + '>« 首页</button><button onclick="loadMrpPreview(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + '>‹ 上一页</button><span style="margin:0 8px">第 ' + page + ' / ' + totalPages + ' 页 · 共 ' + Number(data.total || 0).toLocaleString() + ' 条</span><button onclick="loadMrpPreview(' + (page + 1) + ')" ' + (page >= totalPages ? 'disabled' : '') + '>下一页 ›</button><button onclick="loadMrpPreview(' + totalPages + ')" ' + (page >= totalPages ? 'disabled' : '') + '>末页 »</button>';
}

const formulaTooltip = document.getElementById('formulaTooltip');
document.addEventListener('mouseover', e => {
  const target = e.target.closest && (e.target.closest('.formula-value') || e.target.closest('[data-tip]'));
  if (!target || !target.dataset.explain && !target.dataset.tip) return;
  formulaTooltip.innerHTML = target.dataset.explain || target.dataset.tip || '';
  formulaTooltip.classList.add('visible');
});
document.addEventListener('mousemove', e => {
  if (!formulaTooltip.classList.contains('visible')) return;
  formulaTooltip.style.left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - 440)) + 'px';
  formulaTooltip.style.top = Math.max(8, Math.min(e.clientY + 14, window.innerHeight - 180)) + 'px';
});
document.addEventListener('mouseout', e => {
  const target = e.target.closest && (e.target.closest('.formula-value') || e.target.closest('[data-tip]'));
  if (target && !target.contains(e.relatedTarget)) formulaTooltip.classList.remove('visible');
});

// ============ BOM 逐层钻取 ============
function bomRoute(site, part, page = 1, trail = []) {
  const params = new URLSearchParams({site,part,page:String(page),pageSize:document.getElementById('bomPageSize').value});
  if (trail.length) params.set('trail', JSON.stringify(trail));
  return '#/bom/explorer?' + params.toString();
}
function readBomTrail(params) {
  try { const trail = JSON.parse(params.get('trail') || '[]'); return Array.isArray(trail) ? trail.slice(-30) : []; }
  catch { return []; }
}
function openBom(site, part) {
  const params = bomParams();
  const currentPart = params.get('part');
  const trail = location.hash.startsWith('#/bom/explorer') && currentPart ? [...readBomTrail(params), currentPart] : [];
  location.hash = bomRoute(site, part, 1, trail);
}
function bomParams() {
  const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '';
  return new URLSearchParams(query);
}

// ============ BOM 详情渲染到右栏（v0.7 新增） ============
// 选中料件时,直接渲染到 #mrpDetail;不再切换整个 panel
let detailCurrentSite = '';
let detailCurrentPart = '';
let detailTrail = [];        // 面包屑轨迹)
let detailPage = 1;
let detailPageSize = 50;
let detailTotal = 0;
let detailTotalPages = 1;
let detailData = null;       // 最近一次 API 返回

async function selectPartForDetail(site, part) {
  detailCurrentSite = site;
  detailCurrentPart = part;
  detailTrail = [];
  detailPage = 1;
  await loadBomDetail();
}

async function loadBomDetail() {
  const detail = document.getElementById('mrpDetail');
  if (!detailCurrentPart) {
    detail.querySelector('.mrp-detail-body').innerHTML =
      '<div class="mrp-empty"><span class="arrow">←</span>在左侧表格中<strong>点击料号</strong>或<strong>"查看 BOM"按钮</strong><br/>这里会显示该料件的 BOM 结构 + 各级下阶数量</div>';
    return;
  }
  detail.querySelector('.mrp-detail-body').innerHTML =
    '<div class="empty-row">正在读取 ' + htmlEsc(detailCurrentPart) + ' 的 BOM…</div>';
  const apiParams = new URLSearchParams({
    site: detailCurrentSite,
    part: detailCurrentPart,
    page: String(detailPage),
    pageSize: String(detailPageSize),
  });
  const res = await fetch(API + '/bom/children?' + apiParams.toString());
  const data = await res.json();
  detailData = data;
  if (!res.ok) {
    detail.querySelector('.mrp-detail-body').innerHTML =
      '<div class="empty-row">' + htmlEsc(data.error || 'BOM 查询失败') + '</div>';
    return;
  }
  detailTotal = Number(data.total || 0);
  detailTotalPages = Math.max(1, detailTotal / detailPageSize);
  renderBomDetail();
}

function renderBomDetail() {
  const detail = document.getElementById('mrpDetail');
  const pathParts = [...detailTrail, detailCurrentPart];
  const head = document.createElement('div');
  head.className = 'mrp-detail-head';
  head.innerHTML =
    '<div class="mrp-detail-title">BOM 第 ' + (pathParts.length) + ' 层 · ' + htmlEsc(detailCurrentPart) +
    (detailData?.parent?.name ? ' · ' + htmlEsc(detailData.parent.name) : '') + '</div>' +
    '<button class="mrp-detail-back" id="mrpDetailClose">关闭</button>';
  detail.querySelector('.mrp-detail-head').replaceWith(head);

  const body = document.createElement('div');
  body.className = 'mrp-detail-body';

  // 面包屑
  if (detailTrail.length > 0) {
    const crumb = document.createElement('div');
    crumb.className = 'bom-path';
    crumb.innerHTML = detailTrail.map((node, idx) =>
      '<button class="bom-node bom-crumb-detail" data-index="' + idx + '">' + htmlEsc(node) + '</button>'
    ).join('<span>›</span>') + '<span>›</span>' +
      '<button class="bom-node bom-crumb-detail current">' + htmlEsc(detailCurrentPart) + '</button>';
    body.appendChild(crumb);
  }

  // 元信息
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:11px;color:#94a3b8;margin:6px 0 10px;line-height:1.6';
  meta.innerHTML =
    '基地 <b style="color:#e2e8f0">' + htmlEsc(detailCurrentSite) + '</b> · ' +
    '直接子件 <b style="color:#e2e8f0">' + detailTotal.toLocaleString() + '</b> 项 · ' +
    '快照 <b style="color:#e2e8f0">' + (detailData?.snapshot_at ? new Date(detailData.snapshot_at).toLocaleString('zh-CN') : '-') + '</b>';
  body.appendChild(meta);

  // 子件表格
  const tableWrap = document.createElement('div');
  if (!detailData.rows || detailData.rows.length === 0) {
    tableWrap.innerHTML = '<div class="empty-row">该物料没有下阶 BOM</div>';
  } else {
    let rowsHtml = '<table><thead><tr><th>项次</th><th>子件料号</th><th>名称 / 规格</th><th>组成用量</th><th>单位</th><th>主件/子件类别</th><th>操作</th></tr></thead><tbody>';
    detailData.rows.forEach(x => {
      rowsHtml += '<tr><td>' + htmlEsc(x.seq || '-') + '</td>' +
        '<td><code class="bom-link-detail ' + (x.has_children ? 'drillable' : 'leaf') + '" data-site="' + htmlEsc(detailCurrentSite) + '" data-part="' + htmlEsc(x.sub_part) + '">' + htmlEsc(x.sub_part) + '</code></td>' +
        '<td><b>' + htmlEsc(x.name || '') + '</b><br><span style="color:#64748b">' + htmlEsc(x.spec || '') + '</span></td>' +
        '<td>' + fmtQty(x.qty) + '</td>' +
        '<td>' + htmlEsc(x.issue_uom || '') + '</td>' +
        '<td>' + htmlEsc(x.main_type || '') + ' / ' + htmlEsc(x.sub_type || '') + '</td>' +
        '<td>' + (x.has_children ? '<button class="bom-open-detail" data-site="' + htmlEsc(detailCurrentSite) + '" data-part="' + htmlEsc(x.sub_part) + '">展开下一级</button>' : '<span class="leaf">叶子</span>') + '</td></tr>';
    });
    rowsHtml += '</tbody></table>';
    tableWrap.innerHTML = rowsHtml;
  }
  body.appendChild(tableWrap);

  // 分页
  if (detailTotalPages > 1) {
    const pager = document.createElement('div');
    pager.className = 'pagination';
    pager.style.cssText = 'margin-top:10px;text-align:right';
    pager.innerHTML =
      '<button data-page="1" class="bom-page-btn" ' + (detailPage === 1 ? 'disabled' : '') + '>« 首页</button>' +
      '<button data-page="' + (detailPage - 1) + '" class="bom-page-btn" ' + (detailPage === 1 ? 'disabled' : '') + '>‹ 上一页</button>' +
      '<span style="margin:0 8px">第 ' + detailPage + ' / ' + Math.max(1, Math.ceil(detailTotal / detailPageSize)) + ' 页</span>' +
      '<button data-page="' + (detailPage + 1) + '" class="bom-page-btn" ' + (detailPage >= Math.ceil(detailTotal / detailPageSize) ? 'disabled' : '') + '>下一页 ›</button>' +
      '<button data-page="' + Math.ceil(detailTotal / detailPageSize) + '" class="bom-page-btn" ' + (detailPage >= Math.ceil(detailTotal / detailPageSize) ? 'disabled' : '') + '>末页 »</button>';
    body.appendChild(pager);
  }

  detail.querySelector('.mrp-detail-body').replaceWith(body);
  bindDetailEvents();
}

function bindDetailEvents() {
  // 关闭按钮
  const closeBtn = document.getElementById('mrpDetailClose');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    detailCurrentSite = '';
    detailCurrentPart = '';
    detailTrail = [];
    loadBomDetail();
  });
  // 面包屑回退
  document.querySelectorAll('.bom-crumb-detail').forEach(c => {
    if (c.classList.contains('current')) return;
    c.addEventListener('click', () => {
      const idx = Number(c.dataset.index);
      detailTrail = detailTrail.slice(0, idx);
      detailCurrentPart = detailTrail.pop() || detailCurrentPart;
      detailTrail = detailTrail.slice(0, idx);
      detailPage = 1;
      loadBomDetail();
    });
  });
  // 子件料号双击/点击 → 钻取下一层
  document.querySelectorAll('.bom-link-detail').forEach(c => {
    if (c.classList.contains('leaf')) return;
    c.addEventListener('dblclick', () => drillDown(c.dataset.site, c.dataset.part));
  });
  document.querySelectorAll('.bom-open-detail').forEach(b => {
    b.addEventListener('click', () => drillDown(b.dataset.site, b.dataset.part));
  });
  // 分页按钮
  document.querySelectorAll('.bom-page-btn').forEach(b => {
    b.addEventListener('click', () => {
      const p = Number(b.dataset.page);
      if (p >= 1 && p <= Math.ceil(detailTotal / detailPageSize)) {
        detailPage = p;
        loadBomDetail();
      }
    });
  });
}

function drillDown(site, part) {
  detailTrail = [...detailTrail, detailCurrentPart];
  detailCurrentSite = site;
  detailCurrentPart = part;
  detailPage = 1;
  loadBomDetail();
}

// 保留旧 panel-bom 路由处理（用于直接打开 #/bom/explorer）
async function loadBomFromRoute() {
  const params = bomParams();
  const site = params.get('site') || 'LG';
  const part = params.get('part') || '';
  const page = Math.max(1, Number(params.get('page') || 1));
  const trail = readBomTrail(params);
  const pageSize = [20,50,100].includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 50;
  document.getElementById('bomPageSize').value = String(pageSize);
  if (!part) { document.getElementById('bomResult').innerHTML = '<div class="empty-row">缺少主件料号</div>'; return; }
  document.getElementById('bomTitle').textContent = part;
  document.getElementById('bomMeta').textContent = site + ' 基地 · BOM 第 ' + (trail.length + 1) + ' 层 · 正在查询直接子件';
  const pathParts = [...trail, part];
  document.getElementById('bomPath').innerHTML = pathParts.map((node,index) => '<button class="bom-node bom-crumb" data-index="' + index + '">' + htmlEsc(node) + '</button>').join('<span>›</span>') + '<span>双击有下阶结构的子件继续展开</span>';
  document.getElementById('bomResult').innerHTML = '<div class="empty-row">正在读取 ' + htmlEsc(part) + ' 的 BOM…</div>';
  const apiParams = new URLSearchParams({site,part,page:String(page),pageSize:String(pageSize)});
  const r = await fetch(API + '/bom/children?' + apiParams.toString());
  const data = await r.json();
  if (!r.ok) { document.getElementById('bomResult').innerHTML = '<div class="empty-row">' + htmlEsc(data.error || 'BOM 查询失败') + '</div>'; return; }
  document.getElementById('bomTitle').textContent = part + (data.parent?.name ? ' · ' + data.parent.name : '');
  document.getElementById('bomMeta').textContent = site + ' 基地 · 直接子件 ' + Number(data.total).toLocaleString() + ' 项 · 数据快照 ' + (data.snapshot_at ? new Date(data.snapshot_at).toLocaleString('zh-CN') : '-');
  const rows = data.rows.map(x => '<tr><td>' + htmlEsc(x.seq || '-') + '</td><td><code class="bom-link ' + (x.has_children ? 'drillable' : 'leaf') + '" data-site="' + htmlEsc(site) + '" data-part="' + htmlEsc(x.sub_part) + '" title="' + (x.has_children ? '双击展开下一层 BOM' : '叶子物料，无下阶 BOM') + '">' + htmlEsc(x.sub_part) + '</code></td><td><b>' + htmlEsc(x.name || '') + '</b><br><span style="color:#64748b">' + htmlEsc(x.spec || '') + '</span></td><td>' + fmtQty(x.qty) + '</td><td>' + htmlEsc(x.issue_uom || '') + '</td><td>' + htmlEsc(x.main_type || '') + ' / ' + htmlEsc(x.sub_type || '') + '</td><td>' + (x.has_children ? '<button class="bom-open" data-site="' + htmlEsc(site) + '" data-part="' + htmlEsc(x.sub_part) + '">展开下一级</button>' : '<span class="leaf">叶子物料</span>') + '</td></tr>').join('');
  document.getElementById('bomResult').innerHTML = '<table><thead><tr><th>项次</th><th>子件料号</th><th>名称 / 规格</th><th>组成用量</th><th>单位</th><th>主件 / 子件类别</th><th>结构</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="empty-row">该物料没有下阶 BOM</td></tr>') + '</tbody></table>';
  const totalPages = Math.max(1, data.totalPages || 1);
  document.getElementById('bomPager').innerHTML = '<button onclick="setBomPage(1)" ' + (page === 1 ? 'disabled' : '') + '>« 首页</button><button onclick="setBomPage(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + '>‹ 上一页</button><span style="margin:0 8px">' + page + ' / ' + totalPages + '</span><button onclick="setBomPage(' + (page + 1) + ')" ' + (page >= totalPages ? 'disabled' : '') + '>下一页 ›</button><button onclick="setBomPage(' + totalPages + ')" ' + (page >= totalPages ? 'disabled' : '') + '>末页 »</button>';
}
function setBomPage(page) { const p = bomParams(); location.hash = bomRoute(p.get('site') || 'LG', p.get('part') || '', page, readBomTrail(p)); }
document.addEventListener('dblclick', e => {
  const target = e.target.closest && e.target.closest('.bom-link');
  if (target && !target.classList.contains('leaf') && target.dataset.site && target.dataset.part) selectPartForDetail(target.dataset.site, target.dataset.part);
});
document.addEventListener('click', e => {
  const target = e.target.closest && e.target.closest('.bom-open');
  if (target && target.dataset.site && target.dataset.part) selectPartForDetail(target.dataset.site, target.dataset.part);
  const crumb = e.target.closest && e.target.closest('.bom-crumb');
  if (crumb) {
    const p = bomParams(); const trail = readBomTrail(p); const path = [...trail, p.get('part')]; const index = Number(crumb.dataset.index);
    location.hash = bomRoute(p.get('site') || 'LG', path[index], 1, path.slice(0,index));
  }
});
document.getElementById('bomBack').addEventListener('click', () => { location.hash = TAB_ROUTES.workbench; });
document.getElementById('bomPageSize').addEventListener('change', () => setBomPage(1));

document.getElementById('syncSample').addEventListener('click', () => startSync('sample'));
document.getElementById('syncFull').addEventListener('click', () => startSync('full'));
document.getElementById('calcPreview').addEventListener('click', () => loadMrpPreview(1));
document.getElementById('mrpSite').addEventListener('change', () => loadMrpPreview(1));
document.getElementById('mrpBomFilter').addEventListener('change', () => loadMrpPreview(1));
document.getElementById('mrpShortageFilter').addEventListener('change', () => loadMrpPreview(1));
document.getElementById('mrpPageSize').addEventListener('change', () => loadMrpPreview(1));
document.getElementById('mrpSearch').addEventListener('click', () => loadMrpPreview(1));
document.getElementById('mrpKeyword').addEventListener('keypress', e => { if (e.key === 'Enter') loadMrpPreview(1); });
document.getElementById('mrpReset').addEventListener('click', () => {
  document.getElementById('mrpKeyword').value = ''; document.getElementById('mrpBomFilter').value = 'all';
  document.getElementById('mrpShortageFilter').value = 'all'; document.getElementById('mrpPageSize').value = '50';
  mrpCurrentSort = 'net_desc'; document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === mrpCurrentSort)); loadMrpPreview(1);
});
document.querySelectorAll('.sort-btn').forEach(button => button.addEventListener('click', () => {
  mrpCurrentSort = button.dataset.sort; document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === button)); loadMrpPreview(1);
}));

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
let logCurrentPage = 1;
async function loadLog(page = 1) {
  logCurrentPage = page;
  const params = new URLSearchParams({page:String(page),pageSize:document.getElementById('logPageSize').value});
  const site = document.getElementById('logSite').value;
  const status = document.getElementById('logStatus').value;
  const api = document.getElementById('logApi').value.trim();
  if (site) params.set('site', site);
  if (status) params.set('status', status);
  if (api) params.set('api', api);
  const r = await fetch(API + '/pull/log?' + params.toString());
  const data = await r.json();
  if (!data.logs || data.logs.length === 0) {
    document.getElementById('log-list').innerHTML = '<i style="color:#64748b">暂无日志</i>';
    document.getElementById('logInfo').textContent = '共 0 条';
    document.getElementById('logPager').innerHTML = '';
    return;
  }
  document.getElementById('log-list').innerHTML =
    '<div class="query-table"><table><thead><tr><th>据点</th><th>接口</th><th>开始</th><th>耗时</th><th>页数</th><th>源端总数</th><th>实际拉取</th><th>MySQL 数量</th><th>数量校验</th><th>状态</th><th>错误</th></tr></thead><tbody>' +
    data.logs.map(l => {
      const dur = l.duration_ms ? (l.duration_ms/1000).toFixed(1) + 's' : '-';
      const cls = l.status === 'ok' ? 'badge-ok' : (l.status === 'failed' ? 'badge-fail' : 'badge-running');
      const verifyOk = l.verification_status === 'verified' || l.verification_status === 'sample_verified';
      const verifyLabel = l.verification_status === 'verified' ? '三方一致' : l.verification_status === 'sample_verified' ? '样本一致' : l.verification_status === 'failed' ? '校验失败' : '未校验';
      return '<tr><td><code>' + esc(l.site) + '</code></td><td><code>' + esc(l.api_key) + '</code></td><td>' + new Date(l.started_at).toLocaleString('zh-CN') + '</td><td>' + dur + '</td><td style="text-align:right">' + Number(l.page_count || 0).toLocaleString() + '</td><td style="text-align:right">' + (l.source_rows == null ? '-' : Number(l.source_rows).toLocaleString()) + '</td><td style="text-align:right">' + Number(l.total_rows || 0).toLocaleString() + '</td><td style="text-align:right">' + (l.db_rows == null ? '-' : Number(l.db_rows).toLocaleString()) + '</td><td><span class="badge ' + (verifyOk ? 'badge-ok' : l.verification_status === 'failed' ? 'badge-fail' : 'badge-running') + '">' + verifyLabel + '</span></td><td><span class="badge ' + cls + '">' + esc(l.status) + '</span></td><td class="truncate" title="' + esc(l.error || '') + '" style="color:#f87171">' + (l.error ? esc(l.error.slice(0, 120)) : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  const totalPages = Math.max(1, data.totalPages || 1);
  document.getElementById('logInfo').textContent = '第 ' + page + ' / ' + totalPages + ' 页 · 共 ' + Number(data.total || 0).toLocaleString() + ' 条';
  document.getElementById('logPager').innerHTML =
    '<button onclick="loadLog(1)" ' + (page === 1 ? 'disabled' : '') + '>« 首页</button>' +
    '<button onclick="loadLog(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + '>‹ 上一页</button>' +
    '<span style="margin:0 8px">' + page + ' / ' + totalPages + '</span>' +
    '<button onclick="loadLog(' + (page + 1) + ')" ' + (page >= totalPages ? 'disabled' : '') + '>下一页 ›</button>' +
    '<button onclick="loadLog(' + totalPages + ')" ' + (page >= totalPages ? 'disabled' : '') + '>末页 »</button>';
}

document.getElementById('logSearch').addEventListener('click', () => loadLog(1));
document.getElementById('logReset').addEventListener('click', () => {
  document.getElementById('logSite').value = '';
  document.getElementById('logStatus').value = '';
  document.getElementById('logApi').value = '';
  document.getElementById('logPageSize').value = '50';
  loadLog(1);
});
document.getElementById('logSite').addEventListener('change', () => loadLog(1));
document.getElementById('logStatus').addEventListener('change', () => loadLog(1));
document.getElementById('logPageSize').addEventListener('change', () => loadLog(1));
document.getElementById('logApi').addEventListener('keypress', e => { if (e.key === 'Enter') loadLog(1); });

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

// 旧的 #/pages/patient/index 仍映射到 MRP 工作台。
activateCurrentRoute();
setInterval(loadSyncMonitor, 3000);
setInterval(loadSyncJob, 2000);
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

    if (p === '/api/admin/sync/status') {
        jsonResponse(res, 200, { job: activeSyncJob });
        return true;
    }

    if (p === '/api/admin/sync/start' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            const mode = body.mode === 'full' ? 'full' : body.mode === 'sample' ? 'sample' : null;
            if (!mode) {
                jsonResponse(res, 400, { error: 'mode must be full or sample' });
                return true;
            }
            jsonResponse(res, 202, { job: startModuleSync(mode) });
        } catch (e) {
            jsonResponse(res, 409, { error: (e as Error).message });
        }
        return true;
    }

    if (p === '/api/admin/mrp/preview') {
        const site = (urlObj.searchParams.get('site') || 'LG').toUpperCase();
        if (!config.sites.includes(site)) {
            jsonResponse(res, 400, { error: 'unknown site: ' + site });
            return true;
        }
        const bomFilter = urlObj.searchParams.get('bomFilter') || 'all';
        const shortage = urlObj.searchParams.get('shortage') || 'all';
        const sort = urlObj.searchParams.get('sort') || 'net_desc';
        const keyword = (urlObj.searchParams.get('keyword') || '').trim().slice(0, 100);
        const page = Math.max(1, Number(urlObj.searchParams.get('page') || 1));
        const requestedPageSize = Number(urlObj.searchParams.get('pageSize') || 50);
        const pageSize = [20, 50, 100].includes(requestedPageSize) ? requestedPageSize : 50;
        if (!['all', 'hasBom', 'noBom'].includes(bomFilter) || !['all', 'shortage', 'covered'].includes(shortage)) {
            jsonResponse(res, 400, { error: 'invalid MRP filter' });
            return true;
        }
        const sortSql: Record<string, string> = {
            net_desc: 'net_demand DESC,part_no', gross_desc: 'gross_demand DESC,part_no',
            bom_desc: 'bom_count DESC,net_demand DESC,part_no', part_asc: 'part_no',
        };
        if (!sortSql[sort]) {
            jsonResponse(res, 400, { error: 'invalid MRP sort' });
            return true;
        }
        const calculationStartedAt = Date.now();
        const conn = await mysqlPool().getConnection();
        try {
            const filters: string[] = [];
            const filterParams: any[] = [];
            if (bomFilter === 'hasBom') filters.push('bom_count > 0');
            if (bomFilter === 'noBom') filters.push('bom_count = 0');
            if (shortage === 'shortage') filters.push('net_demand > 0');
            if (shortage === 'covered') filters.push('net_demand = 0');
            if (keyword) {
                filters.push('(part_no LIKE ? OR name LIKE ? OR spec LIKE ?)');
                filterParams.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
            }
            const filterSql = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
            const offset = (page - 1) * pageSize;
            const sql = `WITH
              demand AS (
                SELECT COALESCE(sfba006, main_part) part_no,
                       SUM(COALESCE(qty,0) * COALESCE(qpa_num,1) / NULLIF(COALESCE(qpa_den,1),0)) gross_demand
                FROM raw_need WHERE site=? GROUP BY COALESCE(sfba006, main_part)
              ),
              stock AS (SELECT part_no,SUM(COALESCE(qty,0)) qty FROM raw_remain WHERE site=? GROUP BY part_no),
              wip AS (SELECT part_no,SUM(COALESCE(qty,0)) qty FROM raw_cj WHERE site=? GROUP BY part_no),
              special_supply AS (SELECT part_no,SUM(COALESCE(qty,0)) qty FROM raw_special_supply WHERE site=? GROUP BY part_no),
              safety AS (SELECT part_no,SUM(COALESCE(qty,0)) qty FROM raw_safetystock WHERE site=? GROUP BY part_no),
              transit AS (SELECT part_no,SUM(COALESCE(qty,0)) qty FROM raw_in_transit WHERE site=? GROUP BY part_no),
              inspecting AS (SELECT part_no,SUM(COALESCE(qty,0)) qty FROM raw_testfunc WHERE site=? GROUP BY part_no),
              bom_parent AS (SELECT main_part part_no,COUNT(*) bom_count FROM raw_bom WHERE site=? GROUP BY main_part),
              parts AS (
                SELECT part_no FROM demand UNION SELECT part_no FROM stock UNION SELECT part_no FROM wip
                UNION SELECT part_no FROM special_supply UNION SELECT part_no FROM safety UNION SELECT part_no FROM bom_parent
              ),
              item_name AS (
                SELECT part_no,MAX(name) name,MAX(spec) spec FROM raw_items
                WHERE site=? AND lang='zh_CN' GROUP BY part_no
              ),
              base AS (
              SELECT p.part_no,i.name,i.spec,
                     COALESCE(d.gross_demand,0) gross_demand,COALESCE(sa.qty,0) safety_stock,
                     COALESCE(s.qty,0) available_stock,COALESCE(w.qty,0) available_wip,
                     COALESCE(sp.qty,0) special_supply,
                     GREATEST(0,COALESCE(d.gross_demand,0)+COALESCE(sa.qty,0)-COALESCE(s.qty,0)-COALESCE(w.qty,0)-COALESCE(sp.qty,0)) net_demand,
                     COALESCE(t.qty,0) in_transit,COALESCE(ins.qty,0) inspecting,
                     COALESCE(bp.bom_count,0) bom_count
              FROM parts p LEFT JOIN demand d ON d.part_no=p.part_no LEFT JOIN stock s ON s.part_no=p.part_no
              LEFT JOIN wip w ON w.part_no=p.part_no LEFT JOIN special_supply sp ON sp.part_no=p.part_no
              LEFT JOIN safety sa ON sa.part_no=p.part_no LEFT JOIN transit t ON t.part_no=p.part_no
              LEFT JOIN inspecting ins ON ins.part_no=p.part_no LEFT JOIN item_name i ON i.part_no=p.part_no
              LEFT JOIN bom_parent bp ON bp.part_no=p.part_no
              ), filtered AS (SELECT * FROM base ${filterSql})
              SELECT filtered.*,
                     COUNT(*) OVER() _total,
                     COALESCE(SUM(gross_demand) OVER(),0) _gross_total,
                     COALESCE(SUM(net_demand) OVER(),0) _net_total,
                     COALESCE(SUM(CASE WHEN net_demand>0 THEN 1 ELSE 0 END) OVER(),0) _shortage_total
              FROM filtered ORDER BY ${sortSql[sort]} LIMIT ${pageSize} OFFSET ${offset}`;
            const snapshotParams = [site, site, site, site, site, site, site, site];
            const queryParams = [...snapshotParams, site, ...filterParams];
            const [rows] = await conn.query(sql, queryParams) as any;
            const summaryRow = (rows as any[])[0] || {};
            const normalized = (rows as any[]).map(row => {
                const out: any = { ...row };
                for (const key of ['gross_demand','safety_stock','available_stock','available_wip','special_supply','net_demand','in_transit','inspecting']) {
                    out[key] = Number(out[key] || 0);
                }
                out.bom_count = Number(out.bom_count || 0);
                out.has_bom = out.bom_count > 0;
                delete out._total; delete out._gross_total; delete out._net_total; delete out._shortage_total;
                return out;
            });
            const [snapshotRows] = await conn.query(
                `SELECT MAX(pulled_at) snapshot_at FROM (
                   SELECT MAX(pulled_at) pulled_at FROM raw_need WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_remain WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_cj WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_special_supply WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_safetystock WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_in_transit WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_testfunc WHERE site=? UNION ALL
                   SELECT MAX(pulled_at) FROM raw_items WHERE site=?
                 ) snapshots`,
                snapshotParams,
            ) as any;
            const snapshotAt = (snapshotRows as any[])[0]?.snapshot_at;
            jsonResponse(res, 200, {
                site,
                filters: { bomFilter, shortage, keyword }, sort, page, pageSize,
                calculated_at: new Date().toISOString(),
                duration_ms: Date.now() - calculationStartedAt,
                snapshot_at: snapshotAt instanceof Date ? snapshotAt.toISOString() : snapshotAt || null,
                formula: 'max(0, 毛需求 + 安全库存 - 可用库存 - 可用在制 - 特殊工单供给)',
                rows: normalized,
                total: Number(summaryRow._total || 0),
                totalPages: Math.max(1, Math.ceil(Number(summaryRow._total || 0) / pageSize)),
                summary: {
                    materials: Number(summaryRow._total || 0),
                    gross_demand: Number(summaryRow._gross_total || 0),
                    net_demand: Number(summaryRow._net_total || 0),
                    shortage_materials: Number(summaryRow._shortage_total || 0),
                },
            });
        } finally { conn.release(); }
        return true;
    }

    if (p === '/api/admin/bom/children') {
        const site = (urlObj.searchParams.get('site') || '').toUpperCase();
        const part = (urlObj.searchParams.get('part') || '').trim();
        const page = Math.max(1, Number(urlObj.searchParams.get('page') || 1));
        const requestedPageSize = Number(urlObj.searchParams.get('pageSize') || 50);
        const pageSize = [20, 50, 100].includes(requestedPageSize) ? requestedPageSize : 50;
        if (!config.sites.includes(site)) {
            jsonResponse(res, 400, { error: 'unknown site: ' + site });
            return true;
        }
        if (!part || part.length > 64) {
            jsonResponse(res, 400, { error: 'invalid BOM main part' });
            return true;
        }
        const conn = await mysqlPool().getConnection();
        try {
            const [countRows] = await conn.query(
                'SELECT COUNT(*) c, MAX(pulled_at) snapshot_at FROM raw_bom WHERE site=? AND main_part=?',
                [site, part],
            ) as any;
            const total = Number((countRows as any[])[0]?.c || 0);
            const snapshotAt = (countRows as any[])[0]?.snapshot_at;
            const offset = (page - 1) * pageSize;
            const [rows] = await conn.query(
                `SELECT b.sub_part,b.qty,b.main_type,b.sub_type,b.issue_uom,b.seq,
                        i.name,i.spec,
                        EXISTS(SELECT 1 FROM raw_bom child WHERE child.site=b.site AND child.main_part=b.sub_part LIMIT 1) has_children
                 FROM raw_bom b
                 LEFT JOIN raw_items i ON i.site=b.site AND i.part_no=b.sub_part AND i.lang='zh_CN'
                 WHERE b.site=? AND b.main_part=?
                 ORDER BY CAST(b.seq AS UNSIGNED),b.seq,b.sub_part
                 LIMIT ${pageSize} OFFSET ${offset}`,
                [site, part],
            ) as any;
            const [parentRows] = await conn.query(
                `SELECT name,spec FROM raw_items WHERE site=? AND part_no=? AND lang='zh_CN' LIMIT 1`,
                [site, part],
            ) as any;
            jsonResponse(res, 200, {
                site, part, page, pageSize, total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                snapshot_at: snapshotAt instanceof Date ? snapshotAt.toISOString() : snapshotAt || null,
                parent: (parentRows as any[])[0] || null,
                rows: (rows as any[]).map(row => ({ ...row, qty: Number(row.qty || 0), has_children: Boolean(row.has_children) })),
            });
        } finally { conn.release(); }
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

    // ② 拉取日志（分页 + 基地/状态/接口筛选）
    if (p === '/api/admin/pull/log') {
        const page = Math.max(1, Number(urlObj.searchParams.get('page') || 1));
        const pageSize = Math.min(100, Math.max(1, Number(urlObj.searchParams.get('pageSize') || 50)));
        const site = (urlObj.searchParams.get('site') || '').toUpperCase();
        const status = urlObj.searchParams.get('status') || '';
        const api = (urlObj.searchParams.get('api') || '').trim();
        if (site && !config.sites.includes(site)) {
            jsonResponse(res, 400, { error: 'unknown site: ' + site });
            return true;
        }
        if (status && !['ok', 'failed', 'running'].includes(status)) {
            jsonResponse(res, 400, { error: 'unknown status: ' + status });
            return true;
        }
        const where: string[] = [];
        const params: any[] = [];
        if (site) { where.push('site=?'); params.push(site); }
        if (status) { where.push('status=?'); params.push(status); }
        if (api) { where.push('api_key LIKE ?'); params.push('%' + api + '%'); }
        const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const conn = await mysqlPool().getConnection();
        try {
            const [countRows] = await conn.execute(
                `SELECT COUNT(*) c FROM pull_log${whereSql}`, params,
            ) as any;
            const total = Number((countRows as any[])[0]?.c || 0);
            const offset = (page - 1) * pageSize;
            const [rows] = await conn.query(
                `SELECT site, api_key, started_at, finished_at, duration_ms, page_count, total_rows,
                        source_rows, db_rows, verification_status, status, error
                 FROM pull_log${whereSql} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`,
                params,
            ) as any;
            const normalized = (rows as any[]).map(r => {
                const out: any = {};
                for (const k of Object.keys(r)) {
                    const v = r[k];
                    out[k] = v instanceof Date ? v.toISOString() : v;
                }
                return out;
            });
            jsonResponse(res, 200, {
                logs: normalized, total, page, pageSize,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
            });
        } finally { conn.release(); }
        return true;
    }

    return false;
}

export { handleAdmin, renderAdmin };
