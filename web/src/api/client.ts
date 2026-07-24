/** 极简的 fetch 包装:所有请求同源,JSON 进出 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export interface OrchestratorStatus {
  accounts: { id: string }[];
  keyFallback: boolean;
  perKeyBudget: number;
  liveRuns: { runId: string; projectId: string; startedAt: number; currentRound: number; totalTokens: number; state: string }[];
  poolSnapshot: Record<string, number>;
}

export interface RunSummary {
  runId: string;
  tokens: number;
  ts: number;
  projectId: string;
}

export interface UsageTotals {
  groupBy: "role" | "account" | "project";
  totals: Record<string, number>;
}

export interface UiEvent {
  ts: number;
  sessionId: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

export interface TaskRow {
  taskId: string;
  role: string;
  accountId?: string;
  instruction: string;
  startedAt: number;
  doneAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  exhausted?: boolean;
  status: "running" | "done" | "error";
}

/**
 * 上报一条 UI 行为事件到后端。失败静默吞,不应影响页面交互。
 * 用 fire-and-forget:不 await,也不弹错。
 */
export function trackUiEvent(e: Omit<UiEvent, "ts"> & { ts?: number }): void {
  const body: UiEvent = { ts: e.ts ?? Date.now(), sessionId: e.sessionId, action: e.action, target: e.target, meta: e.meta };
  apiPost<{ ok: boolean }>("/api/v1/ui-events", body).catch(() => {});
}

// —— Slice 2 项目隔离：项目发现 ——
export interface ProjectSummary {
  id: string;
  legacy: boolean;
  hasGoals: boolean;
  hasWorkspace: boolean;
  iterationCount: number;
}

export interface ProjectDetail {
  id: string;
  legacy: boolean;
  summary: ProjectSummary | null;
  paths: {
    goals: string;
    workspace: string;
    iterations: string;
    skills: string;
    kb: string;
    session: string;
  };
}

/** 列出所有项目摘要（给项目选择器 / 未来 Slice 3 用）。 */
export async function listProjects(): Promise<ProjectSummary[]> {
  return api<{ projects: ProjectSummary[] }>("/api/v1/projects").then((r) => r.projects);
}

/** 单项目详情（相对路径）。 */
export async function getProject(id: string): Promise<ProjectDetail> {
  return api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(id)}`);
}

// —— Slice 3：Skill/KB 库 + 安装前预览 + 单角色聊天 ——

export type LibKind = "skill" | "kb";

export interface LibEntry {
  kind: LibKind;
  name: string;
  bytes: number;
  updatedAt: number;
}

export interface InstallPreviewData {
  kind: LibKind;
  name: string;
  projectId: string;
  targetPath: string;
  action: "new" | "overwrite" | "identical";
  sourceContent: string;
  targetContent?: string;
}

export async function listLibrary(kind: LibKind): Promise<LibEntry[]> {
  return api<{ kind: LibKind; entries: LibEntry[] }>(`/api/v1/library/${kind}`).then((r) => r.entries);
}

export async function readLibraryEntry(kind: LibKind, name: string): Promise<string> {
  return api<{ content: string }>(`/api/v1/library/${kind}/${encodeURIComponent(name)}`).then((r) => r.content);
}

export async function saveLibraryEntry(kind: LibKind, name: string, content: string): Promise<LibEntry> {
  return api<{ ok: boolean; entry: LibEntry }>(`/api/v1/library/${kind}/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  }).then((r) => r.entry);
}

export async function deleteLibraryEntry(kind: LibKind, name: string): Promise<boolean> {
  return api<{ ok: boolean; removed: boolean }>(`/api/v1/library/${kind}/${encodeURIComponent(name)}`, {
    method: "DELETE",
  }).then((r) => r.removed);
}

export async function getInstallPreview(kind: LibKind, name: string, project: string): Promise<InstallPreviewData> {
  const qs = `kind=${kind}&name=${encodeURIComponent(name)}&project=${encodeURIComponent(project)}`;
  return api<InstallPreviewData>(`/api/v1/install-preview?${qs}`);
}

export async function doInstall(kind: LibKind, name: string, project: string, confirmOverwrite: boolean): Promise<{ action: string; targetPath: string }> {
  return api<{ ok: boolean; action: string; targetPath: string }>(`/api/v1/install`, {
    method: "POST",
    body: JSON.stringify({ kind, name, project, confirmOverwrite }),
  });
}

export async function listInstalled(project: string, kind: LibKind): Promise<LibEntry[]> {
  return api<{ entries: LibEntry[] }>(`/api/v1/projects/${encodeURIComponent(project)}/installed/${kind}`).then((r) => r.entries);
}

export interface RoleInfo {
  id: string;
  prompt: string;
}

export async function listRoles(): Promise<RoleInfo[]> {
  return api<{ roles: RoleInfo[] }>(`/api/v1/roles`).then((r) => r.roles);
}

// —— 聊天线程持久化 ——

export type ChatWho = "user" | "assistant" | "tool";

export interface ChatMessage {
  who: ChatWho;
  text: string;
  ts: number;
}

export interface ChatThread {
  id: string;
  projectId: string;
  role: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  messages: ChatMessage[];
}

export interface ChatThreadSummary {
  id: string;
  projectId: string;
  role: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage?: string;
}

export async function listThreads(project: string): Promise<ChatThreadSummary[]> {
  return api<{ threads: ChatThreadSummary[] }>(`/api/v1/projects/${encodeURIComponent(project)}/threads`).then((r) => r.threads);
}

export async function readThread(project: string, threadId: string): Promise<ChatThread> {
  return api<ChatThread>(`/api/v1/projects/${encodeURIComponent(project)}/threads/${encodeURIComponent(threadId)}`);
}

export async function createThread(project: string, role: string, title?: string): Promise<ChatThread> {
  return api<ChatThread>(`/api/v1/projects/${encodeURIComponent(project)}/threads`, {
    method: "POST",
    body: JSON.stringify({ role, title }),
  });
}

export async function deleteThread(project: string, threadId: string): Promise<boolean> {
  return api<{ ok: boolean; removed: boolean }>(`/api/v1/projects/${encodeURIComponent(project)}/threads/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
  }).then((r) => r.removed);
}
