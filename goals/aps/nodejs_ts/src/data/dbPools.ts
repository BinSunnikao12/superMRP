/**
 * src/data/dbPools.ts
 * ============================================================
 * 集中管理 MySQL / Oracle / MES 三个连接池
 *
 * - 每个进程共用一个 mysql2 pool（不每次 createConnection）
 * - oracledb 用 createPool 复用连接，thin mode 也支持
 * - MES 用轻量 pool（按需即用）
 *
 * 全部走 src/config.ts 配置
 */
import mysql from 'mysql2/promise';
import oracledb from 'oracledb';
import { config } from '../config';

let _mysqlPool: mysql.Pool | null = null;
let _mesPool: mysql.Pool | null = null;
let _oraclePoolInitialized = false;

export function mysqlPool(): mysql.Pool {
    if (_mysqlPool) return _mysqlPool;
    _mysqlPool = mysql.createPool({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database,
        waitForConnections: true,
        connectionLimit: config.mysql.connectionLimit,
        queueLimit: 0,
        // 批量插入提速
        multipleStatements: false,
        // 默认 utf8mb4
        charset: 'utf8mb4_unicode_ci',
    });
    return _mysqlPool;
}

export function mesPool(): mysql.Pool {
    if (_mesPool) return _mesPool;
    _mesPool = mysql.createPool({
        host: config.mes.host,
        user: config.mes.user,
        password: config.mes.password,
        database: config.mes.database,
        waitForConnections: true,
        connectionLimit: 4,
        queueLimit: 0,
    });
    return _mesPool;
}

/**
 * 初始化 Oracle 连接池（应用启动时调一次）
 * - thick mode 在开发机要设置 libDir；thin mode 不需要
 * - 这里用 thin mode，跨平台通用
 */
export async function initOraclePool(): Promise<void> {
    if (_oraclePoolInitialized) return;
    try {
        await oracledb.createPool({
            user: config.oracle.user,
            password: config.oracle.password,
            connectString: config.oracle.connectString,
            poolMin: config.oracle.poolMin,
            poolMax: config.oracle.poolMax,
            poolIncrement: config.oracle.poolIncrement,
            poolTimeout: 60,
        });
        _oraclePoolInitialized = true;
    } catch (e) {
        // 第一次 ORACLE 连接失败也允许继续（MRP 跑 dry-run 时不需要 Oracle）
        console.warn('[Oracle pool] init failed:', (e as Error).message);
    }
}

export async function closeOraclePool(): Promise<void> {
    if (!_oraclePoolInitialized) return;
    try {
        await oracledb.getPool().close(10);
    } catch { /* ignore */ }
    _oraclePoolInitialized = false;
}

/**
 * 从 Oracle 池里借连接
 */
export async function withOracleConnection<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
    if (!_oraclePoolInitialized) await initOraclePool();
    const conn = await oracledb.getPool().getConnection();
    try {
        return await fn(conn);
    } finally {
        try { await conn.close(); } catch { /* ignore */ }
    }
}

export async function shutdownAllPools(): Promise<void> {
    if (_mysqlPool) { await _mysqlPool.end(); _mysqlPool = null; }
    if (_mesPool) { await _mesPool.end(); _mesPool = null; }
    await closeOraclePool();
}
