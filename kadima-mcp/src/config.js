// Configuration + host safety guard for the Kadima MCP server.
//
// Secrets come only from the environment (populated from the gitignored .env
// next to package.json). Nothing here hardcodes a token.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env from the package directory regardless of the process cwd
// (Claude Code may launch the server from anywhere). Real env vars win.
dotenv.config({ path: path.join(ROOT, '.env'), override: false, quiet: true });

export const SANDBOX = Object.freeze({
  gateway: 'https://sandbox-gateway.kadimadashboard.com',
  api: 'https://sandbox.kadimadashboard.com',
});

export const LIVE = Object.freeze({
  gateway: 'https://gateway.kadimadashboard.com',
  api: 'https://kadimadashboard.com',
});

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const hostOf = (u) => new URL(u).hostname.toLowerCase();

function optionalInt(name, env) {
  const raw = (env[name] ?? '').trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

/**
 * Build the runtime config from an env object. Throws on any unsafe setting so
 * the server refuses to start rather than silently talking to production.
 */
export function loadConfig(env = process.env) {
  const mode = (env.KADIMA_ENV || 'sandbox').trim().toLowerCase();
  if (mode !== 'sandbox' && mode !== 'live') {
    throw new Error(`KADIMA_ENV must be "sandbox" or "live", got "${env.KADIMA_ENV}"`);
  }
  const allowLive = truthy(env.KADIMA_ALLOW_LIVE);
  if (mode === 'live' && !allowLive) {
    throw new Error('KADIMA_ENV=live is refused: set KADIMA_ALLOW_LIVE=true to explicitly allow live (production) hosts.');
  }

  const defaults = mode === 'live' ? LIVE : SANDBOX;
  const gatewayBase = (env.KADIMA_GATEWAY_URL || defaults.gateway).replace(/\/+$/, '');
  const apiBase = (env.KADIMA_API_URL || defaults.api).replace(/\/+$/, '');

  const allowedHosts = new Set([hostOf(SANDBOX.gateway), hostOf(SANDBOX.api)]);
  if (allowLive) {
    allowedHosts.add(hostOf(LIVE.gateway));
    allowedHosts.add(hostOf(LIVE.api));
  }

  const cfg = {
    root: ROOT,
    mode,
    allowLive,
    allowedHosts,
    gatewayBase,
    apiBase,
    merchantToken: (env.KADIMA_MERCHANT_TOKEN || '').trim() || undefined,
    agentToken: (env.KADIMA_AGENT_TOKEN || '').trim() || undefined,
    terminalId: optionalInt('KADIMA_TERMINAL_ID', env),
    dbaId: optionalInt('KADIMA_DBA_ID', env),
    downloadDir: env.KADIMA_DOWNLOAD_DIR ? path.resolve(env.KADIMA_DOWNLOAD_DIR) : path.join(ROOT, 'downloads'),
    timeoutMs: optionalInt('KADIMA_TIMEOUT_MS', env) ?? 30_000,
  };

  // Validate the configured bases up front (overrides included).
  assertAllowedUrl(cfg, cfg.gatewayBase);
  assertAllowedUrl(cfg, cfg.apiBase);
  return cfg;
}

/** Throws unless url is https:// on an allowed Kadima host. Called on every request. */
export function assertAllowedUrl(cfg, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Refusing request: invalid URL "${url}"`);
  }
  if (u.protocol !== 'https:') throw new Error(`Refusing request: only https is allowed (${u.origin})`);
  if (u.username || u.password) throw new Error('Refusing request: credentials in URL are not allowed');
  if (u.port && u.port !== '443') throw new Error(`Refusing request: non-standard port ${u.port}`);
  const host = u.hostname.toLowerCase();
  if (!cfg.allowedHosts.has(host)) {
    const hint = cfg.allowLive
      ? ''
      : ' Only sandbox hosts are allowed; set KADIMA_ENV=live and KADIMA_ALLOW_LIVE=true to use production.';
    throw new Error(`Refusing request to non-allowed host "${host}".${hint}`);
  }
  return u;
}

export function resolveTerminalId(cfg, override) {
  const id = override ?? cfg.terminalId;
  if (id === undefined || id === null) {
    throw new Error('terminal.id is required: pass terminal_id or set KADIMA_TERMINAL_ID in .env');
  }
  return Number(id);
}

export function resolveDbaId(cfg, override) {
  const id = override ?? cfg.dbaId;
  if (id === undefined || id === null) {
    throw new Error('dba.id is required: pass dba_id or set KADIMA_DBA_ID in .env');
  }
  return Number(id);
}
