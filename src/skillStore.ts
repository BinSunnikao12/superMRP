/**
 * 全局 Skill / KB 库 + 「安装到项目」（Slice 3）
 * ================================================================
 * 概念（v1 最简、可安全 CRUD 的模型）：
 *  - 一个「技能」或「知识条目」= 一个单独的 .md 文件。
 *  - 全局库（源）：library/skills/<name>.md、library/kb/<name>.md（见 projectPaths.GLOBAL）。
 *  - 「安装」= 把全局库里某个条目**复制**进某个项目的 skills/<id>/ 或 kb/<id>/。
 *  - 「安装前预览确认」：install-preview 先算出「将新增 / 将覆盖（带 diff）」，
 *    用户确认后再 install 真正落盘。
 *
 * 安全边界（本机、无认证，但仍严格防越界）：
 *  - 条目名严格正则，禁止路径分隔符与 ..，杜绝路径穿越。
 *  - 所有读写路径都 assert 落在 REPO_ROOT 内。
 *  - 只认 .md，不碰其它文件类型。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import {
  GLOBAL,
  REPO_ROOT,
  resolveProject,
  isValidProjectId,
} from "./projectPaths.js";

export type LibKind = "skill" | "kb";

/** 条目名：小写字母/数字/连字符/下划线，1~64 位。 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidEntryName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

function assertInsideRoot(p: string, label: string): void {
  const abs = isAbsolute(p) ? p : join(REPO_ROOT, p);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} 越出仓库根目录，拒绝：${p}`);
  }
}

/** 全局库源目录（绝对）。 */
function libDir(kind: LibKind): string {
  return kind === "skill" ? GLOBAL.libSkillsDir : GLOBAL.libKbDir;
}

/** 项目内安装目标目录（绝对）。 */
function projectTargetDir(kind: LibKind, projectId: string): string {
  const paths = resolveProject({ projectId }).paths;
  return kind === "skill" ? paths.skillsDir : paths.kbDir;
}

function entryFile(dir: string, name: string): string {
  return join(dir, `${name}.md`);
}

export interface LibEntry {
  kind: LibKind;
  name: string;
  bytes: number;
  updatedAt: number; // mtime ms
}

/** 列出某类全局库的所有条目。 */
export function listLibrary(kind: LibKind): LibEntry[] {
  const dir = libDir(kind);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LibEntry[] = [];
  for (const f of names) {
    if (!f.toLowerCase().endsWith(".md")) continue;
    const name = f.slice(0, -3);
    if (!isValidEntryName(name)) continue;
    try {
      const st = statSync(join(dir, f));
      out.push({ kind, name, bytes: st.size, updatedAt: st.mtimeMs });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读一个全局库条目的内容（不存在返回 null）。 */
export function readLibrary(kind: LibKind, name: string): string | null {
  if (!isValidEntryName(name)) throw new Error(`非法条目名：${name}`);
  const file = entryFile(libDir(kind), name);
  assertInsideRoot(file, "库文件");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/** 新增/覆盖一个全局库条目（upsert）。 */
export function writeLibrary(kind: LibKind, name: string, content: string): LibEntry {
  if (!isValidEntryName(name)) throw new Error(`非法条目名：${name}（只允许字母/数字/连字符/下划线）`);
  const dir = libDir(kind);
  const file = entryFile(dir, name);
  assertInsideRoot(file, "库文件");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content, "utf8");
  const st = statSync(file);
  return { kind, name, bytes: st.size, updatedAt: st.mtimeMs };
}

/** 删除一个全局库条目（幂等）。 */
export function deleteLibrary(kind: LibKind, name: string): boolean {
  if (!isValidEntryName(name)) throw new Error(`非法条目名：${name}`);
  const file = entryFile(libDir(kind), name);
  assertInsideRoot(file, "库文件");
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export interface InstallPreview {
  kind: LibKind;
  name: string;
  projectId: string;
  /** 相对仓库根的目标路径。 */
  targetPath: string;
  /** "new" = 项目里还没有；"overwrite" = 已存在会被覆盖；"identical" = 内容一致无需装。 */
  action: "new" | "overwrite" | "identical";
  /** 库版本内容（将要写入的）。 */
  sourceContent: string;
  /** 项目现有内容（overwrite/identical 时有）。 */
  targetContent?: string;
}

/**
 * 预览：把某个全局库条目装进某项目会发生什么。不写任何文件。
 */
export function installPreview(kind: LibKind, name: string, projectId: string): InstallPreview {
  if (!isValidEntryName(name)) throw new Error(`非法条目名：${name}`);
  if (!isValidProjectId(projectId)) throw new Error(`非法项目 id：${projectId}`);
  const source = readLibrary(kind, name);
  if (source === null) throw new Error(`全局库里不存在该条目：${kind}/${name}`);

  const targetDir = projectTargetDir(kind, projectId);
  const targetFile = entryFile(targetDir, name);
  assertInsideRoot(targetFile, "安装目标");

  let action: InstallPreview["action"] = "new";
  let targetContent: string | undefined;
  if (existsSync(targetFile)) {
    targetContent = readFileSync(targetFile, "utf8");
    action = targetContent === source ? "identical" : "overwrite";
  }

  return {
    kind,
    name,
    projectId,
    targetPath: relative(REPO_ROOT, targetFile),
    action,
    sourceContent: source,
    targetContent,
  };
}

export interface InstallResult {
  kind: LibKind;
  name: string;
  projectId: string;
  targetPath: string;
  action: "new" | "overwrite" | "identical";
}

/**
 * 真正安装（复制库条目到项目）。
 * - confirmOverwrite=false 且目标已存在且不同 → 抛错（强制走预览确认流程）。
 * - identical 时直接返回，不重复写。
 */
export function install(
  kind: LibKind,
  name: string,
  projectId: string,
  opts: { confirmOverwrite?: boolean } = {}
): InstallResult {
  const preview = installPreview(kind, name, projectId);
  if (preview.action === "identical") {
    return { kind, name, projectId, targetPath: preview.targetPath, action: "identical" };
  }
  if (preview.action === "overwrite" && !opts.confirmOverwrite) {
    throw new Error(
      `目标已存在且内容不同，需确认覆盖：${preview.targetPath}（请带 confirmOverwrite=true）`
    );
  }
  const targetDir = projectTargetDir(kind, projectId);
  const targetFile = entryFile(targetDir, name);
  assertInsideRoot(targetFile, "安装目标");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetFile, preview.sourceContent, "utf8");
  return { kind, name, projectId, targetPath: preview.targetPath, action: preview.action };
}

/** 列出某项目已安装的条目（项目级 skills/<id> 或 kb/<id>）。 */
export function listInstalled(kind: LibKind, projectId: string): LibEntry[] {
  if (!isValidProjectId(projectId)) throw new Error(`非法项目 id：${projectId}`);
  const dir = projectTargetDir(kind, projectId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LibEntry[] = [];
  for (const f of names) {
    if (!f.toLowerCase().endsWith(".md")) continue;
    const nm = f.slice(0, -3);
    if (!isValidEntryName(nm)) continue;
    try {
      const st = statSync(join(dir, f));
      out.push({ kind, name: nm, bytes: st.size, updatedAt: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
