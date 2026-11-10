// HuggingFace Hub 客户端（把私有 dataset 仓库当作对象存储使用）
import { bytesToB64 } from './util.js';

const BASE = 'https://huggingface.co';

export class HFError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'HFError';
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function hfFetch(url, options, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      lastErr = new HFError(`无法连接 HuggingFace：${err?.message || err}`, 0);
      if (attempt === retries) throw lastErr;
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (res.ok) return res;
    // 429 / 5xx 退避重试
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;
      const wait = retryAfter ? retryAfter * 1000 : 500 * Math.pow(2, attempt) + Math.random() * 300;
      try { await res.body?.cancel(); } catch {}
      await sleep(Math.min(wait, 15000));
      continue;
    }
    let detail = '';
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j.error || j.message || text;
      } catch {
        detail = text;
      }
    } catch {}
    throw new HFError(`HuggingFace 返回 ${res.status}：${String(detail).slice(0, 300)}`, res.status, detail);
  }
  throw lastErr || new HFError('HuggingFace 请求失败', 0);
}

export async function whoami(token) {
  const res = await hfFetch(`${BASE}/api/whoami-v2`, { headers: authHeaders(token) });
  return res.json();
}

export async function createRepo({ token, name, type = 'dataset', private: isPrivate = true }) {
  const res = await hfFetch(`${BASE}/api/repos/create`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, type, private: isPrivate, exist_ok: true }),
  });
  return res.json().catch(() => ({}));
}

export async function repoExists({ token, repo, type = 'dataset' }) {
  try {
    const res = await fetch(`${BASE}/api/${type}s/${repo}`, { headers: authHeaders(token) });
    if (res.status === 404) return false;
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.id);
  } catch {
    return false;
  }
}

export function chunkPath(nodeId, index) {
  return `chunks/${nodeId}/${String(index).padStart(6, '0')}.bin`;
}

function ndjson(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * 用 commit 接口写一个小文件（base64 内联）。适合 <= 10MB 的内容。
 */
export async function commitBase64({ token, repo, path, bytes, summary, type = 'dataset' }) {
  const body = ndjson([
    { key: 'header', value: { summary: summary || `upload ${path}` } },
    { key: 'file', value: { path, encoding: 'base64', content: bytesToB64(bytes) } },
  ]);
  const res = await hfFetch(`${BASE}/api/${type}s/${repo}/commit/main`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/x-ndjson' }),
    body,
  });
  return res.json().catch(() => ({}));
}

/** 批量删除文件，一次 commit 完成 */
export async function deletePaths({ token, repo, paths, summary, type = 'dataset' }) {
  if (!paths.length) return {};
  const lines = [{ key: 'header', value: { summary: summary || `delete ${paths.length} file(s)` } }];
  for (const p of paths) lines.push({ key: 'deletedFile', value: { path: p } });
  const res = await hfFetch(`${BASE}/api/${type}s/${repo}/commit/main`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/x-ndjson' }),
    body: ndjson(lines),
  });
  return res.json().catch(() => ({}));
}

/** 读取文件流，支持 Range */
export async function fetchFile({ token, repo, path, range, type = 'dataset' }) {
  const headers = authHeaders(token, { 'Accept-Encoding': 'identity' });
  if (range) headers.Range = range;
  const url = `${BASE}/${type}s/${repo}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await hfFetch(url, { headers }, { retries: 3 });
  return res;
}

/** 读取整个小文件为文本/字节 */
export async function fetchSmallFile({ token, repo, path, maxBytes = 2 * 1024 * 1024, type = 'dataset' }) {
  const res = await fetchFile({ token, repo, path, range: `bytes=0-${maxBytes - 1}`, type });
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** 检查仓库是否可写（写一个标记文件） */
export async function probeRepo({ token, repo, type = 'dataset' }) {
  const marker = new TextEncoder().encode(
    JSON.stringify({ app: 'hf-drive', checkedAt: new Date().toISOString() }, null, 2)
  );
  return commitBase64({ token, repo, path: '.hfd/repo.json', bytes: marker, summary: 'hf-drive: verify write access', type });
}
