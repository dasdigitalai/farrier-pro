#!/usr/bin/env node
// Kadima Payments (Merchants) MCP server over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createClient, KadimaError } from './client.js';
import { defineTools } from './tools.js';

export function buildServer(cfg, client = createClient(cfg)) {
  const server = new McpServer(
    { name: 'kadima-payments', version: '0.1.0' },
    {
      instructions:
        `Kadima Payments merchant API (${cfg.mode.toUpperCase()}). ` +
        'Card payment tools need terminal.id (defaults to KADIMA_TERMINAL_ID); CustomerVault/ACH/hosted forms/reporting need dba.id (defaults to KADIMA_DBA_ID). ' +
        'Payments and refunds move money and are not idempotent: never retry a sale/auth/refund without first checking kadima_transactions.',
    }
  );

  for (const t of defineTools(cfg)) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations },
      async (args) => {
        try {
          const res = await t.run(args, client);
          const payload = {
            environment: cfg.mode,
            ...(res.url ? { host: new URL(res.url).host } : {}),
            result: res.data,
          };
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        } catch (err) {
          const detail = err instanceof KadimaError && err.body && typeof err.body === 'object'
            ? `\n${JSON.stringify(err.body, null, 2)}`
            : '';
          return { isError: true, content: [{ type: 'text', text: `${err.message}${detail}` }] };
        }
      }
    );
  }
  return server;
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[kadima-mcp] refusing to start: ${err.message}`);
    process.exit(1);
  }
  console.error(`[kadima-mcp] ${cfg.mode} mode -> ${cfg.gatewayBase} | ${cfg.apiBase}` +
    (cfg.merchantToken ? '' : ' (WARNING: KADIMA_MERCHANT_TOKEN not set)'));
  await buildServer(cfg).connect(new StdioServerTransport());
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/server.js');
if (isMain) main();
