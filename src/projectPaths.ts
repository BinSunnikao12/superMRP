/**
 * 项目路径解析中枢（Slice 2 · 项目隔离）
 * ================================================================
 * 一套编排代码服务多个项目：每个项目有独立的 goals / workspace / skills / kb /
 * iterations / session，互不干扰。本模块是**唯一**的路径真相源——别处不要再拼 "../workspace/"。
 *
 * 设计要点（来自设计评审 docs/DESIGN-v0.3.md 的 Slice 2 决策）：
 *  1. 纯函数：resolveProject() 不读 process.argv、不产生副作用；argv 解析单独放 parseCli()。
 *  2. 向后兼容：老用法（无参数 / 传 goals/foo.md / 传 goals/）一律映射到**规范 legacy 项目 id = "gym-website"**，
 *     沿用现有的根 goals/ 与根 workspace/（根 workspace 明确归属 gym-website，不是共享）。
 *     绝不使用合成的 "default" id——那会把历史 telemetry(projectId=gym-website) 割裂。
 *  3. 新项目（--project foo）用 goals/foo、workspace/foo、skills/foo、kb/foo、goals/foo/iterations、
 *     .admin/sessions/foo。
 *  4. 全局库预留命名空间 library/skills、library/kb（Slice 3），与项目级 skills/<id> 不冲突。
 *  5. 事件目录 GLOBAL.eventsDir 用**绝对路径**——telemetry 跨进程、且相对 ".admin/events" 一旦
 *     从别的 CWD 启动就会错位。
 *  6. 启动**不**自动搬移/覆盖任何文件；已有内容保持可用。迁移是另外的、可选的、冲突感知的操作。
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute, basename } from "node:path";
import { existsSync, statSync, mkdirSync, readdirSync } from "node:fs";

/** 仓库根目录（本文件在 src/ 下，向上一层即根）。 */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 规范 legacy 项目 id：老用法一律归到它名下。 */
export const LEGACY_PROJECT_ID = "gym-website";

/** 全局（非项目级）路径。事件目录必须绝对。 */
export const GLOBAL = {
  root: REPO_ROOT,
  /** 跨进程 telemetry 事件目录（绝对路径）。 */
  eventsDir: join(REPO_ROOT, ".admin", "events"),
  /** 每项目 session 元信息根。 */
  sessionsDir: join(REPO_ROOT, ".admin", "sessions"),
  /** Slice 3 全局技能库（预留，避免与项目级 skills/<id> 撞名）。 */
  libSkillsDir: join(REPO_ROOT, "library", "skills"),
  /** Slice 3 全局知识库。 */
  libKbDir: join(REPO_ROOT, "library", "kb"),
} as const;

/** 一个项目的全部路径（绝对）。 */
export interface ProjectPaths {
  /** 目标文档目录。 */
  goalsDir: string;
  /** 迭代记录目录（写 ROUND-N.md / LATEST.md 的地方）。 */
  iterationsDir: string;
  /** worker 的 cwd（产出落这里）。 */
  workspaceDir: string;
  /** 项目级技能目录（Slice 3 安装目标）。 */
  skillsDir: string;
  /** 项目级知识库目录。 */
  kbDir: string;
  /** 项目 session 元信息目录。 */
  sessionDir: string;
  /** RUN_REPORT.json 落盘路径。 */
  runReportFile: string;
}

/** 解析结果：给 orchestrator / smoke 用的一切。 */
export interface ResolvedProject {
  id: string;
  paths: ProjectPaths;
  /** loadGoals() 的输入：目录或单文件。 */
  goalInput: string;
  /** 是否走 legacy 兼容档（根 goals/ + 根 workspace/）。 */
  legacy: boolean;
}

/** parseCli 的结构化结果。 */
export interface CliArgs {
  projectId?: string;
  goalArg?: string;
  help: boolean;
}

/** 合法项目 id：小写字母/数字/连字符/下划线，1~64 位，不含路径分隔符。 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidProjectId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("..");
}

/**
 * 解析 argv（不含 node/script 前两项——传 process.argv.slice(2)）。
 * 支持：--project <id> / -p <id> / --project=<id> / 位置参数(目标路径) / --help。
 * 不做校验副作用；非法 id 由 resolveProject 抛错。
 */
export function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--project" || a === "-p") {
      out.projectId = argv[++i];
    } else if (a.startsWith("--project=")) {
      out.projectId = a.slice("--project=".length);
    } else if (a.startsWith("-p=")) {
      out.projectId = a.slice("-p=".length);
    } else if (a.startsWith("-")) {
      // 未知 flag：忽略（保持宽容）
    } else if (out.goalArg === undefined) {
      out.goalArg = a; // 第一个位置参数当目标路径
    }
  }
  return out;
}

/** 确认某绝对路径落在 REPO_ROOT 内（防路径穿越 / 符号链接逃逸）。 */
function assertInsideRoot(p: string, label: string): void {
  const abs = isAbsolute(p) ? p : join(REPO_ROOT, p);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} 越出仓库根目录，拒绝：${p}`);
  }
}

/** 构造某个（非 legacy）项目 id 的路径集。 */
function projectPathsFor(id: string): ProjectPaths {
  const goalsDir = join(REPO_ROOT, "goals", id);
  const workspaceDir = join(REPO_ROOT, "workspace", id);
  return {
    goalsDir,
    iterationsDir: join(goalsDir, "iterations"),
    workspaceDir,
    skillsDir: join(REPO_ROOT, "skills", id),
    kbDir: join(REPO_ROOT, "kb", id),
    sessionDir: join(GLOBAL.sessionsDir, id),
    runReportFile: join(workspaceDir, "RUN_REPORT.json"),
  };
}

/** 构造 legacy（gym-website）兼容档路径：根 goals/ + 根 workspace/。 */
function legacyPaths(): ProjectPaths {
  const goalsDir = join(REPO_ROOT, "goals");
  const workspaceDir = join(REPO_ROOT, "workspace");
  return {
    goalsDir,
    // 迭代记录仍写到 goals/gym-website/iterations（与已上线的 Slice 1 行为一致）
    iterationsDir: join(goalsDir, LEGACY_PROJECT_ID, "iterations"),
    workspaceDir,
    skillsDir: join(REPO_ROOT, "skills", LEGACY_PROJECT_ID),
    kbDir: join(REPO_ROOT, "kb", LEGACY_PROJECT_ID),
    sessionDir: join(GLOBAL.sessionsDir, LEGACY_PROJECT_ID),
    runReportFile: join(workspaceDir, "RUN_REPORT.json"),
  };
}

/**
 * 纯解析：从 {projectId?, goalArg?} 得到完整 ResolvedProject。
 * 规则：
 *  - 显式 --project foo → 隔离项目 foo；goalInput 默认 goals/foo，若带位置参数则用该路径。
 *  - 无 --project：
 *      · 有位置参数（如 goals/x.md 或 goals/）→ legacy 档，goalInput = 该路径。
 *      · 无位置参数 → legacy 档，goalInput = 根 goals/。
 */
export function resolveProject(input: { projectId?: string; goalArg?: string }): ResolvedProject {
  const { projectId, goalArg } = input;

  if (projectId !== undefined) {
    if (!isValidProjectId(projectId)) {
      throw new Error(
        `非法项目 id "${projectId}"：只允许小写字母/数字/连字符/下划线，1~64 位。`
      );
    }
    if (projectId === LEGACY_PROJECT_ID) {
      // 显式指定 gym-website → 仍用 legacy 兼容档（根目录），避免与历史内容割裂
      const paths = legacyPaths();
      const goalInput = goalArg ?? paths.goalsDir;
      assertInsideRoot(goalInput, "目标路径");
      return { id: LEGACY_PROJECT_ID, paths, goalInput, legacy: true };
    }
    const paths = projectPathsFor(projectId);
    const goalInput = goalArg ?? paths.goalsDir;
    assertInsideRoot(goalInput, "目标路径");
    return { id: projectId, paths, goalInput, legacy: false };
  }

  // 无 --project：一律 legacy 兼容档
  const paths = legacyPaths();
  const goalInput = goalArg ?? paths.goalsDir;
  assertInsideRoot(goalInput, "目标路径");
  return { id: LEGACY_PROJECT_ID, paths, goalInput, legacy: true };
}

/** 便捷组合：直接从原始 argv.slice(2) 解析。 */
export function resolveFromArgv(argv: string[]): { cli: CliArgs; project: ResolvedProject } {
  const cli = parseCli(argv);
  const project = resolveProject({ projectId: cli.projectId, goalArg: cli.goalArg });
  return { cli, project };
}

/** 确保运行所需目录存在（幂等；只建目录，绝不删/搬已有文件）。 */
export function ensureProjectDirs(p: ProjectPaths): void {
  for (const dir of [p.workspaceDir, p.iterationsDir, p.sessionDir]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(GLOBAL.eventsDir, { recursive: true });
}

/** 项目发现摘要（给 /api/v1/projects 用；只给相对路径，不泄露绝对文件系统路径）。 */
export interface ProjectSummary {
  id: string;
  legacy: boolean;
  hasGoals: boolean;
  hasWorkspace: boolean;
  iterationCount: number;
}

function countIterations(iterationsDir: string): number {
  try {
    return readdirSync(iterationsDir).filter((f) => /^ROUND-\d+\.md$/i.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * 列出所有项目：goals/<id>/ 下的子目录 ∪ legacy gym-website（若根 goals/ 存在）。
 * 只读，不建目录。
 */
export function listProjects(): ProjectSummary[] {
  const out = new Map<string, ProjectSummary>();

  // 1) legacy gym-website：只要根 goals/ 存在就算
  const rootGoals = join(REPO_ROOT, "goals");
  if (existsSync(rootGoals)) {
    const lp = legacyPaths();
    out.set(LEGACY_PROJECT_ID, {
      id: LEGACY_PROJECT_ID,
      legacy: true,
      hasGoals: true,
      hasWorkspace: existsSync(lp.workspaceDir),
      iterationCount: countIterations(lp.iterationsDir),
    });
  }

  // 2) goals/<id>/ 下的子目录（gym-website 子目录会并入 legacy 条目，不重复列）
  try {
    for (const entry of readdirSync(rootGoals)) {
      const abs = join(rootGoals, entry);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      if (entry === LEGACY_PROJECT_ID) continue; // 已作为 legacy 条目
      if (!isValidProjectId(entry)) continue;
      const paths = projectPathsFor(entry);
      out.set(entry, {
        id: entry,
        legacy: false,
        hasGoals: true,
        hasWorkspace: existsSync(paths.workspaceDir),
        iterationCount: countIterations(paths.iterationsDir),
      });
    }
  } catch {
    /* 根 goals/ 不存在：忽略 */
  }

  return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** 简短用法帮助。 */
export const CLI_HELP = `用法：
  npx tsx src/orchestrator.ts                      # 跑默认(legacy)项目 gym-website，用根 goals/ + workspace/
  npx tsx src/orchestrator.ts goals/foo.md         # legacy 项目，指定单目标文件
  npx tsx src/orchestrator.ts --project foo         # 隔离项目 foo：goals/foo, workspace/foo, ...
  npx tsx src/orchestrator.ts --project foo goals/foo.md   # 隔离项目 foo，指定目标路径
选项：
  --project, -p <id>   选择项目 id（小写字母/数字/连字符/下划线）
  --help, -h           显示本帮助`;
