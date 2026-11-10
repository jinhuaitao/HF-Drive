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

/** 文件自描述元数据（文件名/目录），用于灾难恢复时还原真实文件名 */
export function metaPath(nodeId) {
  return `meta/${nodeId}.json`;
}

async function sha256HexOf(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * git-lfs batch 接口：拿预签名上传地址。
 * HF 的 Xet 仓库也保留了这个「LFS 桥」，二进制内容必须走这条路，
 * 直接用 commit 内联 base64 会被拒绝：
 * "Your push was rejected because it contains binary files."
 */
export async function lfsBatch({ token, repo, objects, type = 'dataset', operation = 'upload' }) {
  const url = `${BASE}/${type}s/${repo}.git/info/lfs/objects/batch`;
  const res = await hfFetch(url, {
    method: 'POST',
    headers: authHeaders(token, {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
    }),
    body: JSON.stringify({ operation, transfers: ['basic'], objects, hash_algo: 'sha256' }),
  });
  return res.json().catch(() => ({}));
}

/**
 * 提交里引用已经上传好的 LFS 对象（commit 的 ndjson 用 lfsFile 这个 key）。
 * inlineFiles 可以顺带提交纯文本小文件（HF 允许 file / lfsFile 混在同一次 commit 里），
 * 用来把「文件名的自描述元数据」挂在分片提交上，零额外请求。
 */
export async function commitLfs({ token, repo, files, inlineFiles, summary, type = 'dataset' }) {
  const lines = [{ key: 'header', value: { summary: summary || `upload ${files.length} file(s)` } }];
  for (const f of inlineFiles || []) {
    lines.push({ key: 'file', value: { path: f.path, encoding: 'base64', content: bytesToB64(f.bytes) } });
  }
  for (const f of files) {
    lines.push({ key: 'lfsFile', value: { path: f.path, algo: 'sha256', oid: f.oid, size: f.size } });
  }
  const res = await hfFetch(`${BASE}/api/${type}s/${repo}/commit/main`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/x-ndjson' }),
    body: ndjson(lines),
  });
  return res.json().catch(() => ({}));
}

/**
 * 上传成功后如果 batch 给了 verify 动作，需要回调确认（标准 LFS 流程）。
 * HF 大多数情况不需要，但漏掉会让个别仓库的分片永远处于「未确认」状态。
 */
async function verifyObject(action, { oid, size }) {
  if (!action?.href) return;
  try {
    await fetch(action.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.git-lfs+json', ...(action.header || {}) },
      body: JSON.stringify({ oid, size }),
    });
  } catch {
    // verify 失败不阻塞：后续 commit 仍会校验对象存在性
  }
}

async function putObject(href, headers, bytes) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(href, { method: 'PUT', headers, body: bytes });
    } catch (err) {
      lastErr = new HFError(`上传到对象存储失败：${err?.message || err}`, 0);
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (res.ok) return;
    if (res.status >= 500 && attempt < 2) {
      try { await res.body?.cancel(); } catch {}
      await sleep(500 * (attempt + 1));
      continue;
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    throw new HFError(`上传到对象存储失败（HTTP ${res.status}）${detail ? '：' + detail : ''}`, res.status);
  }
  throw lastErr || new HFError('上传到对象存储失败', 0);
}

/**
 * 上传一个分片：算 sha256 → lfs batch → PUT 到预签名地址 → commit 引用。
 * 内容相同（服务端已有）时 batch 返回 actions 为 null，直接引用即可，天然去重。
 */
export async function uploadChunkLfs({ token, repo, path, bytes, summary, extraFiles, type = 'dataset' }) {
  const oid = await sha256HexOf(bytes);
  const size = bytes.byteLength;

  const batch = await lfsBatch({ token, repo, objects: [{ oid, size }], type });
  const obj = batch?.objects?.[0];
  if (!obj) {
    throw new HFError(`LFS batch 返回异常：${JSON.stringify(batch).slice(0, 200)}`, 502);
  }
  if (obj.error) {
    throw new HFError(`LFS 上传被拒绝：${obj.error.message || JSON.stringify(obj.error).slice(0, 200)}`, 400);
  }

  const action = obj.actions?.upload;
  if (action?.href) {
    await putObject(action.href, { ...(action.header || {}) }, bytes);
    await verifyObject(obj.actions?.verify, { oid, size });
  }
  await commitLfs({
    token,
    repo,
    files: [{ path, oid, size }],
    inlineFiles: extraFiles,
    summary: summary || `upload ${path}`,
    type,
  });
  return { oid, deduped: !action };
}

function ndjson(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * 用 commit 接口写一个或多个小文件（base64 内联）。适合 <= 10MB 的文本内容。
 * 注意：HF 的 Xet 仓库会拒收内联二进制，二进制请用 uploadChunkLfs。
 */
export async function commitInline({ token, repo, files, summary, type = 'dataset' }) {
  const lines = [{ key: 'header', value: { summary: summary || `upload ${files.length} file(s)` } }];
  for (const f of files) {
    lines.push({ key: 'file', value: { path: f.path, encoding: 'base64', content: bytesToB64(f.bytes) } });
  }
  const res = await hfFetch(`${BASE}/api/${type}s/${repo}/commit/main`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/x-ndjson' }),
    body: ndjson(lines),
  });
  return res.json().catch(() => ({}));
}

export async function commitBase64({ token, repo, path, bytes, summary, type = 'dataset' }) {
  return commitInline({ token, repo, files: [{ path, bytes }], summary: summary || `upload ${path}`, type });
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

/** 列出仓库某个目录下的条目（含 LFS 的 oid / 真实大小） */
export async function listTree({ token, repo, path, type = 'dataset' }) {
  const segs = path.split('/').map(encodeURIComponent).join('/');
  const res = await hfFetch(
    `${BASE}/api/${type}s/${repo}/tree/main/${segs}?limit=1000`,
    { headers: authHeaders(token) },
    { retries: 2 }
  );
  const list = await res.json().catch(() => []);
  return Array.isArray(list) ? list : [];
}

/**
 * 仓库内「秒复制」分片：不搬运字节，直接把已有 LFS 对象的 oid 提交到新路径。
 * LFS 按 oid 存一份，所以副本不额外占空间，也不消耗 Worker 的带宽/CPU。
 * 返回 false 表示拿不到完整 oid 列表，调用方需要退回「下载再上传」。
 */
export async function copyChunksInRepo({ token, repo, fromId, toId, chunks, name, type = 'dataset' }) {
  if (chunks <= 0) return true;
  let entries;
  try {
    entries = await listTree({ token, repo, path: `chunks/${fromId}`, type });
  } catch {
    return false;
  }
  const byIndex = new Map();
  for (const e of entries) {
    if (e?.type !== 'file' || !e.lfs?.oid) continue;
    const m = /^chunks\/[A-Za-z0-9_]+\/(\d{6})\.bin$/.exec(e.path || '');
    if (!m) continue;
    byIndex.set(parseInt(m[1], 10), { oid: e.lfs.oid, size: e.lfs.size ?? e.size ?? 0 });
  }
  if (byIndex.size < chunks) return false;

  const files = [];
  for (let i = 0; i < chunks; i++) {
    const hit = byIndex.get(i);
    if (!hit) return false;
    files.push({ path: chunkPath(toId, i), oid: hit.oid, size: hit.size });
  }
  await commitLfs({ token, repo, files, summary: `copy ${name || fromId}`, type });
  return true;
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

/** 检查仓库是否可写（写标记文件 + .gitattributes 声明 LFS 规则） */
export async function probeRepo({ token, repo, type = 'dataset' }) {
  const marker = new TextEncoder().encode(
    JSON.stringify({ app: 'hf-drive', checkedAt: new Date().toISOString() }, null, 2)
  );
  // .gitattributes 让仓库明确把 *.bin 交给 LFS 处理，
  // 万一有客户端用 git 直推，也不会被 Xet 的「二进制拦截」拒绝。
  const attrs = new TextEncoder().encode('*.bin filter=lfs diff=lfs merge=lfs -text\n');
  return commitInline({
    token,
    repo,
    files: [
      { path: '.gitattributes', bytes: attrs },
      { path: '.hfd/repo.json', bytes: marker },
    ],
    summary: 'hf-drive: verify write access',
    type,
  });
}
