// Tool definitions for the Kadima Merchants APIs.
// Endpoints/paths mirror the Kadima Payments Postman collection; hosts come
// from config (sandbox by default) and never from tool input.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveDbaId, resolveTerminalId } from './config.js';

// ---------------------------------------------------------------- helpers ---

const id = (label) => z.coerce.number().int().positive().describe(label);
const yesNo = z.enum(['Yes', 'No']);

const amount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'amount must be a non-negative number with up to 2 decimals')
  .transform((v) => Number(v).toFixed(2));

const terminalOverride = z.coerce.number().int().positive().optional()
  .describe('Override the configured KADIMA_TERMINAL_ID for this call');
const dbaOverride = z.coerce.number().int().positive().optional()
  .describe('Override the configured KADIMA_DBA_ID for this call');
const page = z.coerce.number().int().min(1).optional().describe('Page number (default 1)');
const perPage = z.coerce.number().int().min(1).max(50).optional().describe('Results per page, 1-50 (default 30)');
const filter = z.record(z.any()).optional().describe(
  'Kadima filter object, flattened to filter[...] query params. E.g. {"createdOn":{"gte":"2026-01-01 00:00:00"}} or {"terminal.id":{"eq":24}}. Operators: lt, gt, lte, gte, eq, neq, in, nin, like, or, and, not.'
);
const authKind = z.enum(['merchant', 'agent']).optional()
  .describe('Which bearer token to use (default merchant; agent requires KADIMA_AGENT_TOKEN)');
const passthrough = (what) => z.record(z.any()).optional().describe(`Extra ${what} fields merged into the request body as-is`);

const address = z.object({
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
}).optional().describe('Billing address (AVS). Sandbox AVS match: street "8320", zip "85284"');

const card = z.object({
  name: z.string().optional().describe('Cardholder name'),
  number: z.string().regex(/^\d{12,19}$/).optional().describe('PAN, digits only (omit when using token)'),
  exp: z.string().regex(/^\d{2}\/\d{2}$/).optional().describe('Expiry mm/yy'),
  cvv: z.string().regex(/^\d{3,4}$/).optional(),
  token: z.string().optional().describe('Saved card token, used instead of number/exp/cvv'),
  save: yesNo.optional().describe('Yes = tokenize the card and return card.token'),
  store: yesNo.optional().describe('Card-on-file / MIT indicator (Visa)'),
  address,
}).refine((c) => c.token || (c.number && c.exp), 'card needs either token, or number + exp');

const contact = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
}).optional();

const clean = (obj) => {
  if (Array.isArray(obj)) return obj.map(clean);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return obj;
};

const pageQuery = (a) => ({ page: a.page, 'per-page': a.per_page, filter: a.filter });

function dateRange(field, from, to, extra) {
  const f = { ...(extra || {}) };
  if (from || to) f[field] = clean({ gte: from, lte: to });
  return Object.keys(f).length ? f : undefined;
}

// Tool annotations
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const MONEY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ------------------------------------------------------------- tool list ---

export function defineTools(cfg) {
  const T = (o) => resolveTerminalId(cfg, o);
  const D = (o) => resolveDbaId(cfg, o);

  function paymentBody(a) {
    return clean({
      ...(a.extra || {}),
      terminal: { id: T(a.terminal_id) },
      amount: a.amount,
      source: a.source ?? 'Internet',
      level: a.level ?? 1,
      origin: a.origin,
      externalId: a.external_id,
      card: a.card,
      contact: a.contact,
      order: a.order,
      threeds: a.threeds_id ? { id: a.threeds_id } : undefined,
      sendReceipt: a.send_receipt,
    });
  }

  const paymentInput = {
    amount: amount.describe('Amount in dollars, e.g. "2.10"'),
    card,
    terminal_id: terminalOverride,
    source: z.enum(['Internet', 'Phone', 'Mail']).optional().describe('Default Internet'),
    level: z.coerce.number().int().min(1).max(3).optional().describe('Processing level 1/2/3 (default 1)'),
    contact,
    order: z.record(z.any()).optional().describe('Order object (L2/L3 data, tax, products; order.description = soft descriptor)'),
    external_id: z.string().optional().describe('Your own reference id'),
    origin: z.string().optional(),
    threeds_id: z.coerce.number().int().optional().describe('ID returned by 3DS create'),
    send_receipt: yesNo.optional(),
    extra: passthrough('payment'),
  };

  return [
    // ===================================================== Card payments ===
    {
      name: 'kadima_card_sale',
      title: 'Card sale',
      description: 'Authorize and capture a card payment in one step (POST /payment/sale on the gateway). Requires terminal.id (config or terminal_id). Set card.save="Yes" to also get a reusable card token.',
      annotations: MONEY,
      input: paymentInput,
      run: (a, c) => c.request({ base: 'gateway', method: 'POST', path: '/payment/sale', body: paymentBody(a) }),
    },
    {
      name: 'kadima_card_auth',
      title: 'Card authorization',
      description: 'Authorization-only card payment (POST /payment/auth). Funds are held but not settled until kadima_card_capture is called (suggested window: 10 days).',
      annotations: MONEY,
      input: paymentInput,
      run: (a, c) => c.request({ base: 'gateway', method: 'POST', path: '/payment/auth', body: paymentBody(a) }),
    },
    {
      name: 'kadima_card_capture',
      title: 'Capture authorization',
      description: 'Capture a prior auth (POST /payment/{id}/capture). Omit amount to capture the full authorized amount; pass partial_sequence/partial_total for multi-part captures.',
      annotations: MONEY,
      input: {
        transaction_id: id('Payment id returned by kadima_card_auth'),
        amount: amount.optional().describe('Amount to capture (default: full auth)'),
        partial_sequence: z.coerce.number().int().positive().optional(),
        partial_total: z.coerce.number().int().positive().optional(),
        terminal_id: terminalOverride,
        send_receipt: yesNo.optional(),
      },
      run: (a, c) => c.request({
        base: 'gateway', method: 'POST', path: `/payment/${a.transaction_id}/capture`,
        body: clean({
          terminal: { id: T(a.terminal_id) },
          amount: a.amount,
          partial: a.partial_sequence || a.partial_total ? { sequence: a.partial_sequence, total: a.partial_total } : undefined,
          sendReceipt: a.send_receipt,
        }),
      }),
    },
    {
      name: 'kadima_card_refund',
      title: 'Refund / void',
      description: 'Refund or void a card payment (POST /payment/{id}/refund). Unsettled payments are reversed; settled ones are returned. Omit amount for a full refund; for partial refunds include any original order tax/discount in order.',
      annotations: MONEY,
      input: {
        transaction_id: id('Payment id to refund'),
        amount: amount.optional().describe('Refund amount (default: full amount)'),
        terminal_id: terminalOverride,
        order: z.record(z.any()).optional().describe('Order tax/discount data for partial refunds'),
        extra: passthrough('refund'),
      },
      run: (a, c) => c.request({
        base: 'gateway', method: 'POST', path: `/payment/${a.transaction_id}/refund`,
        body: clean({ ...(a.extra || {}), terminal: { id: T(a.terminal_id) }, amount: a.amount, order: a.order }),
      }),
    },
    {
      name: 'kadima_card_authentication',
      title: 'Card authentication ($0 auth)',
      description: 'Zero-dollar card verification (POST /payment/card-authentication): checks the card is valid and returns CVV/AVS results without holding funds. Set card.save="Yes" to tokenize at the same time.',
      annotations: WRITE,
      input: {
        card,
        terminal_id: terminalOverride,
        amount: amount.optional().describe('Default "0.00"'),
        source: z.enum(['Internet', 'MOTO']).optional().describe('Default Internet'),
      },
      run: (a, c) => c.request({
        base: 'gateway', method: 'POST', path: '/payment/card-authentication',
        body: clean({ terminal: { id: T(a.terminal_id) }, amount: a.amount ?? '0.00', source: a.source ?? 'Internet', level: 1, card: a.card }),
      }),
    },
    {
      name: 'kadima_card_tokenize',
      title: 'Tokenize card',
      description: 'Token-only request (POST /payment/generate-token). Returns card.token for future sales. With exchange_token instead of a card, swaps a regular token for a global token or vice versa (POST /payment/token-exchange).',
      annotations: WRITE,
      input: {
        card: z.object({
          name: z.string().optional(),
          number: z.string().regex(/^\d{12,19}$/),
          exp: z.string().regex(/^\d{2}\/\d{2}$/),
          cvv: z.string().regex(/^\d{3,4}$/).optional(),
        }).optional(),
        exchange_token: z.string().optional().describe('Existing token to exchange (regular <-> global)'),
        terminal_id: terminalOverride,
        source: z.enum(['Internet', 'MOTO']).optional(),
      },
      run: (a, c) => {
        if (a.exchange_token) {
          return c.request({ base: 'gateway', method: 'POST', path: '/payment/token-exchange', body: { terminal: { id: T(a.terminal_id) }, token: a.exchange_token } });
        }
        if (!a.card) throw new Error('Provide card (to tokenize) or exchange_token');
        return c.request({ base: 'gateway', method: 'POST', path: '/payment/generate-token', body: clean({ terminal: { id: T(a.terminal_id) }, source: a.source ?? 'Internet', card: a.card }) });
      },
    },
    {
      name: 'kadima_transactions',
      title: 'Card transaction lookup',
      description: 'Look up gateway card transactions. With transaction_id: GET /payment/{id}. Without: GET /payments (all terminals; filter e.g. {"terminal.id":{"eq":24}}).',
      annotations: READ,
      input: { transaction_id: id('Payment id').optional(), filter, page, per_page: perPage },
      run: (a, c) => a.transaction_id
        ? c.request({ base: 'gateway', method: 'GET', path: `/payment/${a.transaction_id}` })
        : c.request({ base: 'gateway', method: 'GET', path: '/payments', query: pageQuery(a) }),
    },

    // ================================================ Hosted form/fields ===
    {
      name: 'kadima_hosted_form',
      title: 'Generate hosted payment form',
      description: 'Generate a hosted payment page (returns embeddable code + url). kind="card": card payment form (POST /api/gateway/hosted-form). kind="ach": ACH payment form (POST /api/ach/hosted-form). kind="vault_card": add-card form for a CustomerVault customer (POST /api/customer-vault-card/form, needs customer_id).',
      annotations: WRITE,
      input: {
        kind: z.enum(['card', 'ach', 'vault_card']),
        amount: amount.optional(),
        customer_id: id('CustomerVault customer id (vault_card only)').optional(),
        return_url: z.string().url().optional(),
        return_url_navigation: z.enum(['top', 'self']).optional().describe('card / vault_card only'),
        threeds: z.enum(['Enabled', 'Disabled']).optional().describe('card only, default Disabled'),
        fee: z.coerce.number().optional().describe('card only'),
        fee_type: z.enum(['amount', 'percent']).optional().describe('card only'),
        external_id: z.string().optional().describe('card only'),
        memo: z.string().optional().describe('ach only'),
        use_logo: yesNo.optional(),
        send_receipt: yesNo.optional(),
        terminal_id: terminalOverride,
        dba_id: dbaOverride,
        options: passthrough('form option'),
      },
      run: (a, c) => {
        const dba = { id: D(a.dba_id) };
        if (a.kind === 'ach') {
          return c.request({ base: 'api', method: 'POST', path: '/api/ach/hosted-form', body: clean({
            ...(a.options || {}), dba, amount: a.amount, memo: a.memo, returnUrl: a.return_url, useLogo: a.use_logo, sendReceipt: a.send_receipt,
          }) });
        }
        if (a.kind === 'vault_card') {
          if (!a.customer_id) throw new Error('customer_id is required for kind="vault_card"');
          return c.request({ base: 'api', method: 'POST', path: '/api/customer-vault-card/form', body: clean({
            ...(a.options || {}), dba, terminal: { id: T(a.terminal_id) }, customerVault: { id: a.customer_id },
            returnUrl: a.return_url, returnUrlNavigation: a.return_url_navigation,
          }) });
        }
        return c.request({ base: 'api', method: 'POST', path: '/api/gateway/hosted-form', body: clean({
          ...(a.options || {}), dba, terminal: { id: T(a.terminal_id) }, threeds: a.threeds ?? 'Disabled',
          amount: a.amount, fee: a.fee, feeType: a.fee_type, externalId: a.external_id, origin: 'API',
          returnUrl: a.return_url, returnUrlNavigation: a.return_url_navigation, useLogo: a.use_logo, sendReceipt: a.send_receipt,
        }) });
      },
    },
    {
      name: 'kadima_hosted_fields',
      title: 'Hosted Fields',
      description: 'Hosted Fields helpers. action="issue_token": issue a single-use access token for rendering hosted card fields on your site (POST /api/hosted-fields/token; one token = one payment). action="get_card": after a payment where saving was allowed, fetch the tokenized card for access_token (POST /api/hosted-fields/card-token; must happen before the access token expires).',
      annotations: WRITE,
      input: {
        action: z.enum(['issue_token', 'get_card']),
        domain: z.string().url().optional().describe('issue_token: full origin the fields render on, e.g. https://my.site.com'),
        expiration: z.coerce.number().int().min(1).max(30).optional().describe('issue_token: minutes, max 30'),
        save_card: z.enum(['required', 'optional', 'disabled']).optional().describe('issue_token'),
        three_ds: z.boolean().optional().describe('issue_token'),
        terminal_id: terminalOverride,
        access_token: z.string().optional().describe('get_card: the Hosted Fields access token used for the payment'),
      },
      run: (a, c) => {
        if (a.action === 'get_card') {
          if (!a.access_token) throw new Error('access_token is required for action="get_card"');
          return c.request({ base: 'api', method: 'POST', path: '/api/hosted-fields/card-token', body: { accessToken: a.access_token } });
        }
        if (!a.domain) throw new Error('domain is required for action="issue_token"');
        return c.request({ base: 'api', method: 'POST', path: '/api/hosted-fields/token', body: clean({
          terminal: T(a.terminal_id), domain: a.domain, expiration: a.expiration, saveCard: a.save_card, '3ds': a.three_ds,
        }) });
      },
    },

    // ==================================================== CustomerVault ===
    {
      name: 'kadima_vault_customers',
      title: 'CustomerVault customers',
      description: 'List CustomerVault customers (GET /api/customer-vault) or view one with customer_id.',
      annotations: READ,
      input: { customer_id: id('Customer id').optional(), filter, page, per_page: perPage },
      run: (a, c) => a.customer_id
        ? c.request({ base: 'api', method: 'GET', path: `/api/customer-vault/${a.customer_id}` })
        : c.request({ base: 'api', method: 'GET', path: '/api/customer-vault', query: pageQuery(a) }),
    },
    {
      name: 'kadima_vault_save_customer',
      title: 'Create/update vault customer',
      description: 'Without customer_id: create a CustomerVault customer (POST /api/customer-vault; first_name + last_name required). With customer_id: update only the provided fields (PUT /api/customer-vault/{id}).',
      annotations: WRITE,
      input: {
        customer_id: id('Existing customer id (update)').optional(),
        first_name: z.string().optional(), last_name: z.string().optional(),
        email: z.string().optional(), phone: z.string().optional(), company: z.string().optional(),
        website: z.string().optional(), description: z.string().optional(),
        identificator: z.string().optional().describe('Your external customer id'),
        dba_id: dbaOverride, extra: passthrough('customer'),
      },
      run: (a, c) => {
        const fields = {
          ...(a.extra || {}), firstName: a.first_name, lastName: a.last_name, email: a.email, phone: a.phone,
          company: a.company, website: a.website, description: a.description, identificator: a.identificator,
        };
        if (a.customer_id) {
          return c.request({ base: 'api', method: 'PUT', path: `/api/customer-vault/${a.customer_id}`, body: clean(fields) });
        }
        if (!a.first_name || !a.last_name) throw new Error('first_name and last_name are required to create a customer');
        return c.request({ base: 'api', method: 'POST', path: '/api/customer-vault', body: clean({ dba: { id: D(a.dba_id) }, ...fields }) });
      },
    },
    {
      name: 'kadima_vault_cards',
      title: 'Vault customer cards',
      description: 'List a vault customer\'s stored cards (GET /api/customer-vault/{customerId}/cards) or view one with card_id.',
      annotations: READ,
      input: { customer_id: id('Customer id'), card_id: id('Card id').optional(), page, per_page: perPage },
      run: (a, c) => a.card_id
        ? c.request({ base: 'api', method: 'GET', path: `/api/customer-vault/${a.customer_id}/card/${a.card_id}` })
        : c.request({ base: 'api', method: 'GET', path: `/api/customer-vault/${a.customer_id}/cards`, query: pageQuery(a) }),
    },
    {
      name: 'kadima_vault_add_card',
      title: 'Add card to vault customer',
      description: 'Store a card on a CustomerVault customer (POST /api/customer-vault/{customerId}/card). Uses terminal.id.',
      annotations: WRITE,
      input: {
        customer_id: id('Customer id'),
        number: z.string().regex(/^\d{12,19}$/), exp: z.string().regex(/^\d{2}\/\d{2}$/).describe('mm/yy'),
        cvv: z.string().regex(/^\d{3,4}$/).optional(), holder_name: z.string(),
        billing_id: id('Billing information id').optional(), terminal_id: terminalOverride,
      },
      run: (a, c) => c.request({ base: 'api', method: 'POST', path: `/api/customer-vault/${a.customer_id}/card`, body: clean({
        terminal: { id: T(a.terminal_id) }, billing: a.billing_id ? { id: a.billing_id } : undefined,
        number: a.number, exp: a.exp, cvv: a.cvv, holderName: a.holder_name,
      }) }),
    },
    {
      name: 'kadima_vault_recurring',
      title: 'Recurring payments',
      description: 'List a vault customer\'s recurring payments (GET /api/customer-vault/{customerId}/recurring-payments) or view one with recurring_id.',
      annotations: READ,
      input: { customer_id: id('Customer id'), recurring_id: id('Recurring payment id').optional(), page, per_page: perPage },
      run: (a, c) => a.recurring_id
        ? c.request({ base: 'api', method: 'GET', path: `/api/customer-vault/${a.customer_id}/recurring-payment/${a.recurring_id}` })
        : c.request({ base: 'api', method: 'GET', path: `/api/customer-vault/${a.customer_id}/recurring-payments`, query: pageQuery(a) }),
    },
    {
      name: 'kadima_vault_create_recurring',
      title: 'Create recurring payment',
      description: 'Schedule recurring billing against a vault customer\'s stored card (POST /api/customer-vault/{customerId}/recurring-payment). Charges run automatically on schedule.',
      annotations: MONEY,
      input: {
        customer_id: id('Customer id'), card_id: id('Stored card id (from kadima_vault_cards)'),
        name: z.string(), description: z.string().optional(), amount,
        frequency: z.coerce.number().int().positive().describe('Every N periods'),
        period: z.enum(['day', 'week', 'month', 'year']),
        valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
        valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        max_payments: z.coerce.number().int().positive().optional(),
        terminal_id: terminalOverride, dba_id: dbaOverride, extra: passthrough('recurring'),
      },
      run: (a, c) => c.request({ base: 'api', method: 'POST', path: `/api/customer-vault/${a.customer_id}/recurring-payment`, body: clean({
        ...(a.extra || {}), name: a.name, description: a.description, amount: a.amount,
        execute: { frequency: a.frequency, period: a.period }, valid: { from: a.valid_from, to: a.valid_to },
        payment: a.max_payments ? { max: a.max_payments } : undefined,
        terminal: { id: T(a.terminal_id) }, customer: { id: a.customer_id, card: { id: a.card_id } }, dba: { id: D(a.dba_id) },
      }) }),
    },
    {
      name: 'kadima_vault_update_recurring',
      title: 'Update recurring payment',
      description: 'Update a recurring payment (PUT /api/customer-vault/{customerId}/recurring-payment/{id}): name, description, amount, schedule or any field via extra (e.g. {"status":"Inactive"}).',
      annotations: MONEY,
      input: {
        customer_id: id('Customer id'), recurring_id: id('Recurring payment id'),
        name: z.string().optional(), description: z.string().optional(), amount: amount.optional(),
        frequency: z.coerce.number().int().positive().optional(), period: z.enum(['day', 'week', 'month', 'year']).optional(),
        valid_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), extra: passthrough('recurring'),
      },
      run: (a, c) => c.request({ base: 'api', method: 'PUT', path: `/api/customer-vault/${a.customer_id}/recurring-payment/${a.recurring_id}`, body: clean({
        ...(a.extra || {}), name: a.name, description: a.description, amount: a.amount,
        execute: a.frequency || a.period ? { frequency: a.frequency, period: a.period } : undefined,
        valid: a.valid_to ? { to: a.valid_to } : undefined,
      }) }),
    },

    // ============================================================== ACH ===
    {
      name: 'kadima_ach_transactions',
      title: 'ACH transaction lookup',
      description: 'List ACH transactions (GET /api/ach) or view one with ach_id. include_log=true also returns its status history (GET /api/ach/{id}/log).',
      annotations: READ,
      input: { ach_id: id('ACH transaction id').optional(), include_log: z.boolean().optional(), filter, page, per_page: perPage },
      run: async (a, c) => {
        if (!a.ach_id) return c.request({ base: 'api', method: 'GET', path: '/api/ach', query: pageQuery(a) });
        const rec = await c.request({ base: 'api', method: 'GET', path: `/api/ach/${a.ach_id}` });
        if (!a.include_log) return rec;
        const log = await c.request({ base: 'api', method: 'GET', path: `/api/ach/${a.ach_id}/log` });
        return { ...rec, data: { transaction: rec.data, log: log.data } };
      },
    },
    {
      name: 'kadima_ach_create',
      title: 'Create ACH transaction',
      description: 'Create an ACH debit or credit (POST /api/ach). Either pass bank details (routing_number, account_number, account_name, account_type) or customer.id (+ optional account_id) of a saved ACH customer. customer.save="Yes" saves the payer for reuse.',
      annotations: MONEY,
      input: {
        amount: amount.describe('Total including tax'),
        transaction_type: z.enum(['Debit', 'Credit']),
        sec_code: z.enum(['PPD', 'CCD', 'WEB', 'TEL']).optional(),
        tax: amount.optional(),
        routing_number: z.string().regex(/^\d{9}$/).optional(),
        account_number: z.string().regex(/^\d{4,17}$/).optional(),
        account_name: z.string().optional(),
        account_type: z.enum(['Checking', 'Savings']).optional(),
        customer: z.record(z.any()).optional().describe('e.g. {"id":"42"} or {"email":"a@b.com","save":"Yes","firstName":...}'),
        account_id: z.string().optional().describe('Saved customer account id'),
        transaction_date: z.string().optional().describe('Desired submit date YYYY-MM-DD (default today)'),
        memo: z.string().optional(), addenda_text: z.string().optional().describe('Not allowed with WEB/TEL'),
        check_number: z.string().optional(),
        dba_id: dbaOverride, extra: passthrough('ACH'),
      },
      run: (a, c) => c.request({ base: 'api', method: 'POST', path: '/api/ach', body: clean({
        ...(a.extra || {}), amount: a.amount, tax: a.tax, transactionType: a.transaction_type, SECCode: a.sec_code,
        routingNumber: a.routing_number, accountNumber: a.account_number, accountName: a.account_name, accountType: a.account_type,
        customer: a.customer, account: a.account_id ? { id: a.account_id } : undefined, transactionDate: a.transaction_date,
        memo: a.memo, addendaText: a.addenda_text, checkNumber: a.check_number, dba: { id: D(a.dba_id) },
      }) }),
    },
    {
      name: 'kadima_ach_action',
      title: 'ACH action (void/cancel/verify)',
      description: 'Run an action on an ACH record (POST /api/ach/{id}/{action}). void: only in Held/Pending/Submitted. cancel: stop a recurring ACH. verify: pre-verify before submission.',
      annotations: MONEY,
      input: { ach_id: id('ACH transaction id'), action: z.enum(['void', 'cancel', 'verify']) },
      run: (a, c) => c.request({ base: 'api', method: 'POST', path: `/api/ach/${a.ach_id}/${a.action}` }),
    },

    // ======================================================== Reporting ===
    {
      name: 'kadima_report_authorizations',
      title: 'Authorizations report',
      description: 'Read-only: list authorizations for a DBA (GET /api/reporting/authorizations/{dbaId}). Without dates Kadima returns the last 5 days. Dates: "YYYY-MM-DD HH:MM:SS".',
      annotations: READ,
      input: { dba_id: dbaOverride, date_from: z.string().optional(), date_to: z.string().optional(), filter, page, per_page: perPage, auth: authKind },
      run: (a, c) => c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/authorizations/${D(a.dba_id)}`,
        query: { page: a.page, 'per-page': a.per_page, filter: dateRange('date', a.date_from, a.date_to, a.filter) } }),
    },
    {
      name: 'kadima_report_batches',
      title: 'Batches report',
      description: 'Read-only: list batch transactions for a DBA (GET /api/reporting/batches/{dbaId}; default last 5 days), or with batch (id or YYYY-MM-DD) return that batch summary (GET /api/reporting/batch-summary/{dbaId}/{batch}).',
      annotations: READ,
      input: { dba_id: dbaOverride, batch: z.string().optional().describe('Batch id or date YYYY-MM-DD for a summary'),
        date_from: z.string().optional(), date_to: z.string().optional(), filter, page, per_page: perPage, auth: authKind },
      run: (a, c) => a.batch
        ? c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/batch-summary/${D(a.dba_id)}/${encodeURIComponent(a.batch)}` })
        : c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/batches/${D(a.dba_id)}`,
          query: { page: a.page, 'per-page': a.per_page, filter: dateRange('date', a.date_from, a.date_to, a.filter) } }),
    },
    {
      name: 'kadima_report_chargebacks',
      title: 'Chargebacks report',
      description: 'Read-only: list chargebacks (GET /api/reporting/chargebacks; filter e.g. {"dba.id":9} or {"attention":"Yes"}) or view one with its cases via chargeback_id (GET /api/reporting/chargeback/{id}).',
      annotations: READ,
      input: { chargeback_id: id('Chargeback id').optional(), filter, page, per_page: perPage, auth: authKind },
      run: (a, c) => a.chargeback_id
        ? c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/chargeback/${a.chargeback_id}` })
        : c.request({ base: 'api', method: 'GET', auth: a.auth, path: '/api/reporting/chargebacks', query: pageQuery(a) }),
    },
    {
      name: 'kadima_report_statements',
      title: 'Statements',
      description: 'Read-only: list monthly statements for a DBA (GET /api/reporting/statements/{dbaId}). With statement_id, downloads that statement PDF to the local downloads folder and returns its path.',
      annotations: READ,
      input: { dba_id: dbaOverride, statement_id: id('Statement id to download').optional(), page, per_page: perPage, auth: authKind },
      run: async (a, c) => {
        if (!a.statement_id) {
          return c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/statements/${D(a.dba_id)}`, query: pageQuery(a) });
        }
        const res = await c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/statement/${a.statement_id}`, binary: true });
        await fs.mkdir(cfg.downloadDir, { recursive: true });
        const ext = res.contentType.includes('pdf') ? 'pdf' : 'bin';
        const file = path.join(cfg.downloadDir, `statement-${a.statement_id}.${ext}`);
        await fs.writeFile(file, res.buffer);
        return { url: res.url, data: { saved_to: file, bytes: res.buffer.length, content_type: res.contentType } };
      },
    },
    {
      name: 'kadima_report_payouts',
      title: 'Payouts report',
      description: 'Read-only: list acquiring payouts/deposits for a DBA (GET /api/reporting/payouts/acq/{dbaId}; default current month), or detail for one processing_date (GET /api/reporting/payout/acq/{dbaId}/{date}) incl. fees, chargebacks and reserves.',
      annotations: READ,
      input: { dba_id: dbaOverride, processing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        date_from: z.string().optional(), date_to: z.string().optional(), filter, page, per_page: perPage, auth: authKind },
      run: (a, c) => a.processing_date
        ? c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/payout/acq/${D(a.dba_id)}/${a.processing_date}` })
        : c.request({ base: 'api', method: 'GET', auth: a.auth, path: `/api/reporting/payouts/acq/${D(a.dba_id)}`,
          query: { page: a.page, 'per-page': a.per_page, filter: dateRange('processingDate', a.date_from, a.date_to, a.filter) } }),
    },

    // ============================================================ Meta ===
    {
      name: 'kadima_config',
      title: 'Show Kadima config',
      description: 'Show the active environment, hosts, default terminal/DBA ids and which tokens are configured (values never shown). No network call.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      input: {},
      local: true,
      run: async () => ({ data: {
        environment: cfg.mode,
        live_allowed: cfg.allowLive,
        gateway_base: cfg.gatewayBase,
        api_base: cfg.apiBase,
        allowed_hosts: [...cfg.allowedHosts],
        terminal_id: cfg.terminalId ?? null,
        dba_id: cfg.dbaId ?? null,
        merchant_token: cfg.merchantToken ? 'set' : 'MISSING',
        agent_token: cfg.agentToken ? 'set' : 'not set',
      } }),
    },
  ];
}
