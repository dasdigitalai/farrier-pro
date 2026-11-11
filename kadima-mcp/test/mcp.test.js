// Spawns the real server over stdio and checks it lists 25 tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');

test('server starts over stdio and exposes 25 tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server],
    env: { PATH: process.env.PATH, KADIMA_MERCHANT_TOKEN: 'x', KADIMA_TERMINAL_ID: '1' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 25);
  const cfg = await client.callTool({ name: 'kadima_config', arguments: {} });
  const out = JSON.parse(cfg.content[0].text).result;
  assert.equal(out.environment, 'sandbox');
  assert.deepEqual(out.allowed_hosts.sort(), ['sandbox-gateway.kadimadashboard.com', 'sandbox.kadimadashboard.com']);
  await client.close();
});

test('server refuses to start in live mode without the allow flag', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [server], { env: { PATH: process.env.PATH, KADIMA_ENV: 'live' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to start/);
});
