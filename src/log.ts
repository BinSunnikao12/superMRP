import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_DIR = new URL("../logs/", import.meta.url).pathname;

function stamp(): string {
  // 注意：普通脚本里 new Date() 可用；这里用于日志时间戳。
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** 追加一行到某个角色的日志文件（logs/<role>.md），并同时打印到控制台。 */
export function log(role: string, line: string): void {
  const file = `${LOG_DIR}${role}.md`;
  mkdirSync(dirname(file), { recursive: true });
  const entry = `[${stamp()}] ${line}\n`;
  appendFileSync(file, entry);
  console.log(`\x1b[36m[${role}]\x1b[0m ${line}`);
}

/** 把 SDK 的一条 message 摘要成人类可读的一行，落到日志。 */
export function logMessage(role: string, m: any): void {
  if (m?.type === "assistant" && m.message?.content) {
    for (const block of m.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        log(role, `💬 ${block.text.trim().slice(0, 500)}`);
      } else if (block.type === "tool_use") {
        const input = JSON.stringify(block.input).slice(0, 200);
        log(role, `🔧 ${block.name}(${input})`);
      }
    }
  } else if (m?.type === "result") {
    const u = m.usage || {};
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0);
    log(role, `✅ 完成 (session=${m.session_id}, tokens≈${tok})`);
  }
}
