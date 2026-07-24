import { useEffect, useRef, useState } from "react";
import {
  listProjects,
  listRoles,
  listThreads,
  readThread,
  createThread,
  deleteThread,
  type ProjectSummary,
  type RoleInfo,
  type ChatThreadSummary,
} from "../api/client";

interface Props {
  track: (action: string, target?: string, meta?: Record<string, unknown>) => void;
}

interface Msg {
  who: "user" | "assistant" | "tool";
  text: string;
}

/**
 * 单角色聊天（持久化版）：
 *  - 左栏：某项目下的会话线程列表（存磁盘，刷新/重启不丢）。
 *  - 右栏：当前线程对话；发消息走 SSE，服务端自动把用户/助手/工具消息落盘。
 *  - 角色有「项目记忆」：能回答"这个项目做过什么"（服务端注入迭代记录/报告/产出树）。
 */
export function Chat({ track }: Props) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState("");
  const [role, setRole] = useState("developer");
  const [allowWrite, setAllowWrite] = useState(false);

  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { track("chat.open"); }, [track]);
  useEffect(() => {
    listRoles().then(setRoles).catch(() => {});
    listProjects().then((ps) => { setProjects(ps); if (ps.length) setProject(ps[0].id); }).catch(() => {});
  }, []);

  // 切项目 → 刷新线程列表
  const refreshThreads = (p: string) => {
    if (!p) return;
    listThreads(p).then(setThreads).catch(() => setThreads([]));
  };
  useEffect(() => { refreshThreads(project); setThreadId(null); setMsgs([]); setMeta(""); }, [project]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [msgs]);

  // 打开一个线程 → 加载其历史消息
  const openThread = async (id: string) => {
    try {
      const t = await readThread(project, id);
      setThreadId(t.id);
      setRole(t.role);
      setMsgs(t.messages.map((m) => ({ who: m.who, text: m.text })));
      setMeta("");
      track("chat.thread.open", id);
    } catch (e) {
      setMeta(String(e));
    }
  };

  const newThread = async () => {
    try {
      const t = await createThread(project, role);
      setThreadId(t.id);
      setMsgs([]);
      setMeta("");
      refreshThreads(project);
      track("chat.thread.new", t.id);
    } catch (e) {
      setMeta(String(e));
    }
  };

  const removeThread = async (id: string) => {
    if (!confirm("删除这个会话？")) return;
    try {
      await deleteThread(project, id);
      if (threadId === id) { setThreadId(null); setMsgs([]); }
      refreshThreads(project);
    } catch (e) {
      setMeta(String(e));
    }
  };

  const appendAssistant = (t: string) => {
    setMsgs((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].who === "assistant") { copy[i] = { ...copy[i], text: copy[i].text + t }; break; }
      }
      return copy;
    });
  };

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setMsgs((m) => [...m, { who: "user", text: message }, { who: "assistant", text: "" }]);
    setBusy(true);
    setMeta("");
    track("chat.send", `${role}@${project}`, { allowWrite });

    try {
      const res = await fetch("/api/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, project, message, threadId, allowWrite }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        appendAssistant(`\n[错误] ${err.error ?? res.statusText}`);
        setBusy(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let gotThread = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let payload: any;
          try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (payload.type === "thread") { if (!threadId) setThreadId(payload.threadId); gotThread = true; }
          else if (payload.type === "text") appendAssistant(payload.text);
          else if (payload.type === "tool") setMsgs((m) => [...m, { who: "tool", text: `🔧 ${payload.tool}(${JSON.stringify(payload.input).slice(0, 120)})` }, { who: "assistant", text: "" }]);
          else if (payload.type === "done") {
            setMeta(`in≈${payload.inputTokens} out≈${payload.outputTokens}${payload.error ? ` · 错误: ${payload.error}` : ""}`);
          }
        }
      }
      if (gotThread) refreshThreads(project);
    } catch (e) {
      appendAssistant(`\n[异常] ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const roleName = (r: string) => r;

  return (
    <div>
      <h2>💬 单角色聊天</h2>
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
        {/* 线程侧栏 */}
        <div className="card" style={{ padding: 8 }}>
          <div className="row" style={{ justifyContent: "space-between", padding: "4px 8px" }}>
            <strong>会话（{threads.length}）</strong>
            <button onClick={newThread} disabled={!project}>+ 新建</button>
          </div>
          <div style={{ padding: "0 8px 8px" }}>
            <label>项目</label>
            <select value={project} onChange={(e) => setProject(e.target.value)} style={{ width: "100%" }}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.id}{p.legacy ? "（legacy）" : ""}</option>)}
            </select>
          </div>
          {threads.length === 0 && <div className="muted" style={{ padding: 8 }}>还没有会话，点「+ 新建」。</div>}
          {threads.map((t) => (
            <div key={t.id} className={`list-item ${threadId === t.id ? "active" : ""}`}>
              <span style={{ cursor: "pointer", flex: 1, overflow: "hidden" }} onClick={() => openThread(t.id)}>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title || "（无标题）"}</div>
                <div className="muted" style={{ fontSize: 11 }}>{roleName(t.role)} · {t.messageCount} 条</div>
              </span>
              <button className="danger" onClick={() => removeThread(t.id)}>删</button>
            </div>
          ))}
        </div>

        {/* 对话区 */}
        <div>
          <div className="card">
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <label>角色</label>
                <select value={role} onChange={(e) => setRole(e.target.value)} disabled={!!threadId}>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
                </select>
              </div>
              <div>
                <label>写权限</label>
                <label className="row" style={{ margin: 0, color: "#c9d1d9" }}>
                  <input type="checkbox" checked={allowWrite} onChange={(e) => setAllowWrite(e.target.checked)} style={{ width: "auto" }} />
                  <span style={{ marginLeft: 4 }}>允许改文件（默认只读）</span>
                </label>
              </div>
              <span style={{ flex: 1 }} />
              <span className="muted" style={{ fontSize: 12 }}>
                {threadId ? `会话 ${threadId.slice(0, 10)}` : "未选择会话（发消息会自动新建）"}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              记录已持久化，刷新不丢。角色能回答「这个项目做过什么」（自动读迭代记录/报告/产出）。已安装 skill/kb 也会注入。
            </div>
          </div>

          <div className="card">
            <div className="chat-log" ref={logRef}>
              {msgs.length === 0 && <div className="muted">选左边的会话，或直接在下面发第一句。</div>}
              {msgs.map((m, i) => (
                <div key={i} className={`bubble ${m.who}`}>{m.text || (m.who === "assistant" && busy ? "…" : "")}</div>
              ))}
            </div>
            {meta && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{meta}</div>}
            <div className="row" style={{ marginTop: 12 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
                rows={3}
                placeholder="输入消息，Cmd/Ctrl+Enter 发送"
                style={{ flex: 1 }}
              />
              <button className="primary" onClick={send} disabled={busy || !input.trim()}>
                {busy ? "生成中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
