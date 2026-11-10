// R2 元数据层：带 etag 乐观锁的 JSON 读写
import { ROOT } from './util.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

export const KEY_CONFIG = 'sys/config.json';
export const KEY_INDEX = 'sys/index.json';
export const KEY_SHARES = 'sys/shares.json';
export const KEY_UPLOAD = (id) => `sys/uploads/${id}.json`;
export const KEY_SESSION = (token) => `sys/sessions/${token}.json`;
export const KEY_THROTTLE = (ip) => `sys/throttle/${ip.replace(/[^a-zA-Z0-9.:_-]/g, '_')}.json`;

const INDEX_TTL = 2000;
const SHARES_TTL = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  let value = null;
  try {
    value = await obj.json();
  } catch {
    return null;
  }
  return { value, etag: obj.etag };
}

export async function putJSON(env, key, value, etag) {
  const opts = {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
  };
  if (etag) opts.onlyIf = { etagMatches: etag };
  try {
    const res = await env.BUCKET.put(key, JSON.stringify(value), opts);
    return Boolean(res);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/precondition|etag|conflict|If-Match/i.test(msg)) return false;
    throw err;
  }
}

export async function deleteKeys(env, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (let i = 0; i < list.length; i += 100) {
    await env.BUCKET.delete(list.slice(i, i + 100));
  }
}

/** 索引变更标记：由 api 层在响应后据此决定要不要把快照刷到 HF 仓库 */
export const indexState = { dirty: false, writes: 0 };

/** 带重试的索引读改写；fn 直接修改传入的 index 对象 */
export async function mutateIndex(env, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    // 这里必须绕过缓存，拿到最新 etag
    const cur = await getJSON(env, KEY_INDEX);
    const index = cur?.value && cur.value.nodes ? cur.value : { v: 1, nodes: {}, updatedAt: 0 };
    const result = await fn(index);
    index.updatedAt = Date.now();
    const ok = await putJSON(env, KEY_INDEX, index, cur?.etag);
    if (ok) {
      cacheSet('index', index, INDEX_TTL);
      indexState.dirty = true;
      indexState.writes++;
      return result;
    }
    await sleep(15 + Math.random() * 60 * (attempt + 1));
  }
  throw new Error('元数据繁忙，请重试（索引写入冲突）');
}

export async function readIndex(env) {
  const hit = cacheGet('index');
  if (hit) return hit;
  const cur = await getJSON(env, KEY_INDEX);
  const index = cur?.value && cur.value.nodes ? cur.value : { v: 1, nodes: {}, updatedAt: 0 };
  return cacheSet('index', index, INDEX_TTL);
}

export function invalidateIndex() {
  cacheDel('index');
}

export async function mutateShares(env, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getJSON(env, KEY_SHARES);
    const shares = cur?.value?.shares ? cur.value : { v: 1, shares: {} };
    const result = await fn(shares);
    const ok = await putJSON(env, KEY_SHARES, shares, cur?.etag);
    if (ok) {
      cacheSet('shares', shares, SHARES_TTL);
      return result;
    }
    await sleep(15 + Math.random() * 60);
  }
  throw new Error('分享数据写入冲突，请重试');
}

export async function readShares(env) {
  const hit = cacheGet('shares');
  if (hit) return hit;
  const cur = await getJSON(env, KEY_SHARES);
  const shares = cur?.value?.shares ? cur.value : { v: 1, shares: {} };
  return cacheSet('shares', shares, SHARES_TTL);
}

// ---------- 索引查询辅助 ----------

export function getNode(index, id) {
  if (!id || id === ROOT) return null;
  return index.nodes[id] || null;
}

export function childrenOf(index, parentId, { trash = false } = {}) {
  const out = [];
  for (const node of Object.values(index.nodes)) {
    const inTrash = Boolean(node.trashedAt);
    if (trash !== inTrash) continue;
    const p = inTrash ? node.trashParent : node.parent;
    if (p === parentId) out.push(node);
  }
  return out;
}

export function subtreeIds(index, id, { includeTrash = false } = {}) {
  const ids = [id];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const node of Object.values(index.nodes)) {
      if (node.parent === cur && (includeTrash || !node.trashedAt)) {
        ids.push(node.id);
        stack.push(node.id);
      }
    }
  }
  return ids;
}

export function isDescendant(index, candidateId, ancestorId) {
  let cur = getNode(index, candidateId);
  let guard = 0;
  while (cur && guard++ < 500) {
    if (cur.parent === ancestorId) return true;
    cur = getNode(index, cur.parent);
  }
  return false;
}

export function pathOf(index, id) {
  const names = [];
  let cur = getNode(index, id);
  let guard = 0;
  while (cur && guard++ < 500) {
    names.unshift(cur.name);
    cur = getNode(index, cur.parent);
  }
  return names;
}

export function uniqueName(index, parentId, desired, ignoreId = null) {
  const siblings = childrenOf(index, parentId).filter((n) => n.id !== ignoreId);
  const taken = new Set(siblings.map((n) => n.name.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf('.');
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

export function usedBytes(index, { includeTrash = true } = {}) {
  let total = 0;
  for (const node of Object.values(index.nodes)) {
    if (node.type !== 'file') continue;
    if (!includeTrash && node.trashedAt) continue;
    total += node.size || 0;
  }
  return total;
}

export function publicNode(node, extra = {}) {
  if (!node) return null;
  return {
    id: node.id,
    parent: node.parent,
    type: node.type,
    name: node.name,
    size: node.size || 0,
    mime: node.mime || '',
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    starred: Boolean(node.starred),
    trashedAt: node.trashedAt || null,
    trashParent: node.trashParent || null,
    chunks: node.chunks || 0,
    ...extra,
  };
}
