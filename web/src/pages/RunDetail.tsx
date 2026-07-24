import { useEffect, useState } from "react";
import { api, type RunDetailData, type StreamedEvent, type TaskRow, type UiEvent } from "../api/contract";

interface Props {
  runId: string;
  onBack: () => void;
  track: (action: string, target?: string, meta?: Record<string, unknown>) => void;
}

export function RunDetail({ runId, onBack, track }: Props) {
  const [data, setData] = useState<RunDetailData | null>(null);
  const [events, setEvents] = useState<StreamedEvent[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [uiEvents, setUiEvents] = useState<UiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  // PM 验证汇总（最新一次 pm.validate 事件的 checks/blockers），用于顶部红/绿 badge
  const [pmValidate, setPmValidate] = useState<{
    checks: Array<{ name: string; ok: boolean; note: string }>;
    blockers: string[];
    gaps: string[];
  } | null>(null);

  // 进页面即上报
  useEffect(() => {
    track("run.open", runId, { from: "url" });
  }, [runId, track]);

  // 拉快照
  useEffect(() => {
    api<RunDetailData>(`/api/v1/runs/${encodeURIComponent(runId)}`)
      .then(setData)
      .catch((e) => setError(String(e)));
    api<{ runId: string; tasks: TaskRow[] }>(`/api/v1/runs/${encodeURIComponent(runId)}/tasks`)
      .then((r) => setTasks(r.tasks))
      .catch(() => {});
    api<{ events: UiEvent[] }>(`/api/v1/ui-events?limit=100`)
      .then((r) => setUiEvents(r.events))
      .catch(() => {});
  }, [runId]);

  // 订阅事件流(SSE) — 仅 running run 才有新事件;done run 立即得到 0 事件然后心跳
  useEffect(() => {
    const es = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
    const subOnce = () => track("run.sse.subscribe", runId);
    es.addEventListener("open", subOnce);
    es.addEventListener("ping", () => {}); // 心跳忽略
    const handler = (e: MessageEvent) => {
      let ev: StreamedEvent;
      try {
        ev = JSON.parse(e.data) as StreamedEvent;
      } catch {
        return;
      }
      setEvents((prev) => [...prev, ev].slice(-200));
      // 实时合并到任务表
      if (ev.type === "run.task.start") {
        setTasks((prev) => {
          if (prev.find((t) => t.taskId === ev.taskId)) return prev;
          return [
            ...prev,
            {
              taskId: ev.taskId as string,
              role: ev.role as string,
              accountId: ev.accountId as string | undefined,
              instruction: (ev.instruction as string) ?? "",
              startedAt: ev.ts,
              status: "running" as const,
            },
          ].sort((a, b) => a.startedAt - b.startedAt);
        });
      } else if (ev.type === "run.task.done") {
        setTasks((prev) =>
          prev.map((t) =>
            t.taskId === ev.taskId
              ? {
                  ...t,
                  doneAt: ev.ts,
                  inputTokens: ev.inputTokens as number,
                  outputTokens: ev.outputTokens as number,
                  exhausted: ev.exhausted as boolean,
                  accountId: (ev.accountId as string) ?? t.accountId,
                  status: ev.exhausted ? "error" : "done",
                }
              : t
          )
        );
      } else if (ev.type === "run.task.error") {
        setTasks((prev) =>
          prev.map((t) =>
            t.taskId === ev.taskId
              ? { ...t, doneAt: ev.ts, status: "error", accountId: (ev.accountId as string) ?? t.accountId }
              : t
          )
        );
      } else if (ev.type === "pm.validate") {
        // 缓存最新一次 PM 验证结果，供顶部 badge 渲染
        setPmValidate({
          checks: (ev.checks as Array<{ name: string; ok: boolean; note: string }>) ?? [],
          blockers: (ev.blockers as string[]) ?? [],
          gaps: (ev.gaps as string[]) ?? [],
        });
      }
    };
    for (const ty of [
      "run.start",
      "run.round",
      "run.task.start",
      "run.task.text",
      "run.task.tool",
      "run.task.done",
      "run.task.error",
      "run.task.mega",
      "run.round.done",
      "run.iteration",
      "run.iteration.failed",
      "run.done",
      "account.exhausted",
      // PM 事件（pm.call 是 billing-grade，UI 上同 pm.decompose/pm.review/pm.iteration 一起显示在事件流）
      "pm.call",
      "pm.decompose",
      "pm.review",
      "pm.iteration",
      "pm.validate",
    ]) {
      es.addEventListener(ty, handler as EventListener);
    }
    return () => es.close();
  }, [runId, track]);

  if (error)
    return (
      <div style={{ color: "#f85149" }}>
        {error} <a onClick={onBack} style={{ cursor: "pointer" }}>← 返回</a>
      </div>
    );
  if (!data) return <div>加载中…</div>;

  // 排序：pm 排第一（这是新增的可见性），其余按 token 数倒序
  const perRoleEntries = Object.entries(data.perRole).sort(([a], [b]) => {
    if (a === "pm") return -1;
    if (b === "pm") return 1;
    return 0;
  });

  // PM 验证红/绿 badge
  const pmFailed = pmValidate ? pmValidate.checks.filter((c) => !c.ok).length : 0;
  const pmTotal = pmValidate ? pmValidate.checks.length : 0;
  const pmBlocked = pmValidate?.blockers.length ?? 0;

  return (
    <div>
      <h2>
        {data.state === "running" ? (
          <span className="tag running">运行中</span>
        ) : (
          <span className="tag done">已完成</span>
        )}{" "}
        <code>{data.runId}</code>{" "}
        <a onClick={onBack} style={{ cursor: "pointer", fontSize: 14 }}>
          ← 返回
        </a>
      </h2>

      {pmValidate && (
        <div
          className="card"
          style={{
            borderLeft: pmFailed > 0 || pmBlocked > 0 ? "4px solid #f85149" : "4px solid #2ea043",
          }}
        >
          <h3 style={{ marginTop: 0 }}>
            {pmFailed > 0 || pmBlocked > 0 ? "🚧 PM 验证未通过" : "✅ PM 验证通过"}
            <span className="muted" style={{ fontWeight: "normal", fontSize: 12, marginLeft: 8 }}>
              通过 {pmTotal - pmFailed}/{pmTotal}
              {pmBlocked > 0 ? ` · ${pmBlocked} 个 blocker 已自动追加一轮` : ""}
            </span>
          </h3>
          <table>
            <thead>
              <tr>
                <th>check</th>
                <th>ok</th>
                <th>note</th>
              </tr>
            </thead>
            <tbody>
              {pmValidate.checks.map((c, i) => (
                <tr key={i}>
                  <td>{c.name}</td>
                  <td>
                    {c.ok ? <span className="tag done">✓</span> : <span className="tag error">✗</span>}
                  </td>
                  <td>{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pmValidate.blockers.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", color: "#f85149" }}>
                🚧 {pmBlocked} 个 blocker（已触发自动追轮）
              </summary>
              <ul style={{ marginTop: 6 }}>
                {pmValidate.blockers.map((b, i) => (
                  <li key={i} style={{ color: "#f85149" }}>
                    {b}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="v">{data.currentRound}</div>
          <div className="l">当前轮</div>
        </div>
        <div className="kpi">
          <div className="v">{data.totalTokens.toLocaleString()}</div>
          <div className="l">总 tokens</div>
        </div>
        <div className="kpi">
          <div className="v">{data.doneReason || "—"}</div>
          <div className="l">停止原因</div>
        </div>
        <div className="kpi">
          <div className="v">{data.projectId}</div>
          <div className="l">项目</div>
        </div>
      </div>

      <div className="kpis" data-testid="per-role-kpis">
        {perRoleEntries.map(([role, tokens]) => (
          <div className="kpi" key={role}>
            <div className="v">{(tokens as number).toLocaleString()}</div>
            <div className="l">tokens · {role}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          📝 任务清单 ({tasks.length})
          <span className="muted" style={{ fontWeight: "normal", fontSize: 12, marginLeft: 8 }}>
            实时随 SSE 合并
          </span>
        </h3>
        {tasks.length === 0 ? (
          <div className="muted">暂无任务（run 还未启动或事件文件未生成）</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>taskId</th>
                <th>role</th>
                <th>account</th>
                <th>status</th>
                <th>in/out</th>
                <th>耗时</th>
                <th>instruction</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const dur =
                  t.doneAt && t.startedAt
                    ? `${Math.max(0, Math.round((t.doneAt - t.startedAt) / 1000))}s`
                    : "—";
                return (
                  <tr key={t.taskId}>
                    <td>
                      <code style={{ fontSize: 11 }}>{t.taskId.slice(-12)}</code>
                    </td>
                    <td>{t.role}</td>
                    <td>{t.accountId ?? "—"}</td>
                    <td>
                      {t.status === "running" && <span className="tag running">running</span>}
                      {t.status === "done" && <span className="tag done">done</span>}
                      {t.status === "error" && <span className="tag error">error</span>}
                    </td>
                    <td>
                      <code style={{ fontSize: 11 }}>
                        {(t.inputTokens ?? 0).toLocaleString()}/
                        {(t.outputTokens ?? 0).toLocaleString()}
                      </code>
                    </td>
                    <td>{dur}</td>
                    <td>
                      <span title={t.instruction}>{t.instruction.slice(0, 80)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          🖱️ 用户行为 (最近 {uiEvents.length})
          <span className="muted" style={{ fontWeight: "normal", fontSize: 12, marginLeft: 8 }}>
            来自 .admin/events/ui.jsonl
          </span>
        </h3>
        {uiEvents.length === 0 ? (
          <div className="muted">暂无 UI 行为事件</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>time</th>
                <th>session</th>
                <th>action</th>
                <th>target</th>
                <th>meta</th>
              </tr>
            </thead>
            <tbody>
              {uiEvents
                .slice()
                .reverse()
                .map((e, i) => (
                  <tr key={`${e.ts}-${i}`}>
                    <td>
                      <code style={{ fontSize: 11 }}>{new Date(e.ts).toLocaleTimeString()}</code>
                    </td>
                    <td>
                      <code style={{ fontSize: 11 }}>{e.sessionId.slice(0, 8)}</code>
                    </td>
                    <td>{e.action}</td>
                    <td>{e.target ?? "—"}</td>
                    <td>
                      <code style={{ fontSize: 11 }}>
                        {e.meta ? JSON.stringify(e.meta).slice(0, 100) : "—"}
                      </code>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>实时事件流 (最近 {events.length} 条)</h3>
        <div className="event-list">
          {events.length === 0 && (
            <div className="muted">暂无新事件（run 已结束或还在启动）</div>
          )}
          {events.map((e, i) => {
            // PM 事件特殊高亮
            const isPm = e.type.startsWith("pm.");
            const isMega = e.type === "run.task.mega";
            const isIterFailed = e.type === "run.iteration.failed";
            return (
              <div
                className="ev"
                key={i}
                style={{
                  background: isPm
                    ? "rgba(110, 118, 255, 0.08)"
                    : isMega
                    ? "rgba(248, 81, 73, 0.08)"
                    : isIterFailed
                    ? "rgba(248, 81, 73, 0.12)"
                    : undefined,
                  paddingLeft: 6,
                }}
              >
                <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
                <span className="ty">{e.type}</span>{" "}
                {e.role ? <span className="ro">{String(e.role)}</span> : null}
                {e.tool ? (
                  <span>
                    {" "}
                    · tool=<code>{String(e.tool)}</code>
                  </span>
                ) : null}
                {e.accountId ? <span> · acct={String(e.accountId)}</span> : null}
                {e.inputTokens != null ? (
                  <span>
                    {" "}
                    · in/out={String(e.inputTokens)}/{String(e.outputTokens)}
                  </span>
                ) : null}
                {e.text ? <span> · "{String(e.text).slice(0, 60)}…"</span> : null}
                {e.recordPath ? <span> · 📄 {String(e.recordPath)}</span> : null}
                {e.cap != null ? (
                  <span style={{ color: "#f85149" }}>
                    {" "}
                    · ⚠️ mega tokens={String(e.tokens)} &gt; cap={String(e.cap)}
                  </span>
                ) : null}
                {Array.isArray(e.blockers) && (e.blockers as unknown[]).length > 0 ? (
                  <span style={{ color: "#f85149" }}>
                    {" "}
                    · 🚧 blockers={String((e.blockers as unknown[]).length)}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
