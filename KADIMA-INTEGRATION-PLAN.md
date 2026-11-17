# Kadima Payments as a 3rd payment option: plan

**Status:** proposal for review. No app code has changed. All work happens on a branch, and the live app changes only when this is merged.

## Goal

Farriers can take card payments through **Kadima**, alongside the existing Stripe and iPOSpays options. As with those two:
- A farrier connects **one** processor at a time.
- Kadima money goes straight to the farrier's own Kadima merchant account.

Farriers who don't have a Kadima account apply through the referral link:
**https://kadimapayments.com/apply?agent=dspatz**

## How a farrier uses it

1. **Settings → Payments → Kadima Payments.**
2. A farrier who has no account clicks **"Apply for a Kadima account"**, which opens the referral link above. Kadima handles the application, e-signature and underwriting. Nothing is built on our side for this.
3. Once approved, the farrier pastes three values from their Kadima dashboard:
   - **API token**, from *Developers → Tokens*, with *Credit/Debit Card Payments Read and Write*.
   - **Terminal ID**, from *Gateway* (the `Terminal ID` column, e.g. `865`; not the TID).
   - **DBA ID**, the `#number` on the merchant profile (e.g. `980`).

   They also choose **Test (sandbox)** or **Live**.
4. FarriTech checks the values with Kadima before saving. The check uses a read-only call and charges nothing.
5. From then on, these all run through Kadima: **pay links, the `/pay` page, keyed cards (in-app card form), "Waive card price", and refunds.**

## What gets built

### Server (new file, plus small hooks into existing ones)
| Piece | Where | Kadima API |
|---|---|---|
| Connect / disconnect / status | new `api/_lib/kadima.js`, routed from `api/stripe-payment.js` (`kadima_connect`, `kadima_disconnect`, `kadima_status`) | `GET /payments` (read-only credential check) |
| Pay page / pay link | `api/_lib/pay-page.js` (same branch point as iPOSpays) | `POST /api/gateway/hosted-form` with our own reference as `externalId` |
| Confirm payment before marking paid | `kadima.js` → existing `applyPayment()` (already guards against double-recording) | `GET /payments?filter[externalId]=…`. Recorded only if Kadima says **Approved** |
| Keyed card (in-app) | `kadima_keyed` / `kadima_check` actions | Same hosted form, shown in the existing card-form box |
| Refund / void | `kadima_refund` (owner/manager + refund password, same rules as today) | `POST /payment/{id}/refund` |
| One-processor rule | existing `ONE_PROCESSOR` checks extended to three processors | n/a |

### Screens (`index.html` desktop and `mobile.html`)
- A **Kadima Payments** card in Settings with the connect form, a **Test/Live** switch, and the **Apply** link.
- The places that currently check "Stripe **or** iPOSpays connected" (pay links, waive card price, keyed card, refunds) also accept Kadima.
- Payment and refund messages name Kadima when it was used.

### Data
- Credentials are stored in the existing locked `farrierSecrets/{uid}` doc, like iPOSpays. They are never sent to browsers, and no Firestore rule changes are needed.
- The public profile only gets `kadimaConnected: true`, the same pattern as `ipospaysConnected`.
- New invoice fields: `kadimaOpenRef`, `kadimaLinks.{ref}`, `kadimaTransactionId`.

## Already checked in the Kadima sandbox (terminal 865, DBA 980)
- ✅ Sale and refund work (transactions 407394 / 407396).
- ✅ A payment can be found by our own reference (`externalId`), so the confirm-before-record rule works.
- ✅ The hosted payment form can be generated and **allows embedding** (no `X-Frame-Options` / CSP frame block), so in-app keyed cards work like iPOSpays.

## Still to confirm while building
- How the hosted form returns the customer to `/pay/{invoiceId}`. Polling by `externalId` covers it either way, as iPOSpays does.
- Optional Kadima **webhook** ("Payment Transaction Created") to confirm payments faster. This is not required, because confirmation does not depend on it.
- How the card price / surcharge shows on the Kadima form, so the amount matches FarriPricing.

## Protecting the live app
- All work happens on a feature branch. Nothing merges to `main` without your approval.
- Farriers who never connect Kadima see **no change**. Stripe and iPOSpays code paths are not modified beyond the "or Kadima" checks.
- Testing uses the **sandbox** only.
- Before testing in a Vercel preview, confirm which Firebase project preview builds use, so test invoices don't land in live data.
- The `kadima-mcp/` tool folder is excluded from the Vercel deployment before any merge.

## Order of work
1. Server: `kadima.js` (connect, pay page, confirm, refund) plus tests against the sandbox.
2. Desktop Settings card and payment flows (`index.html`).
3. Mobile (`mobile.html`).
4. End-to-end sandbox run: connect → pay link → pay with a test card → invoice marked paid → refund.
5. Your review, then merge.
