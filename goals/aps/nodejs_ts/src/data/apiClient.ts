/**
 * src/data/apiClient.ts
 * ============================================================
 * 乐歌低代码平台 ApiEngine HTTP 客户端
 *
 * - 调用格式：POST {baseUrl}/api/ApiEngine/Run
 * - Header: Authorization: Bearer <token>（从 ~/study/CE/.env 的 TOKEN 读）
 * - Body:  { ApiEngineKey, Param: {...} }
 * - Resp:  { Code: 1, Data: any, Msg: 'OK' }
 *
 * 401 / 1001 自动续期 + 重试：
 *   1. 收到 401/1001 → 调 /api/SysUser/refreshToken
 *   2. refreshToken 用旧 token（在 grace period 内的） 换新 token
 *   3. 把新 token 写回 ~/study/CE/.env（只动 TOKEN 这一行）
 *   4. 用新 token 重试刚才的请求
 *
 * 支持 mock 模式（MOCK_MODE=true 时所有请求走本地 fixture）
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';

export interface ApiRunParam {
    [key: string]: string | number | boolean | null | undefined;
}

export interface ApiRunResult<T = any> {
    Code: number;
    Data?: T;
    DataCount?: number;
    Msg?: string;
}

// ============================================================================
// Token 管理：从 ~/study/CE/.env 读取，自动 refresh 后写回
// ============================================================================
const ENV_FILE = process.env.LOWCODE_TOKEN_FILE
    || path.join(os.homedir(), 'study', 'CE', '.env');

let _tokenCache: string | null = null;

/** 从 ~/study/CE/.env 读 TOKEN（不写、只读） */
function loadTokenFromEnv(): string | null {
    try {
        if (!fs.existsSync(ENV_FILE)) return null;
        const text = fs.readFileSync(ENV_FILE, 'utf-8');
        const m = text.match(/^TOKEN=(.+)$/m);
        return m ? m[1].trim() : null;
    } catch {
        return null;
    }
}

/** 把新 token 写回 ~/study/CE/.env（只动 TOKEN=xxx 一行，其他保留） */
function saveTokenToEnv(newToken: string): void {
    try {
        let text = '';
        if (fs.existsSync(ENV_FILE)) {
            text = fs.readFileSync(ENV_FILE, 'utf-8');
        }
        const updated = text.match(/^TOKEN=.*$/m)
            ? text.replace(/^TOKEN=.*$/m, `TOKEN=${newToken}`)
            : (text ? text.replace(/\n*$/, '\n') + `TOKEN=${newToken}\n` : `TOKEN=${newToken}\n`);
        fs.writeFileSync(ENV_FILE, updated);
        console.log(`[token] ✓ 已写回新 token 到 ${ENV_FILE}（长度 ${newToken.length}）`);
    } catch (e) {
        console.warn(`[token] ✗ 写 ${ENV_FILE} 失败: ${(e as Error).message}`);
    }
}

/** 取 token：缓存优先 → 读 .env → 都没有就抛错 */
export function getToken(): string {
    if (_tokenCache) return _tokenCache;
    const fromEnv = loadTokenFromEnv();
    if (fromEnv) {
        _tokenCache = fromEnv;
        return fromEnv;
    }
    throw new Error(
        `找不到 token。请确认 ${ENV_FILE} 存在且包含 TOKEN=xxx；` +
        `或设置 LOWCODE_TOKEN_FILE 指向其他 .env 文件。`
    );
}

/** 强制清缓存 + 重新读 .env（refresh 后调用） */
function reloadToken(): string {
    _tokenCache = null;
    return getToken();
}

/** 简单展示前 30 + 后 10 字符 */
function maskToken(t: string): string {
    if (t.length <= 50) return `${t.slice(0, 20)}...${t.slice(-10)} (len=${t.length})`;
    return `${t.slice(0, 30)}...${t.slice(-10)} (len=${t.length})`;
}

/**
 * 调用 /api/SysUser/refreshToken 续期
 * - 必须是 form-urlencoded，不能用 JSON
 * - 启发式解析：新 token 可能在 Data.Token / Token / 或者直接是 eyJ 开头的字符串
 */
export async function refreshAccessToken(oldToken: string): Promise<string> {
    const baseUrl = config.api.baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/api/SysUser/refreshToken`;
    const body = `authorization=${encodeURIComponent(oldToken)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'authorization': `Bearer ${oldToken}`,
            'did': '035f8904-3875-4e38-b12e-9020a6553e35',
            'Origin': 'https://lowcode-center.loctek.com',
            'Referer': 'https://lowcode-center.loctek.com/',
        },
        body,
    });
    const json: any = await res.json().catch(() => ({}));
    if (json?.Code !== 1) {
        throw new Error(`refreshToken 失败: ${json?.Msg || JSON.stringify(json).slice(0, 200)}`);
    }
    // 启发式：找 eyJ 开头的最长串
    const text = JSON.stringify(json);
    const matches = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
    if (matches.length === 0) {
        throw new Error(`refreshToken 返回里找不到新 token: ${text.slice(0, 200)}`);
    }
    const newToken = matches.reduce((a, b) => (b.length > a.length ? b : a));
    return newToken;
}

/**
 * 当请求返回 401 / 1001 时自动续期 + 重试
 * 最多重试 1 次（避免无限循环）
 */
async function ensureFreshToken(): Promise<void> {
    const oldToken = getToken();
    console.log(`[token] ⚠️ 检测到 token 失效，尝试 refreshToken（${maskToken(oldToken)}）`);
    try {
        const newToken = await refreshAccessToken(oldToken);
        _tokenCache = newToken;       // 更新内存缓存
        saveTokenToEnv(newToken);       // 写回 .env
        console.log(`[token] ✓ 续期成功：${maskToken(newToken)}`);
    } catch (e) {
        throw new Error(`token 续期失败: ${(e as Error).message}。` +
            `请登录 https://lowcode-center.loctek.com 获取新 token 后写回 ${ENV_FILE}`);
    }
}

// ============================================================================
// ApiEngine Run
// ============================================================================
export async function runApi<T = any>(apiKey: string, param: ApiRunParam = {}): Promise<T> {
    if (config.api.mockMode) {
        return runMock<T>(apiKey, param);
    }
    const baseUrl = config.api.baseUrl.replace(/\/$/, '');

    let retried = false;
    let lastError: any;
    // 最多重试 2 次：HTTP/JSON 错误 → 退避后重试；token 失效 → refresh 后重试
    for (let attempt = 0; attempt < 2; attempt++) {
        const useToken = getToken();
        let json: any;
        try {
            const r = await fetch(`${baseUrl}/api/ApiEngine/Run`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${useToken}`,
                    'Content-Type': 'application/json',
                    'did': '035f8904-3875-4e38-b12e-9020a6553e35',
                    'Origin': 'https://lowcode-center.loctek.com',
                    'Referer': 'https://lowcode-center.loctek.com/',
                },
                body: JSON.stringify({ ApiEngineKey: apiKey, Param: param }),
            });
            const text = await r.text();
            try {
                json = JSON.parse(text);
            } catch {
                // 网关错误（502/503/超时）→ HTML 而非 JSON
                lastError = new Error(`${apiKey} HTTP ${r.status} 返回非 JSON (${text.slice(0, 80)})`);
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
                continue;
            }
        } catch (e) {
            lastError = new Error(`${apiKey} HTTP 失败: ${(e as Error).message}`);
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
            continue;
        }

        // 检测 token 失效
        const isExpired =
            json?.Code === 1001 ||
            json?.Code === 1002 ||
            json?.Code === 401 ||
            (typeof json?.Msg === 'string' && /身份已过期|未登录|token.*invalid/i.test(json.Msg));

        if (isExpired && !retried) {
            retried = true;
            await ensureFreshToken();
            continue;
        }

        if (json?.Code !== 1) {
            throw new Error(`${apiKey}: ${json?.Msg || JSON.stringify(json).slice(0, 200)}`);
        }
        return json.Data as T;
    }
    throw lastError || new Error(`${apiKey}: 重试 3 次仍失败`);
}

/* ============================================================
 *  Mock 模式：从本地 fixtures 加载
 * ============================================================ */
const FIXTURE_DIR_CANDIDATES = [
    path.join(process.cwd(), 'src', 'data', 'mock', 'fixtures'),
    path.join(process.cwd(), 'dist', 'data', 'mock', 'fixtures'),
    path.join(__dirname, '..', 'data', 'mock', 'fixtures'),
    path.join(__dirname, 'mock', 'fixtures'),
    path.join(__dirname, '..', '..', 'src', 'data', 'mock', 'fixtures'),
];

let MOCK_DIR = '';
for (const d of FIXTURE_DIR_CANDIDATES) {
    if (fs.existsSync(d)) { MOCK_DIR = d; break; }
}
if (!MOCK_DIR && config.api.strictMock) {
    throw new Error(`[mock] 未找到 fixtures 目录，尝试过: ${FIXTURE_DIR_CANDIDATES.join(', ')}`);
}

function loadMockFile(apiKey: string, site: string): any | null {
    const candidates = [
        path.join(MOCK_DIR, `${apiKey}_${site}.json`),
        path.join(MOCK_DIR, `${apiKey}.json`),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    return null;
}

async function runMock<T = any>(apiKey: string, param: ApiRunParam): Promise<T> {
    const site = String(param.site || 'LG');
    const file = loadMockFile(apiKey, site);
    if (!file) {
        if (config.api.strictMock) {
            throw new Error(`[mock] missing fixture: ${apiKey}_${site}.json`);
        }
        console.warn(`[mock] fixture not found: ${apiKey}_${site}.json → empty result`);
        return { columns: [], rows: [], total: 0 } as any;
    }
    const data = file.Data || file;
    let rows: any[] = data.rows || [];
    const page = Number(param.page || 1);
    const pageSize = Number(param.pageSize || 10000);
    if (rows.length > pageSize) {
        rows = rows.slice((page - 1) * pageSize, page * pageSize);
    }
    return { ...data, rows } as T;
}

// ============================================================================
// 调试辅助
// ============================================================================
/** 清掉内存 token 缓存（让下次 getToken 重新读 .env） */
export function clearTokenCache(): void {
    _tokenCache = null;
}

/** 当前 token 来源信息（用于健康检查） */
export function tokenInfo(): { source: string; length: number; prefix: string } {
    const t = getToken();
    return { source: ENV_FILE, length: t.length, prefix: t.slice(0, 20) };
}
