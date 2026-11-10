// 通用工具函数
const enc = new TextEncoder();
const dec = new TextDecoder();

export const ROOT = 'root';

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function fail(status, error, message) {
  return json({ error, message: message || error }, status);
}

export function uid(prefix = '') {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return prefix + s.slice(0, 12);
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToB64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function b64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cloudflare Workers（workerd）的 WebCrypto 对单次 PBKDF2 迭代数有 10 万上限，
 * 超过会抛 "Pbkdf2 failed: iteration counts above 100000 are not supported"。
 * 这里把总迭代数拆成多轮串联派生（上一轮输出作为下一轮口令），
 * 累计工作量与直接跑 iterations 次等价，同时永远不超过单次上限。
 */
export const PBKDF2_ROUND_MAX = 100000;

export async function pbkdf2(password, saltB64, iterations = 210000) {
  const salt = b64ToBytes(saltB64);
  const total = Math.max(1, Math.floor(iterations) || 1);
  let material = typeof password === 'string' ? enc.encode(password) : password;
  let remaining = total;
  let out = new Uint8Array(0);

  while (remaining > 0) {
    const round = Math.min(PBKDF2_ROUND_MAX, remaining);
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: round, hash: 'SHA-256' },
      key,
      256
    );
    out = new Uint8Array(bits);
    material = out;
    remaining -= round;
  }
  return bytesToB64(out);
}

/** 单次派生（仅用于兼容早期在允许大迭代数的运行时上生成的哈希） */
export async function pbkdf2Single(password, saltB64, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 解析 Range 头，返回 {start,end} 或 null；不支持多段 Range */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    // bytes=-N 取最后 N 字节
    const n = Math.min(end, size);
    start = size - n;
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

const MIME_MAP = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  scss: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  sh: 'text/x-sh; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
};

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

export function mimeOf(name, fallback = 'application/octet-stream') {
  return MIME_MAP[extOf(name)] || fallback;
}

export function isTextLike(mime, name) {
  if (mime && (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('javascript'))) return true;
  const e = extOf(name);
  return ['md', 'markdown', 'txt', 'log', 'csv', 'yml', 'yaml', 'ini', 'toml', 'conf', 'sql', 'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sh', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'json', 'xml', 'html'].includes(e);
}

/** 只保留安全字符，并截断超长名字 */
export function sanitizeName(name, fallback = '未命名') {
  let s = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  s = s.replace(/^\.+$/, '');
  if (!s) s = fallback;
  if (s.length > 180) {
    const ext = extOf(s);
    s = s.slice(0, 170) + (ext ? '.' + ext : '');
  }
  return s;
}

/** 从 Content-Disposition 安全地输出文件名（支持中文） */
export function contentDisposition(filename, inline = false) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return parts.join('; ');
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 把 async generator / ReadableStream 统一成 Response 的 body */
export function streamResponse(iterator, headers, status = 200) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of iterator) {
          if (chunk && chunk.length) controller.enqueue(chunk);
        }
        controller.close();
      } catch (err) {
        console.error('stream error', err?.message || err);
        try {
          controller.error(err);
        } catch {}
      }
    },
    cancel(reason) {
      if (iterator && typeof iterator.return === 'function') {
        try { iterator.return(); } catch {}
      }
    },
  });
  return new Response(stream, { status, headers });
}

export function fmtDate(ts) {
  return new Date(ts * 1000).toISOString();
}
