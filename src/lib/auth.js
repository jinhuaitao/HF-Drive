// 认证：口令哈希、会话、登录限流
import { b64ToBytes, bytesToB64, pbkdf2, pbkdf2Single, PBKDF2_ROUND_MAX, randomToken, safeEqual, sha256Hex, serializeCookie, parseCookies, clientIp, nowSec } from './util.js';
import { getJSON, putJSON, deleteKeys, KEY_CONFIG, KEY_SESSION, KEY_THROTTLE } from './store.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

export const SESSION_COOKIE = 'hfd_session';
export const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天
const MAX_FAILS = 8;
const FAIL_WINDOW = 15 * 60;
const LOCK_TIME = 15 * 60;

export async function readConfig(env) {
  const hit = cacheGet('config');
  if (hit !== undefined) return hit;
  const cur = await getJSON(env, KEY_CONFIG);
  const config = cur?.value && cur.value.username ? cur.value : null;
  return cacheSet('config', config, config ? 60000 : 3000);
}

export async function writeConfig(env, config) {
  const ok = await putJSON(env, KEY_CONFIG, config);
  if (!ok) throw new Error('配置写入失败');
  cacheSet('config', config, 60000);
  return config;
}

export async function hashPassword(password, saltB64, iterations = 210000) {
  const salt = saltB64 || bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(password, salt, iterations);
  return { salt, hash, iterations };
}

export async function verifyPassword(config, password) {
  if (!config?.salt || !config?.hash) {
    // 兼容极早期无盐格式
    const legacy = await sha256Hex(String(password));
    return safeEqual(legacy, config?.hash || '');
  }
  const iterations = config.iterations || 210000;
  const computed = await pbkdf2(String(password), config.salt, iterations);
  if (safeEqual(computed, config.hash)) return true;

  // 兼容：早期在「允许大迭代数」的运行时（如本地 wrangler dev）上生成的哈希
  if (iterations > PBKDF2_ROUND_MAX) {
    try {
      const legacy = await pbkdf2Single(String(password), config.salt, iterations);
      if (safeEqual(legacy, config.hash)) return true;
    } catch {
      // 当前运行时不允许大迭代数，忽略
    }
  }
  return false;
}

const SESSION_CACHE_TTL = 15000;

export async function createSession(env, request, username) {
  const token = randomToken(32);
  const exp = nowSec() + SESSION_TTL;
  const session = {
    u: username,
    exp,
    ip: clientIp(request),
    ua: (request.headers.get('User-Agent') || '').slice(0, 120),
    createdAt: nowSec(),
  };
  await putJSON(env, KEY_SESSION(token), session);
  cacheSet('sess:' + token, session, SESSION_CACHE_TTL);
  return { token, exp };
}

export function sessionCookie(token, maxAge = SESSION_TTL) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge, httpOnly: true, secure: true, sameSite: 'Lax' });
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure: true, sameSite: 'Lax' });
}

export async function getAuth(env, request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const cacheKey = 'sess:' + token;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    if (!cached) return null;
    return { token, session: cached };
  }

  const cur = await getJSON(env, KEY_SESSION(token));
  if (!cur?.value) {
    cacheSet(cacheKey, null, 5000);
    return null;
  }
  if (!cur.value.exp || cur.value.exp < nowSec()) {
    await deleteKeys(env, KEY_SESSION(token));
    cacheSet(cacheKey, null, 5000);
    return null;
  }
  cacheSet(cacheKey, cur.value, SESSION_CACHE_TTL);
  return { token, session: cur.value };
}

export async function destroySession(env, token) {
  if (!token) return;
  cacheDel('sess:' + token);
  await deleteKeys(env, KEY_SESSION(token));
}

// ---------- 登录限流 ----------

export async function checkThrottle(env, request) {
  const ip = clientIp(request);
  const cur = await getJSON(env, KEY_THROTTLE(ip));
  const rec = cur?.value;
  if (!rec) return { blocked: false, ip };
  const now = nowSec();
  if (rec.until && rec.until > now) {
    return { blocked: true, ip, retryAfter: rec.until - now, count: rec.count || 0 };
  }
  if (rec.windowStart && now - rec.windowStart > FAIL_WINDOW) {
    return { blocked: false, ip };
  }
  return { blocked: false, ip, count: rec.count || 0 };
}

export async function recordFailure(env, request) {
  const ip = clientIp(request);
  const now = nowSec();
  const cur = await getJSON(env, KEY_THROTTLE(ip));
  const rec = cur?.value || { count: 0, windowStart: now };
  if (!rec.windowStart || now - rec.windowStart > FAIL_WINDOW) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count = (rec.count || 0) + 1;
  rec.last = now;
  if (rec.count >= MAX_FAILS) {
    rec.until = now + LOCK_TIME;
    rec.count = 0;
    rec.windowStart = now;
  }
  await putJSON(env, KEY_THROTTLE(ip), rec);
  return rec;
}

export async function clearFailures(env, request) {
  const ip = clientIp(request);
  await deleteKeys(env, KEY_THROTTLE(ip));
}

/** 分享链接密码解锁凭证：HMAC(secret, token) 放在 cookie 里 */
export async function shareUnlockValue(config, token) {
  const { hmacHex } = await import('./util.js');
  return (await hmacHex(config.secret || 'fallback', `share:${token}`)).slice(0, 32);
}

export function shareCookieName(token) {
  return `hfd_share_${token.slice(0, 12)}`;
}

export { b64ToBytes };
