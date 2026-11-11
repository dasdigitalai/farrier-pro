// Minimal HTTP client for Kadima. Every request is checked against the host
// allowlist, redirects are refused (so a 3xx can't bounce us to another host),
// and POSTs are never retried (payments are not idempotent).
import { assertAllowedUrl } from './config.js';

export class KadimaError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'KadimaError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Flatten {filter: {date: {gte: 'x'}}} into filter[date][gte]=x, the bracket
 * style the Kadima API documents. Arrays become key[]=v.
 */
export function appendQuery(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const v of value) appendQuery(params, `${key}[]`, v);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) appendQuery(params, `${key}[${k}]`, v);
  } else {
    params.append(key, String(value));
  }
}

export function buildUrl(base, pathname, query) {
  const url = new URL(base.replace(/\/+$/, '') + pathname);
  if (query) for (const [k, v] of Object.entries(query)) appendQuery(url.searchParams, k, v);
  return url.toString();
}

export function createClient(cfg, fetchImpl = globalThis.fetch) {
  function tokenFor(kind) {
    const token = kind === 'agent' ? cfg.agentToken : cfg.merchantToken;
    if (!token) {
      const name = kind === 'agent' ? 'KADIMA_AGENT_TOKEN' : 'KADIMA_MERCHANT_TOKEN';
      throw new Error(`${name} is not set. Add it to kadima-mcp/.env (gitignored).`);
    }
    return token;
  }

  /**
   * @param {object} opts
   * @param {'gateway'|'api'} opts.base
   * @param {string} opts.method
   * @param {string} opts.path   must start with '/'
   * @param {object} [opts.query]
   * @param {object} [opts.body]
   * @param {'merchant'|'agent'} [opts.auth]
   * @param {boolean} [opts.binary] return {buffer, contentType} instead of JSON
   */
  async function request({ base, method, path, query, body, auth = 'merchant', binary = false }) {
    const baseUrl = base === 'gateway' ? cfg.gatewayBase : cfg.apiBase;
    const url = buildUrl(baseUrl, path, query);
    assertAllowedUrl(cfg, url);

    const headers = {
      Authorization: `Bearer ${tokenFor(auth)}`,
      Accept: binary ? '*/*' : 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new KadimaError(`Network error calling ${method} ${new URL(url).origin}${path}: ${err.message}`);
    }

    if (binary && res.ok) {
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        url,
      };
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.message || data.name)) || res.statusText;
      throw new KadimaError(`Kadima ${res.status} on ${method} ${path}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, {
        status: res.status,
        body: data,
      });
    }
    return { data, url, status: res.status };
  }

  return { request };
}
