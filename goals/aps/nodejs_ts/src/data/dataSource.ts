/**
 * src/data/dataSource.ts
 * ============================================================
 * 数据源选择器
 *
 * 根据 config.oracle.source 决定 getOracleDB(site) 返回：
 *   'api'   → 走 HTTP 调 CE 的 ApiEngine（推荐生产）
 *   'direct'→ 直连 Oracle（保留给内部调试 / fallback）
 *   'mock'  → 强制走本地 fixtures
 *
 * 默认 'api'。docker / 本地开发都默认走 api。
 * MOCK_MODE=true 时强制走 mock。
 */
import { config } from '../config';
import { OracleDB as DirectDB } from './dataOracle';
import { OracleDB as ApiDB } from './dataOracleApi';

export type OracleSource = 'api' | 'direct' | 'mock';

const instances = new Map<string, DirectDB | ApiDB>();

export function getOracleSource(): OracleSource {
    if (config.api.mockMode) return 'mock';
    const v = (process.env.MRP_ORACLE_SOURCE || 'api') as OracleSource;
    if (v !== 'api' && v !== 'direct' && v !== 'mock') return 'api';
    return v;
}

export function getOracleDB(site: string): DirectDB | ApiDB {
    const key = `${getOracleSource()}|${site}`;
    let inst = instances.get(key);
    if (inst) return inst;
    const src = getOracleSource();
    if (src === 'direct') {
        inst = new DirectDB(site);
    } else {
        // api 和 mock 都用 ApiDB（apiClient 内部根据 MOCK_MODE 走 fixture）
        inst = new ApiDB(site);
    }
    instances.set(key, inst);
    return inst;
}

export function clearOracleInstances(): void {
    instances.clear();
}
