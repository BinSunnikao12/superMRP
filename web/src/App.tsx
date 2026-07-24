import { useMemo, useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { RunsList } from "./pages/RunsList";
import { RunDetail } from "./pages/RunDetail";
import { Chat } from "./pages/Chat";
import { Library } from "./pages/Library";
import { trackUiEvent } from "./api/client";

/**
 * App 单例的 sessionId,localStorage 持久化,刷新不丢。
 * 用于「某个用户在 UI 上做了什么」的归并。
 */
function getSessionId(): string {
  const KEY = "orch.sid";
  const stored = localStorage.getItem(KEY);
  if (stored) return stored;
  const id =
    typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(KEY, id);
  return id;
}

export function App() {
  const sessionId = useMemo(getSessionId, []);
  const track = (action: string, target?: string, meta?: Record<string, unknown>) =>
    trackUiEvent({ sessionId, action, target, meta });

  type Route =
    | { kind: "dashboard" }
    | { kind: "runs" }
    | { kind: "run"; runId: string }
    | { kind: "chat" }
    | { kind: "library" };
  const [route, setRoute] = useState<Route>({ kind: "dashboard" });

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>多 Agent 后台</h1>
        <nav>
          <a
            className={route.kind === "dashboard" ? "active" : ""}
            onClick={() => setRoute({ kind: "dashboard" })}
            style={{ cursor: "pointer" }}
          >
            📊 Dashboard
          </a>
          <a
            className={route.kind === "runs" || route.kind === "run" ? "active" : ""}
            onClick={() => setRoute({ kind: "runs" })}
            style={{ cursor: "pointer" }}
          >
            📜 运行历史
          </a>
          <a
            className={route.kind === "chat" ? "active" : ""}
            onClick={() => setRoute({ kind: "chat" })}
            style={{ cursor: "pointer" }}
          >
            💬 单角色聊天
          </a>
          <a
            className={route.kind === "library" ? "active" : ""}
            onClick={() => setRoute({ kind: "library" })}
            style={{ cursor: "pointer" }}
          >
            📦 Skill/KB 库
          </a>
        </nav>
        <div style={{ padding: "16px", marginTop: "auto", color: "#6e7681", fontSize: 11 }}>
          v0.1.0 · 本机模式 · session {sessionId.slice(0, 8)}
        </div>
      </aside>
      <main className="main">
        {route.kind === "dashboard" && (
          <Dashboard
            onPickRun={(id) => setRoute({ kind: "run", runId: id })}
            onNavigate={(k) => setRoute({ kind: k })}
            track={track}
          />
        )}
        {route.kind === "runs" && (
          <RunsList
            onPickRun={(id) => setRoute({ kind: "run", runId: id })}
            track={track}
          />
        )}
        {route.kind === "run" && (
          <RunDetail
            runId={route.runId}
            onBack={() => setRoute({ kind: "runs" })}
            track={track}
          />
        )}
        {route.kind === "chat" && <Chat track={track} />}
        {route.kind === "library" && <Library track={track} />}
      </main>
    </div>
  );
}
