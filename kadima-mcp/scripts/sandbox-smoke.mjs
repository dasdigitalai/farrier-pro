// End-to-end sandbox check: launches the MCP server over stdio (exactly as
// Claude Code does), runs a $1.00 sale with a collection test card, refunds
// it, then looks both up. Refuses to run unless the server reports sandbox.
//
//   npm run smoke            (reads kadima-mcp/.env)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');

// Visa test card from the collection's "Gateway Test Cards" table; the
// collection's AVS note says to use street 8320 / zip 85284.
const TEST_CARD = {
  name: 'Sandbox Tester',
  number: '4111111111111111',
  exp: '12/30',
  cvv: '999',
  address: { country: 'United States', state: 'AZ', city: 'Tempe', street: '8320', zip: '85284' },
};

const client = new Client({ name: 'kadima-smoke', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'inherit' }));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

try {
  const cfg = (await call('kadima_config', {})).result;
  if (cfg.environment !== 'sandbox') throw new Error(`Refusing smoke test: environment is ${cfg.environment}`);
  console.log(`config: ${cfg.environment}, terminal_id=${cfg.terminal_id}, gateway=${cfg.gateway_base}`);

  const sale = await call('kadima_card_sale', {
    amount: '1.00',
    card: TEST_CARD,
    external_id: `mcp-smoke-${Date.now()}`,
  });
  const s = sale.result;
  console.log(`SALE   -> host=${sale.host} id=${s.id} amount=${s.amount} status=${s.status?.status} authCode=${s.authCode} captured=${s.captured}`);
  if (s.status?.status !== 'Approved') throw new Error(`Sale not approved: ${JSON.stringify(s.status)}`);

  const refund = await call('kadima_card_refund', { transaction_id: s.id });
  const r = refund.result;
  console.log(`REFUND -> host=${refund.host} id=${r.id} parent=${r.parent?.id} amount=${r.amount} status=${r.status?.status} type=${r.type ?? ''}`);
  if (r.status?.status !== 'Approved') throw new Error(`Refund not approved: ${JSON.stringify(r.status)}`);

  const after = (await call('kadima_transactions', { transaction_id: s.id })).result;
  console.log(`LOOKUP -> id=${after.id} refunded=${after.refunded} status=${after.status?.status} history=${JSON.stringify(after.history)}`);
  console.log('\nOK: sandbox sale + refund succeeded through the MCP server.');
} finally {
  await client.close();
}
