/**
 * src/admin/server.ts
 * ============================================================
 * 管理后台独立入口（不依赖 MRP 主流程）
 * 跑法：node dist/admin/server.js
 * 访问：http://localhost:8080/
 */
import { startHttpServer } from '../httpServer';

const port = parseInt(process.env.APS_HTTP_PORT || '8080', 10);
process.env.APS_HTTP_PORT = String(port);
const outputDir = process.env.APS_OUTPUT_DIR || `${process.cwd()}/output`;

console.log(`[admin] 启动管理后台 → http://localhost:${port}/`);
console.log(`[admin] output dir: ${outputDir}`);
startHttpServer(outputDir);
