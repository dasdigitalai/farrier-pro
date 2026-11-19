# FarriTech subscriptions on Kadima: plan

**Status:** proposal for review. No code has been written. The work happens in the **landing-page repo** (`dasdigitalai/farrier-pro-landing-page`) on a branch, is tested in the Kadima sandbox, and goes live only when you approve.

## Goal

New FarriTech signups pay their subscription through **FarriTech's own Kadima merchant account** instead of Stripe:
- **Monthly:** $59.99
- **Annual:** $599

**Existing Stripe subscribers stay on Stripe**, unchanged.

## How it works for a farrier

1. **Signup (day 0).** The farrier signs up on the landing page with no card, as today. FarriTech saves the trial end date (day 30). Nothing is created in Kadima or Stripe.
2. **Reminders.** The existing daily trial-email job sends a "trial ends soon" email around day 25. On day 30 it sends **"Start your FarriTech subscription"** with a personal link.
3. **The link** is signed, expires, and is tied to that farrier, so no one else can use it. It opens a FarriTech page where they:
   - choose **monthly** or **annual** and enter any promo code;
   - enter their card on **Kadima's secure hosted card form**. The card goes to Kadima and never touches FarriTech.
4. **Subscription starts.** FarriTech creates:
   - a Kadima vault customer, with their card;
   - a **recurring payment**: $59.99 every 1 month or $599 every 1 year, starting that day.

   Kadima charges the first payment immediately and then on the same date each month or year.
5. **Status updates.** Kadima's webhook tells FarriTech about each charge. FarriTech marks the farrier **active**, **past due** or **cancelled** in Firestore. That replaces the current Stripe webhook, which only logs.
6. **Manage subscription.** A FarriTech page lets the farrier:
   - **update their card**, using the Kadima hosted card form;
   - **switch plan**: cancel the old recurring payment and start the new one on the next billing date;
   - **cancel**: status **Completed** + **archive** in Kadima.

## Decision needed: trial ended, no card yet

Pick what the farrier sees:
- **A.** The app keeps working with a "Start your subscription" banner (softest).
- **B.** The app goes read-only (can view, can't add) until they subscribe.
- **C.** The app is locked except for the subscribe page.

In every case their data is kept, and the link keeps working.

## Already proven in the Kadima sandbox (2026-11-17)

| Check | Result |
|---|---|
| Create a vault customer, billing address and card | ✅ Customer 10104, card 4949 |
| Recurring payment, monthly, starting today | ✅ Charged at once (407514); next date one month later |
| Recurring payment with a future start date | ✅ Nothing charged; first charge scheduled for that date |
| Trace a charge to its subscription | ✅ Marked `isRecurring: Yes`, reference `RP{recurringId}…` |
| Cancel | ✅ `PUT status: "Completed"` + `DELETE …/recurring-payment/{id}/archive` |
| Use dashboard plans #84 / #85 from the API | ❌ Not exposed. FarriTech sends the amount and period itself. |

## Still to confirm before building

1. A cancelled (Completed + archived) subscription does **not** charge on its old next date. Check test subscriptions 1771 / 1772 in the sandbox on **2026-12-18**.
2. What Kadima does when a recurring charge is **declined**: retries, timing, final status. Run a sandbox test with a declining card.
3. That **recurring charges trigger the webhook**. This needs the FarriTech-side webhook check finished first (the "Last notification" line in Settings).
4. That the **hosted card form** (`/api/customer-vault-card/form`) returns the farrier to FarriTech in a way we can confirm.

## What gets built (landing-page repo)

| Piece | Notes |
|---|---|
| `api/kadima-subscribe-link` | Makes the signed, expiring per-farrier link (used by the trial-email job) |
| Subscribe page | Plan choice and promo code, then the Kadima hosted card form |
| `api/kadima-subscription` | Creates the vault customer and recurring payment; also cancel and switch plan |
| `api/kadima-subscription-webhook` | Confirms each charge with Kadima, then updates Firestore |
| Trial-email job | Day-25 and day-30 emails link to the subscribe page instead of Stripe's billing page |
| Signup | Stops creating a Stripe customer for new signups |
| FarriTech app | Reads the subscription status and applies the decision above |

**Secrets:** FarriTech's Kadima token is stored only in Vercel environment variables, never in code.

## Not changing

- Existing Stripe subscribers keep billing through Stripe until you decide otherwise. Moving their cards needs either their re-entry or Stripe's card-data export.
- The farrier-facing Kadima payment option, for farriers charging their own customers, is separate work. See `KADIMA-INTEGRATION-PLAN.md`.

## Order of work

1. Finish the open checks above (sandbox only).
2. Build the server pieces, with tests.
3. Build the subscribe page and the manage-subscription page.
4. Change the trial emails and stop creating Stripe customers for new signups.
5. Run the whole flow end to end in the sandbox.
6. Your review, then go live with FarriTech's live Kadima account.
