import { handleApi } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      // 给 HTML 加上基础安全头
      if ((res.headers.get('Content-Type') || '').includes('text/html')) {
        const headers = new Headers(res.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('Cache-Control', 'no-cache');
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    return new Response('静态资源未配置', { status: 500 });
  },
};
