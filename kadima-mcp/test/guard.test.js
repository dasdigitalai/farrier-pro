import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, assertAllowedUrl } from '../src/config.js';
import { createClient, buildUrl } from '../src/client.js';
import { defineTools } from '../src/tools.js';

const base = { KADIMA_MERCHANT_TOKEN: 'test-token', KADIMA_TERMINAL_ID: '24', KADIMA_DBA_ID: '9' };

test('defaults to sandbox hosts', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.mode, 'sandbox');
  assert.equal(cfg.gatewayBase, 'https://sandbox-gateway.kadimadashboard.com');
  assert.equal(cfg.apiBase, 'https://sandbox.kadimadashboard.com');
});

test('live mode refused without KADIMA_ALLOW_LIVE', () => {
  assert.throws(() => loadConfig({ ...base, KADIMA_ENV: 'live' }), /KADIMA_ALLOW_LIVE/);
  const cfg = loadConfig({ ...base, KADIMA_ENV: 'live', KADIMA_ALLOW_LIVE: 'true' });
  assert.equal(cfg.gatewayBase, 'https://gateway.kadimadashboard.com');
});

test('URL overrides pointing at live or foreign hosts are refused in sandbox', () => {
  assert.throws(() => loadConfig({ ...base, KADIMA_GATEWAY_URL: 'https://gateway.kadimadashboard.com' }), /non-allowed host/);
  assert.throws(() => loadConfig({ ...base, KADIMA_API_URL: 'https://kadimadashboard.com' }), /non-allowed host/);
  assert.throws(() => loadConfig({ ...base, KADIMA_API_URL: 'https://evil.example.com' }), /non-allowed host/);
  assert.throws(() => loadConfig({ ...base, KADIMA_API_URL: 'http://sandbox.kadimadashboard.com' }), /https/);
});

test('even with live allowed, non-Kadima hosts are refused', () => {
  const cfg = loadConfig({ ...base, KADIMA_ALLOW_LIVE: 'true' });
  assert.throws(() => assertAllowedUrl(cfg, 'https://kadimadashboard.com.evil.io/api'), /non-allowed host/);
  assert.throws(() => assertAllowedUrl(cfg, 'https://sandbox.kadimadashboard.com:8443/api'), /port/);
});

test('filter objects flatten to bracket query params', () => {
  const u = new URL(buildUrl('https://sandbox.kadimadashboard.com', '/api/x', {
    page: 2, 'per-page': 10, filter: { date: { gte: '2026-01-01', lte: '2026-01-31' }, id: { in: [1, 2] } },
  }));
  assert.equal(u.searchParams.get('filter[date][gte]'), '2026-01-01');
  assert.deepEqual(u.searchParams.getAll('filter[id][in][]'), ['1', '2']);
  assert.equal(u.searchParams.get('per-page'), '10');
});

function fakeClient(cfg) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, client: createClient(cfg, fetchImpl) };
}
const tool = (cfg, name) => defineTools(cfg).find((t) => t.name === name);

test('sale goes to sandbox gateway with configured terminal and bearer token', async () => {
  const cfg = loadConfig(base);
  const { calls, client } = fakeClient(cfg);
  await tool(cfg, 'kadima_card_sale').run({ amount: '2.1', card: { number: '4111111111111111', exp: '12/30', cvv: '999' } }, client);
  assert.equal(calls[0].url, 'https://sandbox-gateway.kadimadashboard.com/payment/sale');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(calls[0].body.terminal, { id: 24 });
  assert.equal(calls[0].body.source, 'Internet');
});

test('per-call terminal override wins; missing terminal is an error', async () => {
  const cfg = loadConfig(base);
  const { calls, client } = fakeClient(cfg);
  await tool(cfg, 'kadima_card_refund').run({ transaction_id: 5, terminal_id: 77 }, client);
  assert.equal(calls[0].url, 'https://sandbox-gateway.kadimadashboard.com/payment/5/refund');
  assert.deepEqual(calls[0].body.terminal, { id: 77 });

  const noTerm = loadConfig({ KADIMA_MERCHANT_TOKEN: 'x' });
  assert.throws(() => tool(noTerm, 'kadima_card_sale').run({ amount: '1.00', card: {} }, fakeClient(noTerm).client), /terminal\.id is required/);
});

test('vault/ACH/reporting go to the sandbox dashboard host', async () => {
  const cfg = loadConfig(base);
  const { calls, client } = fakeClient(cfg);
  await tool(cfg, 'kadima_vault_customers').run({}, client);
  await tool(cfg, 'kadima_ach_transactions').run({ ach_id: 3 }, client);
  await tool(cfg, 'kadima_report_payouts').run({ date_from: '2026-10-01', date_to: '2026-10-31' }, client);
  for (const c of calls) assert.equal(new URL(c.url).host, 'sandbox.kadimadashboard.com');
  assert.match(calls[2].url, /\/api\/reporting\/payouts\/acq\/9\?filter%5BprocessingDate%5D%5Bgte%5D=2026-10-01/);
});

test('missing token fails before any network call', async () => {
  const cfg = loadConfig({ KADIMA_TERMINAL_ID: '1' });
  const { calls, client } = fakeClient(cfg);
  await assert.rejects(tool(cfg, 'kadima_transactions').run({}, client), /KADIMA_MERCHANT_TOKEN is not set/);
  assert.equal(calls.length, 0);
});
