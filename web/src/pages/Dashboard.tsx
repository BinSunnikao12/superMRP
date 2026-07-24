import { useEffect, useState } from "react";
import { api, type OrchestratorStatus, type RunSummary, type UsageTotals } from "../api/client";

interface Props {
  onPickRun: (runId: string) => void;
  onNavigate: (kind: "dashboard" | "runs") => void;
  track: (action: string, target?: string, meta?: Record<string, unknown>) => void;
}

export function Dashboard({ onPickRun, onNavigate, track }: Props) {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    track("dashboard.open");
  }, [track]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const [s, u, r] = await Promise.all([
          api<OrchestratorStatus>("/api/v1/orchestrator/status"),
          api<UsageTotals>("/api/v1/usage?groupBy=role"),
          api<RunSummary[]>("/api/v1/runs"),
        ]);
        if (alive) {
          setStatus(s);
          setUsage(u);
          setRuns(r);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    }
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error) return <div style={{ color: "#f85149" }}>后端未连接: {error}。先跑 <code>npm run server</code>。</div>;
  if (!status) return <div>加载中…</div>;

  const totalAll = usage ? Object.values(usage.totals).reduce((a, b) => a + b, 0) : 0;
  const perKey = status.poolSnapshot || {};
  const totalKey = Object.values(perKey).reduce((a, b) => a + b, 0);

  return (
    <div>
      <h2>📊 Dashboard</h2>
      <div className="kpis">
        <div className="kpi"><div className="v">{status.accounts.length}</div><div className="l">账号总数</div></div>
        <div className="kpi"><div className="v">{totalAll.toLocaleString()}</div><div className="l">本次进程累计 tokens (按 role)</div></div>
        <div className="kpi"><div className="v">{totalKey.toLocaleString()}</div><div className="l">本次进程累计 tokens (按 key)</div></div>
        <div className="kpi"><div className="v">{status.liveRuns.length}</div><div className="l">当前 live run</div></div>
        <div className="kpi"><div className="v">{runs.length}</div><div className="l">历史 run (本月)</div></div>
        <div className="kpi"><div className="v">{status.keyFallback ? "ON" : "OFF"}</div><div className="l">KEY_FALLBACK</div></div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>用量占比（按 role）</h3>
        {usage && Object.keys(usage.totals).length === 0 && <div className="muted">暂无数据。跑一次 <code>npm start</code> 即可。</div>}
        {usage && Object.entries(usage.totals).map(([k, v]) => {
          const pct = totalAll ? (v / totalAll * 100).toFixed(1) : "0";
          return (
            <div key={k} style={{ marginBottom: 6 }}>
              <span style={{ display: "inline-block", width: 100 }}>{k}</span>
              <span className="bar" style={{ width: Math.max(2, Number(pct) * 3) }} />
              <span style={{ marginLeft: 8, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {v.toLocaleString()} ({pct}%)
              </span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>账号用量 / 预算</h3>
        {Object.entries(perKey).map(([k, v]) => {
          const pct = status.perKeyBudget ? Math.min(100, (v / status.perKeyBudget * 100)) : 0;
          return (
            <div key={k} style={{ marginBottom: 6 }}>
              <span style={{ display: "inline-block", width: 100 }}>{k}</span>
              <span className="bar" style={{ width: Math.max(2, pct * 3), background: pct > 90 ? "#f85149" : pct > 70 ? "#d29922" : "#3fb950" }} />
              <span style={{ marginLeft: 8, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {v.toLocaleString()} / {status.perKeyBudget.toLocaleString()} ({pct.toFixed(1)}%)
              </span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>最近 runs</h3>
        {runs.length === 0 && <div className="muted">还没有 run。</div>}
        {runs.slice(0, 5).map((r) => (
          <div key={r.runId} style={{ padding: "4px 0" }}>
            <a
              onClick={() => {
                track("run.open", r.runId, { from: "dashboard" });
                onPickRun(r.runId);
              }}
              style={{ cursor: "pointer" }}
            >
              {r.runId}
            </a>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              {new Date(r.ts).toLocaleString()} · {r.tokens.toLocaleString()} tok · {r.projectId}
            </span>
          </div>
        ))}
        <a
          onClick={() => onNavigate("runs")}
          style={{ cursor: "pointer", display: "inline-block", marginTop: 8, fontSize: 13 }}
        >
          查看全部运行历史 →
        </a>
      </div>
    </div>
  );
}
