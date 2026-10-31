# Teams: several farriers in one business

A business owner can add the farriers who work for them. Each farrier signs in with their own
login and works in the owner's business: same customers, horses, services, inventory and
invoices, and card payments go into the owner's payment account (iPOSpays or Stripe).

A farrier who never adds anyone is a business of one. **Nothing changes for them.**

## Roles

| | Owner | Manager | Farrier |
|---|---|---|---|
| Customers, horses, appointments, invoices, take payments, pay links | ✅ | ✅ | ✅ |
| Refund / void, waive the card price | ✅ | ✅ | ❌ |
| Reports (business revenue) | ✅ | ✅ | ❌ |
| Settings: business profile, payment accounts, manager password, team | ✅ | ❌ | ❌ |

The server enforces the payment rules (`api/stripe-payment.js` → `api/_lib/team.js`); the apps
also hide what a role can't use. Mileage stays personal: each farrier logs and sees their own.

## Adding a farrier (desktop → Settings → Team)

Enter their name, email and role, then **Add to team**.

- **New email:** FarriTech makes their login. They get a "You've been added" email, plus a
  separate email to set their password (or they use **Sign in with Google** with that address).
- **Email that already has a FarriTech login:** they join the next time they sign in. A login
  that already runs its own FarriTech business can't join another one; use a different email.

Removing someone takes effect on their next page load.

## Where it's stored (written only by the server)

- `businessMembers/{memberUid}` → `{ businessId, role, email, name }`. The owner has no doc;
  their uid is the business id, and shared records keep `farrierId = businessId`.
- `businessInvites/{email}` → pending invites for existing logins.
- New invoices and appointments get `performedBy` (who did the work) for per-farrier reports.

## Before it works: publish the Firestore rules

`firestore.rules` gives team members access to their business's records and lets the server
write memberships. Paste the whole file into Firebase console → farrier-pro → Firestore Database
→ Rules → **Publish**. The new rules only add access; nothing a farrier could do before changes.
Until they're published, adding a farrier fails with an error and nothing else is affected.

## Coming next

Per-farrier views (my appointments / everyone, Day Route), owner reports by farrier, Google
Calendar per farrier, and optionally a separate iPOSpays TPN per farrier.
