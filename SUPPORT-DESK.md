# FarriTech Support Desk

A separate support app at **app.farritech.com/support** (`support.html`). It uses the same
Firebase data as the main app, but only FarriTech support staff can use it.

## What it does

- **Farriers**: every farrier with an account shows up on their own, newest first. You can also
  **+ Add** someone who hasn't signed up yet. Each farrier has support info (contact, stage, notes),
  their tickets, their account details (signup date, setup wizard, calendar, subscription), and
  **Log in as farrier**, which opens the main app in a 30-minute support session.
- **Tickets**: subject, status (Open / Waiting on farrier / Resolved / Closed), priority and
  category. Each ticket keeps a conversation with four kinds of entry:
  - 📝 **Internal note**: only support sees it.
  - 📞 **Log a call** and ✉️ **Log an email**: a record of the conversation.
  - 💬 **Send text**: sends an SMS through FarriTech's Twilio number. When the farrier texts
    back, `api/twilio-webhook.js` adds the reply to their open ticket, marks it unread and sets
    it back to Open.

## Deleting a farrier

Open a farrier → **Delete** card at the bottom → **Delete farrier…**. The dialog counts what will
go, you type the farrier's email (or business name) to confirm, and it permanently deletes:

- their horses, customers, invoices (and each invoice's payments), appointments, services,
  mileage logs, inventory items and inventory transactions
- their payment keys and Google Calendar token (`farrierSecrets`)
- their business's team memberships and invites (team members keep their own logins but lose access)
- their horse photos in Storage (best effort)
- optionally, the support record, notes and tickets
- their farrier profile, last of all. If something fails part-way the farrier stays in the list,
  and running **Delete** again finishes the job.

What it does **not** do:

- **Their login.** Without a service-account key the app can't delete a Firebase Auth user. Delete
  it by hand in Firebase console → Authentication → Users, or they can sign in again and start a
  blank account.
- **Cancel their subscription.** The dialog warns if one exists; cancel it in Stripe.
- Anything outside Firestore and Storage (for example emails already sent).

This needs the updated `firestore.rules` published (it lets support admins read and delete these
records). A farrier who isn't a business owner has no shared records; only their own are deleted.

## Who can see it

Support data lives in its own collections: `supportFarriers`, `supportTickets` and
`supportTickets/{id}/messages`. The Firestore rules let only support admins (and the server,
which logs text replies) read or write them. Farriers can't see any of it, and nothing is
written to a farrier's own `farriers/{uid}` profile.

## Setup

1. **Publish the rules.** Paste `firestore.rules` into Firebase console → farrier-pro →
   Firestore Database → Rules → **Publish**. Until you do, the support desk can't load tickets.
2. **Make someone support staff.** In Firestore, create the document `supportAdmins/{their uid}`
   with `active: true`. Their uid is under Authentication → Users. Set `active: false` to remove
   their access.
3. **Sign in** at app.farritech.com/support with email/password or Google. Support staff also
   get a **🛟 Support** button in the main app's header. The old `/?support` link now opens
   the support desk.
4. **Text replies** need the Twilio messaging service's incoming-message webhook to point at
   `https://app.farritech.com/api/twilio-webhook`. That's the same webhook that already handles
   customers' CONFIRM and STOP replies.
