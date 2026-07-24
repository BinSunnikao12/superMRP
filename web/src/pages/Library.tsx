import { useEffect, useMemo, useState } from "react";
import {
  listProjects,
  listLibrary,
  readLibraryEntry,
  saveLibraryEntry,
  deleteLibraryEntry,
  getInstallPreview,
  doInstall,
  type LibKind,
  type LibEntry,
  type InstallPreviewData,
  type ProjectSummary,
} from "../api/client";

interface Props {
  track: (action: string, target?: string, meta?: Record<string, unknown>) => void;
}

/**
 * 全局 Skill/KB 库管理 + 「安装到项目」（带安装前预览确认）。
 * 左：条目列表（可切 skill/kb）。右：编辑器。安装走预览弹窗。
 */
export function Library({ track }: Props) {
  const [kind, setKind] = useState<LibKind>("skill");
  const [entries, setEntries] = useState<LibEntry[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<string>("");
  const [preview, setPreview] = useState<InstallPreviewData | null>(null);
  const [installProject, setInstallProject] = useState<string>("");

  useEffect(() => { track("library.open", kind); }, [kind, track]);

  const refresh = () => {
    listLibrary(kind).then(setEntries).catch((e) => setStatus(String(e)));
  };
  useEffect(refresh, [kind]);
  useEffect(() => {
    listProjects().then((ps) => {
      setProjects(ps);
      if (ps.length && !installProject) setInstallProject(ps[0].id);
    }).catch(() => {});
  }, []);

  const openEntry = async (n: string) => {
    setSelected(n);
    setName(n);
    try {
      setContent(await readLibraryEntry(kind, n));
      setStatus("");
    } catch (e) {
      setStatus(String(e));
    }
  };

  const newEntry = () => {
    setSelected(null);
    setName("");
    setContent("");
    setStatus("");
  };

  const save = async () => {
    if (!name.trim()) { setStatus("请填写条目名"); return; }
    try {
      await saveLibraryEntry(kind, name.trim(), content);
      setStatus(`已保存 ${kind}/${name}`);
      track("library.save", `${kind}/${name}`);
      setSelected(name.trim());
      refresh();
    } catch (e) {
      setStatus(String(e));
    }
  };

  const remove = async (n: string) => {
    if (!confirm(`确定删除 ${kind}/${n}？`)) return;
    try {
      await deleteLibraryEntry(kind, n);
      if (selected === n) newEntry();
      track("library.delete", `${kind}/${n}`);
      refresh();
    } catch (e) {
      setStatus(String(e));
    }
  };

  const startInstall = async (n: string) => {
    if (!installProject) { setStatus("请先选择目标项目"); return; }
    try {
      const pv = await getInstallPreview(kind, n, installProject);
      setPreview(pv);
      track("install.preview", `${kind}/${n}→${installProject}`, { action: pv.action });
    } catch (e) {
      setStatus(String(e));
    }
  };

  const confirmInstall = async () => {
    if (!preview) return;
    try {
      const res = await doInstall(preview.kind, preview.name, preview.projectId, preview.action === "overwrite");
      setStatus(`✅ 已安装 ${preview.kind}/${preview.name} → ${res.targetPath}（${res.action}）`);
      track("install.confirm", `${preview.kind}/${preview.name}→${preview.projectId}`, { action: res.action });
      setPreview(null);
    } catch (e) {
      setStatus(String(e));
    }
  };

  return (
    <div>
      <h2>📦 Skill / KB 库</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={kind === "skill" ? "primary" : ""} onClick={() => { setKind("skill"); newEntry(); }}>技能 Skill</button>
        <button className={kind === "kb" ? "primary" : ""} onClick={() => { setKind("kb"); newEntry(); }}>知识 KB</button>
        <span style={{ flex: 1 }} />
        <label style={{ margin: 0 }}>安装到项目</label>
        <select value={installProject} onChange={(e) => setInstallProject(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.id}{p.legacy ? "（legacy）" : ""}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 8 }}>
          <div className="row" style={{ justifyContent: "space-between", padding: "4px 8px" }}>
            <strong>{kind === "skill" ? "技能" : "知识"}条目 ({entries.length})</strong>
            <button onClick={newEntry}>+ 新建</button>
          </div>
          {entries.length === 0 && <div className="muted" style={{ padding: 8 }}>库为空，右侧新建一个吧</div>}
          {entries.map((e) => (
            <div key={e.name} className={`list-item ${selected === e.name ? "active" : ""}`}>
              <span style={{ cursor: "pointer", flex: 1 }} onClick={() => openEntry(e.name)}>
                {e.name} <span className="muted" style={{ fontSize: 11 }}>{e.bytes}B</span>
              </span>
              <div className="row">
                <button onClick={() => startInstall(e.name)} title="安装到项目">装 ⤵</button>
                <button className="danger" onClick={() => remove(e.name)}>删</button>
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <label>条目名（字母/数字/连字符/下划线）</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：browser-verify" style={{ width: "100%", marginBottom: 12 }} />
          <label>内容（Markdown）</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18} placeholder="# 技能说明&#10;..." />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={save}>保存</button>
            {selected && <button onClick={() => startInstall(selected)}>安装到 {installProject} ⤵</button>}
            <span className="muted">{status}</span>
          </div>
        </div>
      </div>

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>安装预览：{preview.kind}/{preview.name} → 项目 {preview.projectId}</h3>
            <p>
              目标路径 <code>{preview.targetPath}</code> ·{" "}
              {preview.action === "new" && <span className="tag done">新增</span>}
              {preview.action === "overwrite" && <span className="tag error">覆盖（内容不同）</span>}
              {preview.action === "identical" && <span className="tag running">内容一致，无需安装</span>}
            </p>
            {preview.action === "overwrite" ? (
              <div className="diff">
                <div>
                  <div className="col-title">项目现有版本</div>
                  <pre>{preview.targetContent}</pre>
                </div>
                <div>
                  <div className="col-title">库版本（将写入）</div>
                  <pre>{preview.sourceContent}</pre>
                </div>
              </div>
            ) : (
              <div>
                <div className="col-title">将写入的内容</div>
                <pre style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, padding: 10, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>{preview.sourceContent}</pre>
              </div>
            )}
            <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button onClick={() => setPreview(null)}>取消</button>
              {preview.action !== "identical" && (
                <button className="primary" onClick={confirmInstall}>
                  {preview.action === "overwrite" ? "确认覆盖并安装" : "确认安装"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
