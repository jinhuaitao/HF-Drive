// API 客户端
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data || {};
  }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, opts = {}) {
  const { method = 'GET', body, headers = {}, signal } = opts;
  const init = { method, credentials: 'same-origin', headers: { ...headers }, signal };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }

  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('网络连接失败，请检查网络后重试', 0);
  }

  if (res.status === 401 && path !== '/login' && path !== '/state') {
    onUnauthorized?.();
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(`服务端返回了非 JSON 内容（HTTP ${res.status}）`, res.status);
    }
  }

  if (!res.ok) {
    const msg = data?.message || data?.error || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),

  uploadChunk: (uploadId, index, blob, signal) =>
    request(`/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    }),

  async publicShare(token) {
    const res = await fetch(`/api/public/share/${token}`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data?.message || '分享不可用', res.status, data);
    return data;
  },

  async unlockShare(token, password) {
    const res = await fetch(`/api/public/share/${token}/unlock`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data?.message || '提取密码错误', res.status, data);
    return data;
  },
};
