import { useEffect, useState } from "react";
import { api, type RunSummary } from "../api/client";

interface Props {
  onPickRun: (runId: string) => void;
  track: (action: string, target?: string, meta?: Record<string, unknown>) => void;
}

export function RunsList({ onPickRun, track }: Props) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    track("runs.open");
    api<RunSummary[]>("/api/v1/runs")
      .then(setRuns)
      .catch((e) => setError(String(e)));
  }, [track]);


  if (error) return <div style={{ color: "#f85149" }}>{error}</div>;
  if (!runs) return <div>加载中…</div>;

  return (
    <div>
      <h2>📜 运行历史</h2>
      <table>
        <thead>
          <tr>
            <th>runId</th>
            <th>项目</th>
            <th>开始时间</th>
            <th>tokens</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId}>
              <td><code>{r.runId}</code></td>
              <td>{r.projectId}</td>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.tokens.toLocaleString()}</td>
              <td>
                <a
                  onClick={() => {
                    track("run.open", r.runId, { from: "runsList" });
                    onPickRun(r.runId);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  查看 →
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
