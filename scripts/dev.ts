/**
 * 并行启动 server (8787) + vite (5173) 的开发脚本。
 * 零依赖:仅用 node:child_process 与 node:process 原生能力。
 *
 * 行为:
 *  - server / vite 各自加 prefix + ANSI 着色,stdout/stderr 一目了然
 *  - 任一子进程崩溃 → 全部 kill 并以非零码退出
 *  - Ctrl-C (SIGINT) / SIGTERM → 干净关闭所有子进程
 *
 * 用法:npm run dev
 */
import { spawn } from "node:child_process";
import process from "node:process";

type Child = ReturnType<typeof spawn>;

interface Job {
  name: string;
  cmd: string;
  args: string[];
  color: string; // ANSI 颜色码
}

const JOBS: Job[] = [
  {
    name: "server",
    cmd: "tsx",
    args: ["src/server/app.ts"],
    color: "\x1b[36m", // cyan
  },
  {
    name: "web",
    cmd: "vite",
    args: ["--config", "web/vite.config.ts"],
    color: "\x1b[35m", // magenta
  },
];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function prefix(job: Job): string {
  return `${BOLD}${job.color}[${job.name.padEnd(6)}]${RESET}`;
}

function pipe(child: Child, job: Job, stream: NodeJS.ReadableStream) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) emit(job, line);
  });
  stream.on("end", () => {
    if (buf) emit(job, buf);
    buf = "";
  });
}

function emit(job: Job, line: string) {
  // vite/hono 都可能输出 ANSI 颜色,简单透传;prefix 单独加
  process.stdout.write(`${prefix(job)} ${line}\n`);
}

const children: Child[] = [];

function shutdown(code = 0) {
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
  // 给子进程 2s 优雅退出,超时强杀
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    process.exit(code);
  }, 2000);
}

function spawnJob(job: Job) {
  const child = spawn(job.cmd, job.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  pipe(child, job, child.stdout);
  pipe(child, job, child.stderr);

  child.on("exit", (code, signal) => {
    const reason = signal ? `signal=${signal}` : `code=${code}`;
    process.stdout.write(`${prefix(job)} exited (${reason})\n`);
    if (!shuttingDown) {
      // 子进程自己挂了 → 拉整个进程组一起退出
      shuttingDown = true;
      shutdown(code ?? 1);
    }
  });

  children.push(child);
}

let shuttingDown = false;

for (const job of JOBS) spawnJob(job);

process.stdout.write(`${BOLD}\n[dev]${RESET} 启动 ${JOBS.length} 个进程: ${JOBS.map((j) => j.name).join(", ")}\n\n`);

process.on("SIGINT", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${BOLD}[dev]${RESET} 收到 SIGINT,关闭所有子进程...\n`);
  shutdown(0);
});

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdown(0);
});