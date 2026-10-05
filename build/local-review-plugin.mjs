import { timingSafeEqual, randomBytes } from 'node:crypto';

const MAX_BODY = 2_000_000;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reply = (res, status, value, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(value));
};
const error = (res, status, code, message) => reply(res, status, { error: { code, message, retryable: status === 503 } });
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createReviewMiddleware(config) {
  const { bootstrap, serviceToken, port, servicePort } = config;
  const origin = `http://127.0.0.1:${port}`;
  const target = `http://127.0.0.1:${servicePort}`;
  const session = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const expires = Date.now() + 12 * 3600_000;
  return async (req, res, next) => {
    const path = req.url?.split('?')[0] ?? '';
    if (!path.startsWith('/api/review/')) return next();
    if (!bootstrap || !serviceToken) return error(res, 503, 'LOCAL_ENTRY_REQUIRED', '请使用 npm run review:local 启动本机复盘入口');
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin) ||
        ![undefined, 'same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return error(res, 403, 'ACCESS_DENIED', '拒绝非本机同源请求');
    const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('feardesk_review='))?.slice(16);
    const authenticated = Date.now() < expires && equal(cookie, session);
    if (path === '/api/review/v1/session') {
      if (req.method === 'GET') {
        if (!authenticated) return error(res, 401, 'SESSION_REQUIRED', '请从本机启动入口解锁复盘');
        return reply(res, 200, { data: { csrf, expires_at: new Date(expires).toISOString() } });
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || Date.now() >= expires) return error(res, 403, 'ACCESS_DENIED', '本机解锁请求无效');
      try {
        const input = JSON.parse((await body(req)).toString('utf8'));
        if (!equal(input.capability, bootstrap)) return error(res, 403, 'ACCESS_DENIED', '本机启动凭据无效');
        return reply(res, 200, { data: { csrf, expires_at: new Date(expires).toISOString() } },
          { 'set-cookie': `feardesk_review=${session}; Path=/api/review/; HttpOnly; SameSite=Strict; Max-Age=43200` });
      } catch (e) { return error(res, e.message === 'TOO_LARGE' ? 413 : 422, 'INVALID_INPUT', '解锁请求格式无效'); }
    }
    if (!authenticated) return error(res, 401, 'SESSION_REQUIRED', '本机复盘会话未解锁或已到期');
    if (!['GET','POST'].includes(req.method)) return error(res, 405, 'METHOD_NOT_ALLOWED', '操作方式不支持');
    if (req.method !== 'GET' && (req.headers.origin !== origin || !equal(req.headers['x-review-csrf'], csrf))) return error(res, 403, 'CSRF_REQUIRED', '请刷新本机页面后重试');
    // Fixed namespace and target. Never forward user credentials/headers to Python.
    if (!/^\/api\/review\/v1\/(health|(?:demo|live)\/(?:overview|signals|cases|rules|reports|evidence|imports|documents|fill-patches|resolutions|groups|tasks|demo)(?:\/[a-zA-Z0-9_-]+){0,3})$/.test(path)) return error(res, 404, 'NOT_FOUND', '接口不存在');
    try {
      const payload = req.method === 'GET' ? undefined : await body(req);
      const response = await fetch(target + req.url, {
        method: req.method, headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
        body: payload, signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      reply(res, response.status, await response.json());
    } catch (e) { error(res, e.message === 'TOO_LARGE' ? 413 : 503, e.message === 'TOO_LARGE' ? 'TOO_LARGE' : 'PRIVATE_SERVICE_UNAVAILABLE', e.message === 'TOO_LARGE' ? '请求超过2MB' : '私人核算服务暂不可用；请检查本机入口'); }
  };
}

export function localReview() {
  return { name: 'feardesk-local-review', enforce: 'pre', configureServer(server) {
    server.middlewares.use(createReviewMiddleware({
      bootstrap: process.env.REVIEW_BOOTSTRAP, serviceToken: process.env.REVIEW_SERVICE_TOKEN,
      port: Number(process.env.REVIEW_WEB_PORT ?? 5191), servicePort: Number(process.env.REVIEW_SERVICE_PORT ?? 18761),
    }));
  } };
}
