// 单 isolate 内的短 TTL 缓存。
// 目的：把「每个请求 3 次 R2 往返（会话 / 配置 / 索引）」压到 0 次。
// 一致性策略：写路径在同 isolate 内主动回填缓存，跨 isolate 最多容忍 TTL 级别的延迟。
const store = new Map();
const MAX_ENTRIES = 400;

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.exp < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, exp: Date.now() + ttlMs });
  if (store.size > MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of store) if (v.exp < now) store.delete(k);
    // 仍然超限就丢掉最早写入的一批
    if (store.size > MAX_ENTRIES) {
      let drop = store.size - MAX_ENTRIES;
      for (const k of store.keys()) {
        store.delete(k);
        if (--drop <= 0) break;
      }
    }
  }
  return value;
}

export function cacheDel(key) {
  store.delete(key);
}

export function cacheClear() {
  store.clear();
}

export function cacheStats() {
  return { size: store.size };
}
