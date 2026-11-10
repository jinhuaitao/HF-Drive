// HF Drive —— API 路由层
import * as U from './lib/util.js';
import {
  readConfig, writeConfig, hashPassword, verifyPassword, createSession, sessionCookie, clearSessionCookie,
  getAuth, destroySession, checkThrottle, recordFailure, clearFailures, shareUnlockValue, shareCookieName,
  SESSION_COOKIE,
} from './lib/auth.js';
import {
  getJSON, putJSON, deleteKeys, mutateIndex, readIndex, mutateShares, readShares,
  getNode, childrenOf, subtreeIds, isDescendant, pathOf, uniqueName, usedBytes, publicNode,
  indexState,
  KEY_INDEX, KEY_UPLOAD, KEY_SESSION, KEY_SHARES,
} from './lib/store.js';
import * as HF from './lib/hf.js';
import { buildZipStream, zipHeaders } from './lib/zip.js';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB / 分片
const MAX_UPLOAD = 50 * 1024 * 1024 * 1024; // 50GB
const MAX_ZIP = 3.6 * 1024 * 1024 * 1024; // ZIP 上限（未做 zip64）
const VERSION = '1.1.2';

const json = U.json;
const fail = U.fail;
const enc = new TextEncoder();

// ---------------------------------------------------------------- 索引快照（灾难恢复）

const BACKUP_PATH = '_backup/index.json.gz';
const BACKUP_INTERVAL = 60 * 1000;
let lastBackupAt = 0;

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 把索引压成 gzip 存进 HF 仓库。
 * R2 是唯一的元数据来源，丢了就只剩「恢复的文件 xxxxxx」；
 * 有了这份快照，重建索引能 100% 还原文件名、目录结构、收藏状态。
 */
async function backupIndex(env) {
  const config = await readConfig(env);
  if (!config?.hf?.token || !config?.hf?.repo) return;
  const index = await readIndex(env);
  const count = Object.keys(index.nodes).length;
  if (!count) return;
  const raw = enc.encode(JSON.stringify({ v: 1, savedAt: Date.now(), nodes: index.nodes }));
  const gz = await gzipBytes(raw);
  await HF.uploadChunkLfs({
    token: config.hf.token,
    repo: config.hf.repo,
    path: BACKUP_PATH,
    bytes: gz,
    summary: `hf-drive: index snapshot (${count} nodes)`,
  });
}

/** 请求结束后按节流把快照刷出去；不阻塞响应 */
function scheduleIndexBackup(env, execCtx) {
  if (!indexState.dirty) return;
  const now = Date.now();
  if (now - lastBackupAt < BACKUP_INTERVAL) return;
  lastBackupAt = now;
  indexState.dirty = false;
  const task = backupIndex(env).catch((err) => {
    console.warn('索引快照失败:', err?.message || err);
  });
  if (execCtx?.waitUntil) execCtx.waitUntil(task);
}

/** 手动触发一次快照（测试 / 设置页「立即备份」用） */
export async function flushIndexBackup(env) {
  indexState.dirty = false;
  lastBackupAt = Date.now();
  await backupIndex(env);
}

// ---------------------------------------------------------------- 入口

export async function handleApi(request, env, execCtx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  if (!env.BUCKET) {
    return fail(500, 'no_bucket', '缺少 R2 绑定 BUCKET，请检查 wrangler.jsonc 或重新部署');
  }

  try {
    const res = await route(request, env, url, path, method);
    // 索引有变更就顺带把快照刷到 HF 仓库（节流 + 异步，不拖慢本次响应）
    scheduleIndexBackup(env, execCtx);
    return res;
  } catch (err) {
    if (err instanceof HF.HFError) {
      return fail(err.status === 401 ? 401 : 502, 'hf_error', err.message);
    }
    if (err?.status && err.status < 600) {
      return fail(err.status, err.code || 'error', String(err.message || '请求失败'));
    }
    console.error('API 异常:', path, err?.stack || err);
    return fail(500, 'internal_error', String(err?.message || err));
  }
}

async function route(request, env, url, path, method) {
  // ---------------- 公开路由 ----------------
  if (path === '/api/state' && method === 'GET') return apiState(request, env);
  if (path === '/api/setup' && method === 'POST') return apiSetup(request, env);
  if (path === '/api/login' && method === 'POST') return apiLogin(request, env);
  if (path === '/api/logout' && method === 'POST') return apiLogout(request, env);

  const publicShare = /^\/api\/public\/share\/([a-f0-9]{6,64})(?:\/(.+))?$/.exec(path);
  if (publicShare) return apiPublicShare(request, env, publicShare[1], publicShare[2] || '', method);

  // ---------------- 需要登录 ----------------
  const auth = await getAuth(env, request);
  if (!auth) return fail(401, 'unauthorized', '登录状态已失效，请重新登录');
  const config = await readConfig(env);
  if (!config) return fail(409, 'not_setup', '尚未完成初始化');
  const ctx = { env, config, auth, request, url };

  if (path === '/api/files' && method === 'GET') return apiList(ctx);
  if (path === '/api/folders' && method === 'POST') return apiCreateFolder(ctx);
  if (path === '/api/upload/init' && method === 'POST') return apiUploadInit(ctx);
  if (path === '/api/upload/chunk' && method === 'PUT') return apiUploadChunk(ctx);
  if (path === '/api/upload/complete' && method === 'POST') return apiUploadComplete(ctx);
  if (path === '/api/upload/abort' && method === 'POST') return apiUploadAbort(ctx);
  if (path === '/api/nodes/delete' && method === 'POST') return apiTrashNodes(ctx);
  if (path === '/api/nodes/restore' && method === 'POST') return apiRestoreNodes(ctx);
  if (path === '/api/nodes/purge' && method === 'POST') return apiPurgeNodes(ctx);
  if (path === '/api/nodes/copy' && method === 'POST') return apiCopyNodes(ctx);
  if (path === '/api/trash/empty' && method === 'POST') return apiEmptyTrash(ctx);
  if (path === '/api/zip' && method === 'GET') return apiZip(ctx);
  if (path === '/api/shares' && method === 'GET') return apiListShares(ctx);
  if (path === '/api/shares' && method === 'POST') return apiCreateShare(ctx);
  if (path === '/api/stats' && method === 'GET') return apiStats(ctx);
  if (path === '/api/settings/password' && method === 'POST') return apiChangePassword(ctx);
  if (path === '/api/settings/account' && method === 'POST') return apiChangeAccount(ctx);
  if (path === '/api/settings/storage' && method === 'POST') return apiChangeStorage(ctx);
  if (path === '/api/settings/rebuild' && method === 'POST') return apiRebuild(ctx);
  if (path === '/api/settings/backup' && method === 'POST') return apiBackupNow(ctx);

  let m;
  if ((m = /^\/api\/nodes\/([A-Za-z0-9_]+)$/.exec(path)) && method === 'PATCH') return apiPatchNode(ctx, m[1]);
  if ((m = /^\/api\/file\/([A-Za-z0-9_]+)$/.exec(path)) && method === 'GET') return apiFileStream(ctx, m[1]);
  if ((m = /^\/api\/shares\/([a-zA-Z0-9]+)$/.exec(path)) && method === 'DELETE') return apiDeleteShare(ctx, m[1]);
  if ((m = /^\/api\/shares\/([a-zA-Z0-9]+)$/.exec(path)) && method === 'PATCH') return apiUpdateShare(ctx, m[1]);

  return fail(404, 'not_found', `未知接口 ${method} ${path}`);
}

// ---------------------------------------------------------------- 基础

async function bodyJSON(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== 'object') return {};
    return data;
  } catch {
    return {};
  }
}

function str(v, max = 500) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function hfCfg(config) {
  if (!config?.hf?.token || !config?.hf?.repo) {
    const err = new Error('尚未绑定 HuggingFace 存储，请到「设置」里完成绑定');
    err.status = 409;
    throw err;
  }
  return config.hf;
}

function requireFolder(index, id) {
  if (!id || id === 'root') return 'root';
  const node = index.nodes[id];
  if (!node || node.type !== 'folder') return null;
  return id;
}

function visibleSet(index) {
  // 从 root 出发、父链未被移入回收站的节点
  const visible = new Set(['root']);
  const queue = ['root'];
  const byParent = new Map();
  for (const node of Object.values(index.nodes)) {
    if (node.trashedAt) continue;
    if (!byParent.has(node.parent)) byParent.set(node.parent, []);
    byParent.get(node.parent).push(node);
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const node of byParent.get(cur) || []) {
      visible.add(node.id);
      if (node.type === 'folder') queue.push(node.id);
    }
  }
  return visible;
}

function pathString(index, id) {
  return '/' + pathOf(index, id).join('/');
}

/**
 * 文件的自描述元数据：跟分片一起提交到 HF 仓库的 meta/<id>.json。
 * 这样即使 R2 全丢，重建索引也能恢复真实文件名和目录结构，
 * 而不是一堆「恢复的文件 xxxxxx」。
 */
function buildFileMeta({ id, name, parentPath, mime, size, createdAt }) {
  return {
    v: 1,
    id,
    name,
    type: 'file',
    parentPath: parentPath || '/',
    mime: mime || '',
    size: size || 0,
    createdAt: createdAt || Date.now(),
  };
}

function metaFileOf(meta) {
  return { path: HF.metaPath(meta.id), bytes: enc.encode(JSON.stringify(meta)) };
}

/** 把某个文件的元数据写回 HF 仓库（失败不阻塞主流程） */
async function syncFileMeta(env, config, index, id) {
  const node = getNode(index, id);
  if (!node || node.type !== 'file') return;
  if (!config?.hf?.token) return;
  const parentPath = node.parent && node.parent !== 'root' ? pathString(index, node.parent) : '/';
  const meta = buildFileMeta({
    id,
    name: node.name,
    parentPath,
    mime: node.mime,
    size: node.size,
    createdAt: node.createdAt,
  });
  const f = metaFileOf(meta);
  await HF.commitInline({
    token: config.hf.token,
    repo: config.hf.repo,
    files: [f],
    summary: `hf-drive: meta ${node.name}`,
  });
}

function ancestorsOf(index, id) {
  const out = [];
  let cur = getNode(index, id);
  let guard = 0;
  while (cur && guard++ < 500) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = getNode(index, cur.parent);
  }
  return out;
}

function statsOf(index) {
  let used = 0;
  let trash = 0;
  let files = 0;
  let folders = 0;
  const visible = visibleSet(index);
  for (const node of Object.values(index.nodes)) {
    if (node.type === 'file') {
      if (node.trashedAt || !visible.has(node.id)) trash += node.size || 0;
      else {
        used += node.size || 0;
        files++;
      }
    } else if (visible.has(node.id)) folders++;
  }
  return { used, trash, files, folders, total: used + trash };
}

// ---------------------------------------------------------------- 状态 / 初始化

async function apiState(request, env) {
  const config = await readConfig(env);
  if (!config) {
    return json({ needsSetup: true, authed: false, version: VERSION, chunkSize: CHUNK_SIZE });
  }
  const auth = await getAuth(env, request);
  return json({
    needsSetup: false,
    authed: Boolean(auth),
    user: auth ? config.username : null,
    version: VERSION,
    chunkSize: CHUNK_SIZE,
    storage: auth
      ? { repo: config.hf?.repo || null, owner: config.hf?.owner || null, boundAt: config.hf?.boundAt || null }
      : null,
  });
}

async function apiSetup(request, env) {
  const existing = await readConfig(env);
  if (existing) return fail(409, 'already_setup', '系统已初始化，请直接登录');

  const body = await bodyJSON(request);
  const username = str(body.username, 40).trim();
  const password = String(body.password || '');
  const token = str(body.hfToken, 200).trim();
  const repoName = str(body.repoName, 80).trim() || 'hf-drive-storage';

  if (!username || username.length < 2) return fail(400, 'bad_username', '用户名至少 2 个字符');
  if (password.length < 8) return fail(400, 'weak_password', '密码至少 8 位');
  if (!/^hf_[A-Za-z0-9]{10,}$/.test(token)) return fail(400, 'bad_token', 'HuggingFace Token 格式不正确（应以 hf_ 开头）');
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(repoName)) return fail(400, 'bad_repo', '仓库名只能包含字母、数字、点、下划线、短横线');

  let who;
  try {
    who = await HF.whoami(token);
  } catch (err) {
    return fail(400, 'bad_token', `Token 校验失败：${err.message}`);
  }
  const owner = who?.name;
  if (!owner) return fail(400, 'bad_token', 'Token 无效：无法获取账号信息');

  const repo = `${owner}/${repoName}`;
  try {
    await HF.createRepo({ token, name: repoName, private: true });
    await HF.probeRepo({ token, repo });
  } catch (err) {
    return fail(400, 'repo_failed', `创建/写入私有仓库失败：${err.message}`);
  }

  const { salt, hash, iterations } = await hashPassword(password);
  const config = {
    v: 1,
    username,
    salt,
    hash,
    iterations,
    secret: U.randomToken(32),
    chunkSize: CHUNK_SIZE,
    hf: { token, repo, owner, repoName, private: true, boundAt: Date.now() },
    createdAt: Date.now(),
  };
  await writeConfig(env, config);

  const { token: session } = await createSession(env, request, username);
  return json(
    { ok: true, user: username, storage: { repo, owner } },
    200,
    { 'Set-Cookie': sessionCookie(session) }
  );
}

async function apiLogin(request, env) {
  const config = await readConfig(env);
  if (!config) return fail(409, 'not_setup', '系统尚未初始化');

  const throttle = await checkThrottle(env, request);
  if (throttle.blocked) {
    return json(
      { error: 'too_many_attempts', message: `尝试过于频繁，请 ${Math.ceil(throttle.retryAfter / 60)} 分钟后再试` },
      429,
      { 'Retry-After': String(throttle.retryAfter) }
    );
  }

  const body = await bodyJSON(request);
  const username = str(body.username, 40).trim();
  const password = String(body.password || '');
  if (!username || !password) return fail(400, 'bad_request', '请输入用户名和密码');

  if (username !== config.username) {
    await recordFailure(env, request);
    return fail(401, 'bad_credentials', '用户名或密码错误');
  }
  const ok = await verifyPassword(config, password);
  if (!ok) {
    await recordFailure(env, request);
    return fail(401, 'bad_credentials', '用户名或密码错误');
  }

  await clearFailures(env, request);
  const { token } = await createSession(env, request, username);
  return json({ ok: true, user: username }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function apiLogout(request, env) {
  const auth = await getAuth(env, request);
  if (auth) await destroySession(env, auth.token);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

// ---------------------------------------------------------------- 列表 / 搜索

async function apiList(ctx) {
  const { url } = ctx;
  const view = str(url.searchParams.get('view') || 'files', 20);
  const parent = url.searchParams.get('parent') || 'root';
  const q = str(url.searchParams.get('q') || '', 100).trim();
  const index = await readIndex(ctx.env);
  const stats = statsOf(index);

  if (q) {
    const visible = visibleSet(index);
    const needle = q.toLowerCase();
    const items = [];
    for (const node of Object.values(index.nodes)) {
      if (!visible.has(node.id) || node.trashedAt) continue;
      if (!node.name.toLowerCase().includes(needle)) continue;
      items.push({ ...publicNode(node), path: pathString(index, node.parent) });
      if (items.length >= 800) break;
    }
    items.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return json({ view: 'search', q, items, breadcrumb: [], stats, parent: null });
  }

  if (view === 'trash') {
    const items = [];
    for (const node of Object.values(index.nodes)) {
      if (!node.trashedAt) continue;
      const parentNode = getNode(index, node.parent);
      if (parentNode && parentNode.trashedAt) continue; // 子项跟着父项一起隐藏
      items.push({
        ...publicNode(node),
        path: parentNode ? pathString(index, node.parent) : '/',
        size: node.type === 'folder' ? folderSize(index, node.id) : node.size,
      });
    }
    items.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
    return json({ view: 'trash', items, breadcrumb: [{ id: 'trash', name: '回收站' }], stats, parent: null });
  }

  if (view === 'starred') {
    const visible = visibleSet(index);
    const items = [];
    for (const node of Object.values(index.nodes)) {
      if (!node.starred || node.trashedAt || !visible.has(node.id)) continue;
      items.push({ ...publicNode(node), path: pathString(index, node.parent) });
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return json({ view: 'starred', items, breadcrumb: [{ id: 'starred', name: '收藏' }], stats, parent: null });
  }

  const folderId = requireFolder(index, parent);
  if (!folderId) return fail(404, 'no_folder', '文件夹不存在或已被删除');
  const node = getNode(index, folderId);
  if (node?.trashedAt) return fail(404, 'no_folder', '文件夹已在回收站中');

  const items = childrenOf(index, folderId).map((n) => publicNode(n));
  const breadcrumb = [{ id: 'root', name: '全部文件' }, ...ancestorsOf(index, folderId)];
  return json({
    view: 'files',
    parent: folderId,
    folder: node ? publicNode(node) : null,
    breadcrumb,
    items,
    stats,
  });
}

function folderSize(index, id) {
  let total = 0;
  for (const node of Object.values(index.nodes)) {
    if (node.type !== 'file' || node.trashedAt) continue;
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 500) {
      if (cur.parent === id) {
        total += node.size || 0;
        break;
      }
      cur = getNode(index, cur.parent);
    }
  }
  return total;
}

// ---------------------------------------------------------------- 文件夹 / 重命名 / 移动

async function apiCreateFolder(ctx) {
  const body = await bodyJSON(ctx.request);
  const name = U.sanitizeName(str(body.name, 200), '新建文件夹');
  if (!name) return fail(400, 'bad_name', '文件夹名不能为空');

  const node = await mutateIndex(ctx.env, (index) => {
    const parent = requireFolder(index, str(body.parent, 40) || 'root');
    if (!parent) {
      const err = new Error('目标文件夹不存在');
      err.status = 404;
      throw err;
    }
    if (body.reuse) {
      const existing = childrenOf(index, parent).find(
        (n) => n.type === 'folder' && n.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) return publicNode(existing);
    }
    const now = Date.now();
    const folder = {
      id: U.uid('d_'),
      parent,
      type: 'folder',
      name: uniqueName(index, parent, name),
      size: 0,
      mime: '',
      createdAt: now,
      updatedAt: now,
      starred: false,
      trashedAt: null,
      trashParent: null,
    };
    index.nodes[folder.id] = folder;
    return publicNode(folder);
  });
  return json({ ok: true, node });
}

async function apiPatchNode(ctx, id) {
  const body = await bodyJSON(ctx.request);
  const result = await mutateIndex(ctx.env, (index) => {
    const node = getNode(index, id);
    if (!node) {
      const err = new Error('文件不存在');
      err.status = 404;
      throw err;
    }
    if (typeof body.name === 'string') {
      const name = U.sanitizeName(str(body.name, 200));
      if (!name) {
        const err = new Error('名称不能为空');
        err.status = 400;
        throw err;
      }
      node.name = uniqueName(index, node.parent, name, node.id);
      node.updatedAt = Date.now();
    }
    if (typeof body.parent === 'string' && body.parent !== node.parent) {
      const target = requireFolder(index, body.parent);
      if (!target) {
        const err = new Error('目标文件夹不存在');
        err.status = 404;
        throw err;
      }
      if (node.type === 'folder' && (target === node.id || isDescendant(index, target, node.id))) {
        const err = new Error('不能移动到自身或其子文件夹中');
        err.status = 400;
        throw err;
      }
      node.parent = target;
      node.name = uniqueName(index, target, node.name, node.id);
      node.updatedAt = Date.now();
    }
    if (typeof body.starred === 'boolean') node.starred = body.starred;
    return publicNode(node);
  });

  // 改名 / 移动后同步 HF 里的自描述元数据，保证灾难恢复时拿到的是新名字
  if (typeof body.name === 'string' || typeof body.parent === 'string') {
    try {
      const index = await readIndex(ctx.env);
      await syncFileMeta(ctx.env, ctx.config, index, id);
    } catch {
      // 同步失败不影响重命名本身
    }
  }
  return json({ ok: true, node: result });
}

// ---------------------------------------------------------------- 上传

async function apiUploadInit(ctx) {
  const body = await bodyJSON(ctx.request);
  const index = await readIndex(ctx.env);
  const parent = requireFolder(index, str(body.parent, 40) || 'root');
  if (!parent) return fail(404, 'no_folder', '目标文件夹不存在');

  const rawName = str(body.name, 300);
  const name = U.sanitizeName(rawName, '未命名文件');
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) return fail(400, 'bad_size', '文件大小不合法');
  if (size > MAX_UPLOAD) return fail(413, 'too_large', '单文件超过 50GB 上限');

  const chunks = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
  const resumeId = str(body.resume, 40);

  // 续传：直接复用上一次的上传记录
  if (resumeId) {
    const meta = await getJSON(ctx.env, `${KEY_UPLOAD(resumeId).replace(/\.json$/, '')}/_meta.json`);
    if (meta?.value && meta.value.size === size && meta.value.name === name) {
      const received = await listChunkIndexes(ctx.env, resumeId);
      return json({
        ok: true,
        uploadId: resumeId,
        chunkSize: meta.value.chunkSize,
        chunks: meta.value.chunks,
        received,
        resumed: true,
      });
    }
  }

  const id = U.uid('f_');
  const record = {
    id,
    name,
    size,
    mime: str(body.mime, 150) || U.mimeOf(name),
    parent,
    chunks,
    chunkSize: CHUNK_SIZE,
    createdAt: Date.now(),
  };
  await putJSON(ctx.env, uploadMetaKey(id), record);
  return json({ ok: true, uploadId: id, chunkSize: CHUNK_SIZE, chunks, received: [] });
}

function uploadMetaKey(id) {
  return `sys/uploads/${id}/_meta.json`;
}

function uploadChunkKey(id, index) {
  return `sys/uploads/${id}/${String(index).padStart(6, '0')}.json`;
}

async function listChunkIndexes(env, id) {
  const out = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const listed = await env.BUCKET.list({ prefix: `sys/uploads/${id}/`, cursor, limit: 1000 });
    for (const obj of listed.objects || []) {
      const m = /(\d{6})\.json$/.exec(obj.key);
      if (m) out.push(parseInt(m[1], 10));
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return out.sort((a, b) => a - b);
}

async function apiUploadChunk(ctx) {
  const id = str(ctx.url.searchParams.get('uploadId'), 40);
  const indexNum = parseInt(ctx.url.searchParams.get('index') || '', 10);
  if (!id || !Number.isInteger(indexNum) || indexNum < 0) return fail(400, 'bad_request', '参数不完整');

  const meta = await getJSON(ctx.env, uploadMetaKey(id));
  if (!meta?.value) return fail(404, 'no_upload', '上传会话已过期，请重新上传');
  const rec = meta.value;
  if (indexNum >= Math.max(rec.chunks, 1)) return fail(400, 'bad_index', '分片序号超出范围');

  const buf = await ctx.request.arrayBuffer();
  const expected = indexNum === rec.chunks - 1 ? rec.size - indexNum * rec.chunkSize : rec.chunkSize;
  if (buf.byteLength > rec.chunkSize) return fail(413, 'chunk_too_large', '分片过大');
  if (buf.byteLength !== expected && !(rec.size === 0 && buf.byteLength === 0)) {
    return fail(400, 'bad_chunk', `分片大小不符（期望 ${expected}，实际 ${buf.byteLength}）`);
  }

  const hf = hfCfg(ctx.config);
  const bytes = new Uint8Array(buf);
  const summary = `upload ${id} part ${indexNum + 1}/${rec.chunks}`;

  // 第一个分片顺带把「文件是谁」一起提交：零额外请求，
  // 但换来的是 R2 丢了之后还能恢复真实文件名和目录。
  let extraFiles;
  if (indexNum === 0) {
    const index = await readIndex(ctx.env);
    const parentPath = rec.parent && rec.parent !== 'root' ? pathString(index, rec.parent) : '/';
    const meta = buildFileMeta({
      id,
      name: rec.name,
      parentPath,
      mime: rec.mime,
      size: rec.size,
      createdAt: Date.now(),
    });
    extraFiles = [metaFileOf(meta)];
  }

  try {
    // 二进制内容必须走 git-lfs（HF 的 Xet 仓库拒收内联二进制 blob）
    await HF.uploadChunkLfs({
      token: hf.token,
      repo: hf.repo,
      path: HF.chunkPath(id, indexNum),
      bytes,
      summary,
      extraFiles,
    });
  } catch (err) {
    // 仓库不支持 LFS 时退回内联 base64（仅对文本内容有效）
    if (err?.status === 404 || err?.status === 405) {
      await HF.commitBase64({ token: hf.token, repo: hf.repo, path: HF.chunkPath(id, indexNum), bytes, summary });
    } else {
      throw err;
    }
  }
  await putJSON(ctx.env, uploadChunkKey(id, indexNum), { ok: true, size: buf.byteLength, at: Date.now() });
  return json({ ok: true, index: indexNum });
}

async function apiUploadComplete(ctx) {
  const body = await bodyJSON(ctx.request);
  const id = str(body.uploadId, 40);
  if (!id) return fail(400, 'bad_request', '缺少 uploadId');

  const meta = await getJSON(ctx.env, uploadMetaKey(id));
  if (!meta?.value) return fail(404, 'no_upload', '上传会话已过期，请重新上传');
  const rec = meta.value;

  const received = await listChunkIndexes(ctx.env, id);
  if (rec.chunks > 0 && received.length < rec.chunks) {
    return json({ error: 'incomplete', message: `还有 ${rec.chunks - received.length} 个分片未上传`, received }, 409);
  }

  const node = await mutateIndex(ctx.env, (index) => {
    let parent = requireFolder(index, rec.parent);
    if (!parent) parent = 'root';
    const now = Date.now();
    const item = {
      id,
      parent,
      type: 'file',
      name: uniqueName(index, parent, rec.name),
      size: rec.size,
      mime: rec.mime,
      chunks: rec.chunks,
      chunkSize: rec.chunkSize,
      createdAt: now,
      updatedAt: now,
      starred: false,
      trashedAt: null,
      trashParent: null,
    };
    index.nodes[id] = item;
    return publicNode(item);
  });

  await cleanupUpload(ctx.env, id);
  return json({ ok: true, node });
}

async function cleanupUpload(env, id) {
  const keys = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const listed = await env.BUCKET.list({ prefix: `sys/uploads/${id}/`, cursor, limit: 1000 });
    for (const obj of listed.objects || []) keys.push(obj.key);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  if (keys.length) await deleteKeys(env, keys);
}

async function apiUploadAbort(ctx) {
  const body = await bodyJSON(ctx.request);
  const id = str(body.uploadId, 40);
  if (!id) return fail(400, 'bad_request', '缺少 uploadId');
  await cleanupUpload(ctx.env, id);
  return json({ ok: true });
}

// ---------------------------------------------------------------- 回收站 / 删除 / 复制

async function apiTrashNodes(ctx) {
  const body = await bodyJSON(ctx.request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return fail(400, 'bad_request', '未选择文件');
  const count = await mutateIndex(ctx.env, (index) => {
    const now = Date.now();
    let n = 0;
    for (const id of ids) {
      const node = index.nodes[id];
      if (!node || node.trashedAt) continue;
      node.trashedAt = now;
      node.trashParent = node.parent;
      node.updatedAt = now;
      n++;
    }
    return n;
  });
  return json({ ok: true, count });
}

async function apiRestoreNodes(ctx) {
  const body = await bodyJSON(ctx.request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return fail(400, 'bad_request', '未选择文件');
  const count = await mutateIndex(ctx.env, (index) => {
    let n = 0;
    for (const id of ids) {
      const node = index.nodes[id];
      if (!node || !node.trashedAt) continue;
      const parentNode = getNode(index, node.parent);
      const targetOk = parentNode && !parentNode.trashedAt;
      if (!targetOk) node.parent = 'root';
      node.trashedAt = null;
      node.trashParent = null;
      node.name = uniqueName(index, node.parent, node.name, node.id);
      node.updatedAt = Date.now();
      n++;
    }
    return n;
  });
  return json({ ok: true, count });
}

async function apiPurgeNodes(ctx) {
  const body = await bodyJSON(ctx.request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return fail(400, 'bad_request', '未选择文件');
  const removed = await purgeMany(ctx, ids, { onlyTrashed: true });
  return json({ ok: true, removed });
}

async function apiEmptyTrash(ctx) {
  const index = await readIndex(ctx.env);
  const roots = Object.values(index.nodes)
    .filter((n) => n.trashedAt && !(getNode(index, n.parent)?.trashedAt))
    .map((n) => n.id);
  const removed = await purgeMany(ctx, roots, { onlyTrashed: false });
  return json({ ok: true, removed });
}

async function purgeMany(ctx, ids, { onlyTrashed }) {
  const index = await readIndex(ctx.env);
  const all = new Set();
  for (const id of ids) {
    const node = index.nodes[id];
    if (!node) continue;
    if (onlyTrashed && !node.trashedAt) continue;
    // 整棵子树一起删（回收站里的文件夹，其子项 trashedAt 为 null）
    for (const sub of subtreeIds(index, id, { includeTrash: true })) all.add(sub);
  }

  const hf = ctx.config.hf;
  const chunkPaths = [];
  for (const id of all) {
    const node = index.nodes[id];
    if (node?.type === 'file' && node.chunks > 0) {
      for (let i = 0; i < node.chunks; i++) chunkPaths.push(HF.chunkPath(id, i));
      chunkPaths.push(HF.metaPath(id)); // 元数据跟着分片一起删，一次 commit 搞定
    }
  }
  if (hf && chunkPaths.length) {
    for (let i = 0; i < chunkPaths.length; i += 200) {
      await HF.deletePaths({
        token: hf.token,
        repo: hf.repo,
        paths: chunkPaths.slice(i, i + 200),
        summary: `hf-drive: 永久删除 ${Math.min(200, chunkPaths.length - i)} 个分片`,
      });
    }
  }

  await mutateIndex(ctx.env, (idx) => {
    for (const id of all) delete idx.nodes[id];
    return null;
  });

  // 清理指向这些文件的分享链接
  if (all.size) {
    await mutateShares(ctx.env, (shares) => {
      for (const [token, share] of Object.entries(shares.shares)) {
        if (all.has(share.nodeId)) delete shares.shares[token];
      }
    });
  }
  return all.size;
}

async function apiCopyNodes(ctx) {
  const body = await bodyJSON(ctx.request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 50) : [];
  const target = str(body.parent, 40) || 'root';
  if (!ids.length) return fail(400, 'bad_request', '未选择文件');

  const index = await readIndex(ctx.env);
  if (!requireFolder(index, target)) return fail(404, 'no_folder', '目标文件夹不存在');
  const hf = hfCfg(ctx.config);

  // 先计算需要复制的内容总量，兜底路径（真搬字节）用它做体积保护
  let totalBytes = 0;
  const plan = [];
  for (const id of ids) {
    const node = index.nodes[id];
    if (!node) continue;
    if (node.type === 'folder' && (target === id || isDescendant(index, target, id))) {
      return fail(400, 'bad_target', '不能复制到自身或其子文件夹中');
    }
    for (const sub of subtreeIds(index, id)) {
      const n = index.nodes[sub];
      if (!n || n.trashedAt) continue;
      plan.push({ node: n, topId: id });
      if (n.type === 'file') totalBytes += n.size || 0;
    }
  }

  // 复制分片
  const idMap = new Map();
  for (const { node } of plan) idMap.set(node.id, U.uid(node.type === 'folder' ? 'd_' : 'f_'));

  // 第一轮：优先「同仓库秒复制」——只提交引用，不搬字节
  const needFallback = [];
  for (const { node } of plan) {
    if (node.type !== 'file' || !(node.chunks > 0)) continue;
    let done = false;
    try {
      done = await HF.copyChunksInRepo({
        token: hf.token,
        repo: hf.repo,
        fromId: node.id,
        toId: idMap.get(node.id),
        chunks: node.chunks,
        name: node.name,
      });
    } catch {
      done = false;
    }
    if (!done) needFallback.push(node);
  }

  // 第二轮：秒复制拿不到 oid 的，才真正下载再上传（此时才需要体积保护）
  if (needFallback.length) {
    if (totalBytes > 2 * 1024 * 1024 * 1024) {
      return fail(413, 'too_large', '单次复制内容超过 2GB，请分批操作');
    }
    for (const node of needFallback) {
      const newId = idMap.get(node.id);
      for (let i = 0; i < node.chunks; i++) {
        const res = await HF.fetchFile({ token: hf.token, repo: hf.repo, path: HF.chunkPath(node.id, i) });
        if (!res.ok) throw new Error(`读取源分片失败（${node.name} #${i}）`);
        const buf = new Uint8Array(await res.arrayBuffer());
        await HF.uploadChunkLfs({
          token: hf.token,
          repo: hf.repo,
          path: HF.chunkPath(newId, i),
          bytes: buf,
          summary: `copy ${node.name} part ${i + 1}/${node.chunks}`,
        });
      }
    }
  }

  const created = plan.map(({ node }) => ({ newId: idMap.get(node.id), node }));

  const newNodes = await mutateIndex(ctx.env, (idx) => {
    const out = [];
    const now = Date.now();
    const parentOf = (node) => (ids.includes(node.id) ? target : idMap.get(node.parent) || target);
    for (const { newId, node } of created) {
      const copy = {
        ...node,
        id: newId,
        parent: parentOf(node),
        name: uniqueName(idx, parentOf(node), node.name),
        createdAt: now,
        updatedAt: now,
        starred: false,
        trashedAt: null,
        trashParent: null,
      };
      idx.nodes[newId] = copy;
      out.push(publicNode(copy));
    }
    return out;
  });

  return json({ ok: true, nodes: newNodes });
}

// ---------------------------------------------------------------- 下载

async function* readNode(ctx, node, rangeHeader, { maxBytes, prefetch = 2 } = {}) {
  const hf = hfCfg(ctx.config);
  const chunkSize = node.chunkSize || CHUNK_SIZE;
  const total = node.size || 0;
  if (total === 0 || !node.chunks) return;

  let start = 0;
  let end = total - 1;
  if (maxBytes && total > maxBytes) end = Math.min(end, maxBytes - 1);
  if (rangeHeader) {
    const r = U.parseRange(rangeHeader, total);
    if (r && !r.invalid) {
      start = r.start;
      end = r.end;
    }
  }
  if (start > end) return;

  const first = Math.floor(start / chunkSize);
  const last = Math.floor(end / chunkSize);

  // 预取：在消费当前分片的同时把下一片的分片请求发出去，
  // 把「串行等 RTT」变成流水线，大文件下载能明显加速。
  const pending = new Map();
  const begin = (i) => {
    if (i < first || i > last || pending.has(i)) return;
    const chunkStart = i * chunkSize;
    const chunkEnd = Math.min(total, chunkStart + chunkSize) - 1;
    const s = Math.max(start, chunkStart);
    const e = Math.min(end, chunkEnd);
    const p = HF.fetchFile({
      token: hf.token,
      repo: hf.repo,
      path: HF.chunkPath(node.id, i),
      range: `bytes=${s - chunkStart}-${e - chunkStart}`,
    }).catch((err) => ({ __error: err }));
    pending.set(i, p);
  };

  try {
    for (let i = first; i <= last; i++) {
      for (let k = 0; k < prefetch; k++) begin(i + k);
      const res = await pending.get(i);
      pending.delete(i);
      if (!res || res.__error) throw res?.__error || new Error(`读取分片 ${i} 失败`);
      if (!res.ok || !res.body) throw new Error(`读取分片 ${i} 失败（HTTP ${res.status}）`);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) yield value;
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    }
  } finally {
    // 客户端中途断开时，取消还没消费的预取请求
    for (const p of pending.values()) {
      p.then((r) => { try { r?.body?.cancel(); } catch {} }).catch(() => {});
    }
    pending.clear();
  }
}

async function apiFileStream(ctx, id) {
  const index = await readIndex(ctx.env);
  const node = getNode(index, id);
  if (!node || node.type !== 'file') return fail(404, 'not_found', '文件不存在');

  const inline = ctx.url.searchParams.get('inline') === '1';
  const maxParam = parseInt(ctx.url.searchParams.get('max') || '', 10);
  const maxBytes = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined;
  const mime = node.mime || U.mimeOf(node.name);
  const rangeHeader = ctx.request.headers.get('Range');

  const total = node.size || 0;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    // 文件按 ID 存放，内容永不变化 → 允许浏览器缓存，避免列表滚动/重渲染时反复下载缩略图
    'Cache-Control': inline ? 'private, max-age=86400' : 'private, max-age=0, must-revalidate',
    'Content-Disposition': U.contentDisposition(node.name, inline),
  };

  if (maxBytes && total > maxBytes) {
    headers['Content-Length'] = String(maxBytes);
    headers['Content-Range'] = `bytes 0-${maxBytes - 1}/${total}`;
    return U.streamResponse(readNode(ctx, node, null, { maxBytes }), headers, 206);
  }

  if (rangeHeader) {
    const r = U.parseRange(rangeHeader, total);
    if (r && r.invalid) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      });
    }
    if (r) {
      headers['Content-Length'] = String(r.end - r.start + 1);
      headers['Content-Range'] = `bytes ${r.start}-${r.end}/${total}`;
      return U.streamResponse(readNode(ctx, node, rangeHeader), headers, 206);
    }
  }

  headers['Content-Length'] = String(total);
  return U.streamResponse(readNode(ctx, node, null), headers, 200);
}

// ---------------------------------------------------------------- ZIP

function collectZipEntries(index, ids) {
  const out = [];
  const usedNames = new Map();
  const uniqueIn = (dir, name) => {
    if (!usedNames.has(dir)) usedNames.set(dir, new Set());
    const set = usedNames.get(dir);
    let candidate = name;
    const isDir = name.endsWith('/');
    const base = isDir ? name.slice(0, -1) : name;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let i = 1;
    while (set.has(candidate.toLowerCase())) {
      candidate = `${stem} (${i})${ext}${isDir ? '/' : ''}`;
      i++;
    }
    set.add(candidate.toLowerCase());
    return candidate;
  };

  const walk = (node, prefix) => {
    if (node.type === 'folder') {
      const children = childrenOf(index, node.id);
      const dirName = uniqueIn(prefix, node.name + '/');
      const full = prefix + dirName;
      if (!children.length) out.push({ name: full, size: 0, dir: true, mtime: node.updatedAt });
      for (const child of children) walk(child, full);
    } else {
      const name = uniqueIn(prefix, node.name);
      out.push({ name: prefix + name, size: node.size || 0, node, mtime: node.updatedAt });
    }
  };

  for (const id of ids) {
    const node = index.nodes[id];
    if (!node || node.trashedAt) continue;
    walk(node, '');
  }
  return out;
}

async function apiZip(ctx) {
  const idsParam = str(ctx.url.searchParams.get('ids') || '', 4000);
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300);
  if (!ids.length) return fail(400, 'bad_request', '未选择文件');

  const index = await readIndex(ctx.env);
  const entries = collectZipEntries(index, ids);
  if (!entries.length) return fail(404, 'empty', '没有可打包的文件');

  const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
  if (totalBytes > MAX_ZIP) return fail(413, 'too_large', '打包内容超过 3.6GB，请分批下载');

  let filename = 'hf-drive.zip';
  if (ids.length === 1 && index.nodes[ids[0]]) {
    const node = index.nodes[ids[0]];
    filename = node.type === 'folder' ? `${node.name}.zip` : `${node.name}.zip`;
  } else {
    filename = `hf-drive-${new Date().toISOString().slice(0, 10)}.zip`;
  }

  const zipEntries = entries.map((e) => ({
    name: e.name,
    size: e.size,
    mtime: e.mtime,
    open: async () => {
      const gen = readNode(ctx, e.node, null);
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of gen) controller.enqueue(chunk);
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });
    },
  }));

  return new Response(buildZipStream(zipEntries), { headers: zipHeaders(filename) });
}

// ---------------------------------------------------------------- 分享

async function apiCreateShare(ctx) {
  const body = await bodyJSON(ctx.request);
  const nodeId = str(body.nodeId, 40);
  const index = await readIndex(ctx.env);
  const node = getNode(index, nodeId);
  if (!node || node.trashedAt) return fail(404, 'not_found', '文件不存在');

  const password = String(body.password || '');
  const expiresIn = Number(body.expiresIn || 0); // 小时，0 = 永久
  const allowDownload = body.allowDownload !== false;
  let pwd = null;
  if (password) {
    if (password.length < 4) return fail(400, 'weak_password', '分享密码至少 4 位');
    pwd = await hashPassword(password);
  }

  const token = U.randomToken(9);
  const share = {
    token,
    nodeId,
    name: node.name,
    isFolder: node.type === 'folder',
    size: node.size || 0,
    password: pwd,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 3600 * 1000 : null,
    allowDownload,
    createdAt: Date.now(),
    createdBy: ctx.config.username,
    views: 0,
    downloads: 0,
  };
  await mutateShares(ctx.env, (shares) => {
    shares.shares[token] = share;
    return null;
  });
  return json({
    ok: true,
    share: {
      token,
      url: `${ctx.url.origin}/s/${token}`,
      name: share.name,
      isFolder: share.isFolder,
      hasPassword: Boolean(pwd),
      expiresAt: share.expiresAt,
      allowDownload,
      createdAt: share.createdAt,
    },
  });
}

async function apiListShares(ctx) {
  const { shares } = await readShares(ctx.env);
  const index = await readIndex(ctx.env);
  const now = Date.now();
  const list = Object.values(shares)
    .map((s) => ({
      token: s.token,
      url: `${ctx.url.origin}/s/${s.token}`,
      nodeId: s.nodeId,
      name: s.name,
      isFolder: s.isFolder,
      size: s.size,
      hasPassword: Boolean(s.password),
      expiresAt: s.expiresAt,
      expired: Boolean(s.expiresAt && s.expiresAt < now),
      allowDownload: s.allowDownload,
      createdAt: s.createdAt,
      // 缓冲里还没落盘的增量也要算进去，否则管理页会滞后 30 秒
      views: (s.views || 0) + (shareStatBuffer.get(s.token)?.views || 0),
      downloads: (s.downloads || 0) + (shareStatBuffer.get(s.token)?.downloads || 0),
      missing: !index.nodes[s.nodeId],
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return json({ ok: true, shares: list });
}

async function apiDeleteShare(ctx, token) {
  await mutateShares(ctx.env, (shares) => {
    delete shares.shares[token];
    return null;
  });
  return json({ ok: true });
}

async function apiUpdateShare(ctx, token) {
  const body = await bodyJSON(ctx.request);
  const password = typeof body.password === 'string' ? body.password : null;
  if (password !== null && password !== '' && password.length < 4) {
    return fail(400, 'weak_password', '分享密码至少 4 位');
  }
  const pwd = password ? await hashPassword(password) : null;

  const found = await mutateShares(ctx.env, (shares) => {
    const s = shares.shares[token];
    if (!s) return false;
    if (typeof body.allowDownload === 'boolean') s.allowDownload = body.allowDownload;
    if (password !== null) s.password = password === '' ? null : pwd;
    return true;
  });
  if (!found) return fail(404, 'not_found', '分享不存在');
  return json({ ok: true });
}

// ---------------------------------------------------------------- 公开分享页

async function apiPublicShare(request, env, token, rest, method) {
  const { shares } = await readShares(env);
  const share = shares[token];
  if (!share) return fail(404, 'not_found', '分享链接不存在或已被取消');
  if (share.expiresAt && share.expiresAt < Date.now()) return fail(410, 'expired', '分享链接已过期');

  const config = await readConfig(env);
  if (!config) return fail(500, 'not_ready', '服务尚未初始化');

  const cookies = U.parseCookies(request);
  const cookieName = shareCookieName(token);
  const unlocked =
    !share.password || U.safeEqual(cookies[cookieName] || '', await shareUnlockValue(config, token));

  const index = await readIndex(env);
  const node = getNode(index, share.nodeId);
  if (!node) return fail(404, 'not_found', '分享的文件已被删除');

  // /unlock
  if (rest === 'unlock' && method === 'POST') {
    if (!share.password) return json({ ok: true, unlocked: true });
    const throttle = await checkThrottle(env, request);
    if (throttle.blocked) return json({ error: 'too_many_attempts', message: '尝试过于频繁，请稍后再试' }, 429);
    const body = await bodyJSON(request);
    const ok = await verifyPassword(share.password, String(body.password || ''));
    if (!ok) {
      await recordFailure(env, request);
      return fail(401, 'bad_password', '提取密码错误');
    }
    await clearFailures(env, request);
    const value = await shareUnlockValue(config, token);
    return json({ ok: true, unlocked: true }, 200, {
      'Set-Cookie': U.serializeCookie(cookieName, value, { maxAge: 60 * 60 * 24 * 7, httpOnly: true, secure: true, sameSite: 'Lax' }),
      'Cache-Control': 'no-store, must-revalidate',
    });
  }

  // /info
  if ((rest === '' || rest === 'info') && method === 'GET') {
    const payload = {
      ok: true,
      token,
      id: node.id,
      name: node.name,
      isFolder: node.type === 'folder',
      size: node.type === 'folder' ? folderSize(index, node.id) : node.size,
      requiresPassword: Boolean(share.password),
      unlocked,
      allowDownload: share.allowDownload !== false,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      mime: node.mime || U.mimeOf(node.name),
    };
    if (node.type === 'folder' && unlocked) {
      payload.items = childrenOf(index, node.id)
        .filter((n) => !n.trashedAt)
        .map((n) => ({ ...publicNode(n), path: pathString(index, n.parent) }));
    }
    if (unlocked) await bumpShareStat(env, token, 'views');
    // 分享状态（是否解锁/是否过期）随访问实时变化，绝不能被任何一层缓存
    return json(payload, 200, { 'Cache-Control': 'no-store, must-revalidate' });
  }

  if (!unlocked) return fail(401, 'locked', '需要提取密码');

  // /file/:id
  const fileMatch = /^file\/([A-Za-z0-9_]+)$/.exec(rest);
  if (fileMatch && method === 'GET') {
    const fileNode = getNode(index, fileMatch[1]);
    if (!fileNode || fileNode.type !== 'file' || fileNode.trashedAt) return fail(404, 'not_found', '文件不存在');
    const allowed = node.type === 'file' ? fileNode.id === node.id : isDescendant(index, fileNode.id, node.id);
    if (!allowed) return fail(403, 'forbidden', '无权访问该文件');
    if (share.allowDownload === false && request.headers.get('X-Download') === '1') {
      return fail(403, 'download_disabled', '分享者已关闭下载');
    }
    await bumpShareStat(env, token, 'downloads');
    return streamPublicFile(env, config, index, fileNode, request);
  }

  // /download
  if (rest === 'download' && method === 'GET') {
    if (share.allowDownload === false) return fail(403, 'download_disabled', '分享者已关闭下载');
    await bumpShareStat(env, token, 'downloads');
    if (node.type === 'file') return streamPublicFile(env, config, index, node, request);
    const entries = collectZipEntries(index, [node.id]);
    const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
    if (totalBytes > MAX_ZIP) return fail(413, 'too_large', '内容超过 3.6GB，无法打包下载');
    const zipEntries = entries.map((e) => ({
      name: e.name,
      size: e.size,
      mtime: e.mtime,
      open: async () => {
        const gen = readNode({ config }, e.node, null);
        return new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of gen) controller.enqueue(chunk);
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });
      },
    }));
    return new Response(buildZipStream(zipEntries), { headers: zipHeaders(`${node.name}.zip`) });
  }

  return fail(404, 'not_found', '未知的分享请求');
}

// 分享访问计数：内存累加 + 30 秒合并写一次。
// 热门链接被反复访问时，不应该每次都重写 shares.json（否则 Class A 写入会被打爆）。
const shareStatBuffer = new Map();
const SHARE_FLUSH_INTERVAL = 30 * 1000;
let lastShareFlush = 0;

async function flushShareStats(env) {
  if (!shareStatBuffer.size) return;
  const pending = new Map(shareStatBuffer);
  shareStatBuffer.clear();
  try {
    await mutateShares(env, (shares) => {
      for (const [token, delta] of pending) {
        const s = shares.shares[token];
        if (!s) continue;
        s.views = (s.views || 0) + (delta.views || 0);
        s.downloads = (s.downloads || 0) + (delta.downloads || 0);
      }
      return null;
    });
  } catch {
    // 写失败就把增量放回缓冲，下一轮再试
    for (const [token, delta] of pending) {
      const cur = shareStatBuffer.get(token) || { views: 0, downloads: 0 };
      cur.views += delta.views || 0;
      cur.downloads += delta.downloads || 0;
      shareStatBuffer.set(token, cur);
    }
  }
}

async function bumpShareStat(env, token, field) {
  const rec = shareStatBuffer.get(token) || { views: 0, downloads: 0 };
  rec[field] = (rec[field] || 0) + 1;
  shareStatBuffer.set(token, rec);
  const now = Date.now();
  if (now - lastShareFlush < SHARE_FLUSH_INTERVAL) return;
  lastShareFlush = now;
  await flushShareStats(env);
}

async function streamPublicFile(env, config, index, node, request) {
  const total = node.size || 0;
  const rangeHeader = request.headers.get('Range');
  const inline = request.url.includes('inline=1');
  const headers = {
    'Content-Type': node.mime || U.mimeOf(node.name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': inline ? 'private, max-age=86400' : 'private, max-age=0',
    'Content-Disposition': U.contentDisposition(node.name, inline),
  };
  const ctx = { config, env };
  if (rangeHeader) {
    const r = U.parseRange(rangeHeader, total);
    if (r && !r.invalid) {
      headers['Content-Length'] = String(r.end - r.start + 1);
      headers['Content-Range'] = `bytes ${r.start}-${r.end}/${total}`;
      return U.streamResponse(readNode(ctx, node, rangeHeader), headers, 206);
    }
  }
  headers['Content-Length'] = String(total);
  return U.streamResponse(readNode(ctx, node, null), headers, 200);
}

// ---------------------------------------------------------------- 统计 / 设置

async function apiStats(ctx) {
  const index = await readIndex(ctx.env);
  const stats = statsOf(index);
  const { shares } = await readShares(ctx.env);
  return json({
    ok: true,
    ...stats,
    shares: Object.keys(shares).length,
    repo: ctx.config.hf?.repo || null,
    owner: ctx.config.hf?.owner || null,
    chunkSize: ctx.config.chunkSize || CHUNK_SIZE,
    version: VERSION,
  });
}

async function apiChangePassword(ctx) {
  const body = await bodyJSON(ctx.request);
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return fail(400, 'weak_password', '新密码至少 8 位');
  const ok = await verifyPassword(ctx.config, oldPassword);
  if (!ok) return fail(401, 'bad_password', '当前密码不正确');

  const { salt, hash, iterations } = await hashPassword(newPassword);
  const next = { ...ctx.config, salt, hash, iterations };
  await writeConfig(ctx.env, next);

  // 注销其它设备
  let cursor;
  let removed = 0;
  for (let page = 0; page < 10; page++) {
    const listed = await ctx.env.BUCKET.list({ prefix: 'sys/sessions/', cursor, limit: 1000 });
    const keys = (listed.objects || [])
      .map((o) => o.key)
      .filter((k) => k !== `sys/sessions/${ctx.auth.token}.json`);
    if (keys.length) {
      await deleteKeys(ctx.env, keys);
      removed += keys.length;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return json({ ok: true, loggedOutDevices: removed });
}

async function apiChangeAccount(ctx) {
  const body = await bodyJSON(ctx.request);
  const username = str(body.username, 40).trim();
  if (username.length < 2) return fail(400, 'bad_username', '用户名至少 2 个字符');
  const next = { ...ctx.config, username };
  await writeConfig(ctx.env, next);
  return json({ ok: true, username });
}

async function apiChangeStorage(ctx) {
  const body = await bodyJSON(ctx.request);
  const token = str(body.hfToken, 200).trim() || ctx.config.hf?.token;
  const repoName = str(body.repoName, 80).trim();
  if (!token) return fail(400, 'bad_token', '缺少 Token');

  let who;
  try {
    who = await HF.whoami(token);
  } catch (err) {
    return fail(400, 'bad_token', `Token 校验失败：${err.message}`);
  }
  const owner = who?.name;
  const name = repoName || ctx.config.hf?.repoName || 'hf-drive-storage';
  if (!/^[A-Za-z0-9._-]{2,80}$/.test(name)) return fail(400, 'bad_repo', '仓库名不合法');
  const repo = `${owner}/${name}`;

  try {
    await HF.createRepo({ token, name, private: true });
    await HF.probeRepo({ token, repo });
  } catch (err) {
    return fail(400, 'repo_failed', `仓库不可写：${err.message}`);
  }

  const changed = repo !== ctx.config.hf?.repo;
  const next = {
    ...ctx.config,
    hf: { token, repo, owner, repoName: name, private: true, boundAt: Date.now() },
  };
  await writeConfig(ctx.env, next);
  return json({ ok: true, repo, owner, changed });
}

/** 手动触发一次索引快照 */
async function apiBackupNow(ctx) {
  hfCfg(ctx.config);
  const index = await readIndex(ctx.env);
  const count = Object.keys(index.nodes).length;
  await backupIndex(ctx.env);
  return json({ ok: true, nodes: count, path: BACKUP_PATH, at: Date.now() });
}

/** 按快照里的父链递归还原文件夹，保留原 id（分享链接等仍然有效） */
function restoreFolder(index, snapNodes, id, depth = 0) {
  if (!id || id === 'root' || depth > 200) return 'root';
  if (index.nodes[id]) return id;
  const s = snapNodes[id];
  if (!s || s.type !== 'folder' || !s.name) return 'root';
  const parent = restoreFolder(index, snapNodes, s.parent, depth + 1);
  const now = Date.now();
  index.nodes[id] = {
    id,
    parent,
    type: 'folder',
    name: uniqueName(index, parent, s.name),
    size: 0,
    mime: '',
    createdAt: s.createdAt || now,
    updatedAt: now,
    starred: Boolean(s.starred),
    trashedAt: null,
    trashParent: null,
  };
  return id;
}

/** 从 HuggingFace 仓库重建索引（灾难恢复：索引快照 + 扫描 chunks/） */
async function apiRebuild(ctx) {
  const hf = hfCfg(ctx.config);
  const found = new Map();
  let cursor;
  let scanned = 0;
  for (let page = 0; page < 200; page++) {
    const url = `https://huggingface.co/api/datasets/${hf.repo}/tree/main/chunks?recursive=true&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${hf.token}` } });
    if (res.status === 404) break;
    if (!res.ok) return fail(502, 'hf_error', `扫描仓库失败：HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) break;
    for (const item of list) {
      if (item.type !== 'file') continue;
      const m = /^chunks\/([A-Za-z0-9_]+)\/(\d{6})\.bin$/.exec(item.path);
      if (!m) continue;
      scanned++;
      const id = m[1];
      const rec = found.get(id) || { id, chunks: 0, size: 0, chunkSize: CHUNK_SIZE };
      rec.chunks = Math.max(rec.chunks, parseInt(m[2], 10) + 1);
      // LFS 文件在 tree 里可能只给出指针大小，优先取 lfs.size（真实字节数）
      rec.size += item.lfs?.size ?? item.size ?? 0;
      found.set(id, rec);
    }
    if (list.length < 1000) break;
    cursor = res.headers.get('X-Next-Cursor') || null;
    if (!cursor) break;
  }

  // 优先用索引快照恢复：文件名、目录结构、收藏一次全回来
  let snapshot = null;
  try {
    const res = await HF.fetchFile({ token: hf.token, repo: hf.repo, path: BACKUP_PATH });
    if (res.ok) {
      const gz = new Uint8Array(await res.arrayBuffer());
      const parsed = JSON.parse(new TextDecoder().decode(await gunzipBytes(gz)));
      if (parsed?.nodes && typeof parsed.nodes === 'object') snapshot = parsed;
    }
  } catch {
    // 没有快照（老部署或首次使用）就走兜底命名
  }
  const snapNodes = snapshot?.nodes || {};

  let named = 0;
  const added = await mutateIndex(ctx.env, (index) => {
    let n = 0;
    for (const rec of found.values()) {
      if (index.nodes[rec.id]) continue;
      const s = snapNodes[rec.id];
      const now = Date.now();
      const hasMeta = Boolean(s?.name);
      const parent = hasMeta ? restoreFolder(index, snapNodes, s.parent) : 'root';
      const name = hasMeta ? uniqueName(index, parent, s.name) : `恢复的文件 ${rec.id.slice(-6)}`;
      if (hasMeta) named++;
      index.nodes[rec.id] = {
        id: rec.id,
        parent,
        type: 'file',
        name,
        size: s?.size || rec.size,
        mime: s?.mime || 'application/octet-stream',
        chunks: rec.chunks,
        chunkSize: rec.chunkSize,
        createdAt: s?.createdAt || now,
        updatedAt: now,
        starred: Boolean(s?.starred),
        trashedAt: null,
        trashParent: null,
        recovered: !hasMeta,
      };
      n++;
    }
    return n;
  });

  return json({
    ok: true,
    scanned,
    recovered: added,
    named,
    fromSnapshot: Boolean(snapshot),
    snapshotAt: snapshot?.savedAt || null,
    total: found.size,
  });
}
