/**
 * src/config.ts
 * ============================================================
 * 配置中心（统一从 env 读）
 *
 * - 数据库连接参数（MySQL / Oracle / MES）
 * - 缓存 TTL / LRU 容量
 * - 基地列表
 * - 性能参数
 *
 * 提供两套读取：
 *   - 从进程 env（dotenv 预加载）   优先级高
 *   - 默认值（与 .env.example 一致）
 */
import * as fs from 'fs';
import * as path from 'path';

// ---------- 简易 .env 加载（避免 dotenv 依赖） ----------
function loadDotEnv(): void {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
        if (!line || line.trim().startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!(k in process.env)) process.env[k] = v;
    }
}
loadDotEnv();

function envStr(key: string, def: string): string {
    return process.env[key] ?? def;
}
function envInt(key: string, def: number): number {
    const v = process.env[key];
    if (!v) return def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

export const config = {
    sites: envStr('MRP_SITES', 'LG,YN,QU,GX,FN').split(',').map(s => s.trim()).filter(Boolean),

    mysql: {
        // 容器内走 mrp-mysql 服务名；本地调试走 localhost + 端口映射
        host: envStr('MRP_MYSQL_HOST', 'mrp-mysql'),
        port: envInt('MRP_MYSQL_PORT', 3306),
        user: envStr('MRP_MYSQL_USER', 'root'),
        password: envStr('MRP_MYSQL_PASSWORD', 'loctek@2023'),
        database: envStr('MRP_MYSQL_DATABASE', 'mrp'),
        connectionLimit: envInt('DB_POOL_SIZE', 10),
    },

    mes: {
        host: envStr('MRP_MES_HOST', '10.19.204.8'),
        user: envStr('MRP_MES_USER', 'lowcode'),
        password: envStr('MRP_MES_PASSWORD', '6V_YBn*q'),
        database: envStr('MRP_MES_DATABASE', 'lowcode'),
    },

    oracle: {
        user: envStr('MRP_ORACLE_USER', 'erp_reader'),
        password: envStr('MRP_ORACLE_PASSWORD', 'erp#query'),
        connectString: envStr('MRP_ORACLE_CONNECT_STRING', '192.168.0.199:1521/topprd'),
        poolMin: 1,
        poolMax: envInt('DB_POOL_SIZE', 10),
        poolIncrement: 1,
        // 业务库 schema（默认 TIPTOP 用户即当前用户，留空走默认）
        schema: envStr('MRP_ORACLE_SCHEMA', ''),
    },

    output: {
        dir: envStr('APS_OUTPUT_DIR', ''),  // 留空走相对路径
    },

    api: {
        // 乐歌低代码平台 baseUrl
        baseUrl: envStr('LOWCODE_API_BASE_URL', 'http://localhost:8089'),
        // MOCK_MODE=true 时所有数据查询走本地 fixtures（不用连 Oracle/低代码）
        mockMode: envStr('MOCK_MODE', 'false') === 'true',
        // 严格 mock 模式：缺 fixture 直接抛错（开发期）；false 时缺 fixture 返回空
        strictMock: envStr('MOCK_STRICT', 'false') === 'true',
        // 单页最大条数（远大于 1000 时要分页）
        maxPageSize: envInt('API_MAX_PAGE_SIZE', 5000),
        // Token 文件路径（默认 ~/study/CE/.env）
        tokenFile: envStr('LOWCODE_TOKEN_FILE', ''),
    },

    cache: {
        ttlSeconds: envInt('CACHE_TTL_SECONDS', 600),
        maxEntries: envInt('CACHE_MAX_ENTRIES', 64),
    },

    perf: {
        bomMaxDepth: envInt('BOM_MAX_DEPTH', 200),
    },
};

// 静默导出，外部直接 import { config }
export type AppConfig = typeof config;
