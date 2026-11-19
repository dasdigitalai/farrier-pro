# kadima-mcp

A local MCP server for the Kadima Payments **Merchant** APIs. The endpoints come from `Kadima_Payments_Inc.postman_collection.json`.

It is **sandbox-only by default.** It is fully separate from the FarriTech app: it has its own `package.json` and `node_modules`, nothing in the app imports it, and it is not wired into `vercel.json` or `api/`.

## Hosts

| Calls | Sandbox (default) | Live (opt-in only) |
|---|---|---|
| Card payments, tokenize, transaction lookup | `https://sandbox-gateway.kadimadashboard.com` | `https://gateway.kadimadashboard.com` |
| Hosted form/fields, CustomerVault, ACH, reporting | `https://sandbox.kadimadashboard.com` | `https://kadimadashboard.com` |

The collection hardcodes live URLs. This server ignores them and builds every URL from config. Every request is checked against an allowlist of hosts:
- https only, port 443 only.
- Redirects are refused.
- The allowlist holds only the two sandbox hosts.
- The live hosts are added only when **both** `KADIMA_ENV=live` and `KADIMA_ALLOW_LIVE=true` are set.
- Any other host is always refused. That includes a `KADIMA_GATEWAY_URL`/`KADIMA_API_URL` override pointing somewhere else.
- In live mode without the allow flag, the server refuses to start.

## Setup

```bash
cd kadima-mcp
npm install
cp .env.example .env      # .env is gitignored, never commit it
```

Fill in `.env`:

| Var | Required | Purpose |
|---|---|---|
| `KADIMA_MERCHANT_TOKEN` | yes | Bearer token from the sandbox dashboard. Card payments and hosted fields need permission `api-creditcard-payment-read-write`. |
| `KADIMA_AGENT_TOKEN` | no | Used only when a reporting tool is called with `auth: "agent"`. |
| `KADIMA_TERMINAL_ID` | for payments | Dashboard `terminal.id` sent on every gateway call. Override it per call with `terminal_id`. |
| `KADIMA_DBA_ID` | for vault/ACH/reporting/hosted forms | Default `dba.id`. Override it per call with `dba_id`. |
| `KADIMA_ENV` / `KADIMA_ALLOW_LIVE` | no | Leave as `sandbox` / `false`. |

The `.env` is loaded from this folder no matter where Claude Code starts the process. Real environment variables take precedence over it.

## Register with Claude Code

Run this from the repo root (local scope keeps it in `~/.claude.json`, so nothing is added to the repo):

```bash
claude mcp add kadima --scope local -- node "$(pwd)/kadima-mcp/src/server.js"
```

```bash
claude mcp list
```

## Tools (25)

| Area | Tools |
|---|---|
| Card payments (gateway) | `kadima_card_sale`, `kadima_card_auth`, `kadima_card_capture`, `kadima_card_refund`, `kadima_card_authentication` ($0 auth), `kadima_card_tokenize` (incl. global-token exchange), `kadima_transactions` (list / view) |
| Hosted | `kadima_hosted_form` (`card` / `ach` / `vault_card`), `kadima_hosted_fields` (`issue_token` / `get_card`) |
| CustomerVault | `kadima_vault_customers`, `kadima_vault_save_customer`, `kadima_vault_cards`, `kadima_vault_add_card`, `kadima_vault_recurring`, `kadima_vault_create_recurring`, `kadima_vault_update_recurring` |
| ACH | `kadima_ach_transactions` (list / view / log), `kadima_ach_create`, `kadima_ach_action` (`void` / `cancel` / `verify`) |
| Reporting (read-only) | `kadima_report_authorizations`, `kadima_report_batches` (list / summary), `kadima_report_chargebacks` (list / view), `kadima_report_statements` (list / PDF download), `kadima_report_payouts` (list / day detail) |
| Meta | `kadima_config`: active env, hosts, default ids, whether tokens are set (never their values) |

List tools take `filter` (a nested object flattened to Kadima's `filter[field][op]=value` syntax), `page` and `per_page`.

Some operations are deliberately left out:
- Deletes and archives (vault customers/cards, ACH records).
- Chargeback dispute submission.
- The Platforms/onboarding APIs.

## Tests

```bash
npm test        # offline: host guard, terminal override, URL building, stdio server (25 tools)
```

```bash
npm run smoke   # live sandbox: $1.00 sale with test card 4111111111111111, then full refund + lookup
```

`npm run smoke` refuses to run unless the server reports `sandbox`.

## Notes

- Sale, auth, capture and refund are **not** idempotent, and the client never retries them. If a call times out, check `kadima_transactions` before you try again.
- Card data you pass to these tools goes through the model's context. That's fine with sandbox test cards. Don't do it with real cardholder data. In production, use the hosted form or hosted fields so card numbers never touch your systems.
