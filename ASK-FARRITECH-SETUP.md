# Ask FarriTech (AI assistant) — setup

A tab in the desktop app where the owner or a manager types a question and gets an answer:

- "Who owes me money this week?"
- "How many active customers do I have?"
- "How many horses did I shoe last week?"
- "How much did I collect last month?"
- "What is my average invoice?"
- "Did I ever shoe a horse named Bonnie?"
- "What farms do I have in Loxahatchee?"

## Turn it on (one step)

1. Get an API key at https://console.anthropic.com → API keys.
2. Vercel → Project → Settings → Environment Variables → add `ANTHROPIC_API_KEY`.
3. Redeploy.

Until the key is set, the tab shows "The AI assistant isn't switched on yet."

Optional: `ASK_AI_MODEL` changes the model (default `claude-opus-5-5`). `claude-haiku-5-5` is much
cheaper and fine for these simple questions; try it if cost matters.

## How it works

1. The browser sends the question to `/api/stripe-payment` (`action: 'ask_ai'`). It lives there, not
   in its own file, because Vercel Hobby allows only 12 functions per deploy.
2. `api/_lib/ask-ai.js` gives Claude three read-only tools (`api/_lib/ask-tools.js`):
   money owed, customer counts, horses worked on. Claude only chooses a tool and a date range.
3. The tool does the counting in plain code from the business's own records. Claude words the result.
   Every figure comes from a tool, never from the model, and "Show the numbers" under each answer
   displays them.

**Privacy:** records are read with the signed-in person's own Firebase token, so Firestore's rules
decide what is visible, exactly as in the app. Team members with the `farrier` role can't use it
(it covers business-wide money, like Reports). It can't change any data.

## Definitions (worth knowing when reading an answer)

- **Owed:** unpaid and part-paid invoices, remaining balance at the cash price; cancelled excluded.
- **Active customer:** has an invoice or non-cancelled appointment in the last 180 days. FarriTech has
  no "active" flag on customers, so this is the definition used.
- **Horses worked on:** distinct horses on non-cancelled invoices dated in the range (invoice date,
  in the browser's time zone). Work that was never invoiced isn't counted. "Shoe" = the shoeing
  services in the by-service breakdown (not trims); the answer says which it counted.
- **Collected:** money received, counted on the day each payment was made (card payments include the
  card price), cancelled invoices left out, refunds shown separately, with "invoiced in the same
  period" for comparison. Same rules as the Business Dashboard.
- **Horses worked on** counts a "Multiple horses" invoice line by its quantity (those horses have no
  names, so they can't be matched to each other).
- **Invoice size** (`get_invoice_stats`): count, total, average, median, largest and smallest for a
  period (or all time), non-cancelled invoices by invoice date, paid or not.
- **One horse** (`find_horse`): looks up a name on invoices and in Horses, lists each horse with that
  name (different owners), the services and dates. Partial names work.
- **Farms by place** (`find_customers`): matches the city, ZIP or street saved on the customer record
  (and name / farm name). A customer with no address on file won't match a place search. It returns
  name, farm, city and address, never phone or email.
- Weeks run Monday–Sunday.

## Adding a question type

Add a function to `api/_lib/ask-tools.js`, list it in `TOOLS` (name, description, schema, which
collections it `needs`), add any new fields it reads to `COLLECTIONS` in `api/_lib/ask-ai.js`, and add a test to `scripts/ask-ai.test.mjs`. Run:

```
node --test scripts/ask-ai.test.mjs
```

## Limits

- 15 questions a minute per person (a spend guard), 500 characters per question.
- Desktop app only for now (not `mobile.html`).
