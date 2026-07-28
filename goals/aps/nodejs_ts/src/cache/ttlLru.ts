/**
 * src/cache/ttlLru.ts
 * ============================================================
 * 通用 LRU + TTL 缓存（无外部依赖）
 *
 * - key: 任意 string（推荐用 `${site}|${method}|${其他}` 形式）
 * - value: 任意
 * - TTL: 命中后 5~10 分钟内复用，避免 Oracle/MySQL 重复查询
 * - LRU: 超出 maxEntries 自动淘汰最久未访问
 * - 线程安全：Node 单线程，map.set/delete 即可
 *
 * 命中统计：
 *   - hits / misses / evictions 通过 stats() 暴露，便于监控
 *   - 推荐接入 Prometheus / log
 */
interface Entry<V> {
    value: V;
    expiresAt: number;       // Date.now() + ttl
    lastAccessAt: number;    // 用于 LRU
}

export class TtlLru<V = unknown> {
    private map = new Map<string, Entry<V>>();
    private hits = 0;
    private misses = 0;
    private evictions = 0;
    private expirations = 0;

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries: number,
    ) {
        if (ttlMs <= 0) throw new Error('ttlMs must be > 0');
        if (maxEntries <= 0) throw new Error('maxEntries must be > 0');
    }

    /**
     * 命中并返回值，过期返回 undefined
     */
    get(key: string): V | undefined {
        const e = this.map.get(key);
        if (!e) {
            this.misses++;
            return undefined;
        }
        if (Date.now() > e.expiresAt) {
            this.map.delete(key);
            this.expirations++;
            this.misses++;
            return undefined;
        }
        // LRU 更新：先删再插
        this.map.delete(key);
        e.lastAccessAt = Date.now();
        this.map.set(key, e);
        this.hits++;
        return e.value;
    }

    /**
     * 写入或覆盖；返回 value 便于链式调用
     */
    set(key: string, value: V): V {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.maxEntries) {
            // 淘汰最久未访问的（Map 迭代顺序 = 插入顺序，第一项即最久）
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) {
                this.map.delete(oldest);
                this.evictions++;
            }
        }
        this.map.set(key, {
            value,
            expiresAt: Date.now() + this.ttlMs,
            lastAccessAt: Date.now(),
        });
        return value;
    }

    /**
     * 命中则返回，否则执行 loader 并写入
     */
    async wrap<T extends V>(key: string, loader: () => Promise<T>): Promise<T> {
        const v = this.get(key);
        if (v !== undefined) return v as T;
        const fresh = await loader();
        this.set(key, fresh);
        return fresh;
    }

    /**
     * 同步版 wrap
     */
    wrapSync<T extends V>(key: string, loader: () => T): T {
        const v = this.get(key);
        if (v !== undefined) return v as T;
        const fresh = loader();
        this.set(key, fresh);
        return fresh;
    }

    has(key: string): boolean {
        const e = this.map.get(key);
        if (!e) return false;
        if (Date.now() > e.expiresAt) {
            this.map.delete(key);
            this.expirations++;
            return false;
        }
        return true;
    }

    delete(key: string): boolean {
        return this.map.delete(key);
    }

    clear(): void {
        this.map.clear();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        this.expirations = 0;
    }

    size(): number {
        return this.map.size;
    }

    stats(): { hits: number; misses: number; evictions: number; expirations: number; size: number; hitRate: number } {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            expirations: this.expirations,
            size: this.map.size,
            hitRate: total === 0 ? 0 : this.hits / total,
        };
    }
}

/**
 * 全局单例缓存池：按 (site, namespace) 划分实例
 * 同一进程内多基地跑不会互相覆盖
 */
class CachePool {
    private pools = new Map<string, TtlLru<any>>();
    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries: number,
    ) {}
    get(site: string, namespace: string): TtlLru<any> {
        const k = `${site}|${namespace}`;
        let p = this.pools.get(k);
        if (!p) {
            p = new TtlLru(this.ttlMs, this.maxEntries);
            this.pools.set(k, p);
        }
        return p;
    }
    allStats(): Record<string, ReturnType<TtlLru['stats']>> {
        const out: Record<string, any> = {};
        for (const [k, p] of this.pools) out[k] = p.stats();
        return out;
    }
}

import { config } from '../config';
export const cachePool = new CachePool(config.cache.ttlSeconds * 1000, config.cache.maxEntries);
