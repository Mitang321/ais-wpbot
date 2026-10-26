# Indian Store Marseille — WhatsApp ordering bot (demo)

This replaces the AIS catalog bot. It uses the same server (`server/`, Coolify, `https://wa-api.apps.mitangs.tech`),
the same dashboard (`dashboard/`, Vercel) and the same Meta test number. Everything in CONTRACT.md §1 **stays as is**:
webhook, login, conversations, send, send-template, settings, error shape, CORS and auth.
The AIS worker catalog is removed: `catalog.ts`, `WORKER_URL`, `BOT_SHARED_SECRET` and `APP_BASE_URL`.

Shared types live in `server/src/types.ts` (Product, Run, RunSummary, OrderItem, Order). The dashboard mirrors them in
`dashboard/src/types.ts`. Money is in EUR **cents** (integers). Times are Unix **ms**. The display timezone is
`Europe/Paris`. The store name comes from env `STORE_NAME` (default `Indian Store Marseille`).

## 1. New REST endpoints

All of them need `Authorization: Bearer`, use JSON, and return the same error shape.
CORS `allowMethods` must add `DELETE`.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/products` | – | `{ ok, products: Product[] }`: active and inactive, ordered by sort, then name |
| `POST /api/products` | `{ name, category, unit, packLabel?, packGrams?, priceCents, aliases? }` | `{ ok, product }`; id = slug of the name, made unique |
| `PUT /api/products/:id` | partial of the POST fields + `active?` | `{ ok, product }` |
| `GET /api/runs` | – | `{ ok, runs: RunSummary[] }`, newest deliveryDate first |
| `POST /api/runs` | `{ town, deliveryDate, deliveryTime, pickupSpot, cutoffAt, vegCutoffAt? }` | `{ ok, run }` with status `open` |
| `PUT /api/runs/:id` | partial of the POST fields + `status?` | `{ ok, run }` |
| `GET /api/runs/:id/orders` | – | `{ ok, run: Run, orders: Order[] }`, oldest first, cancelled included |
| `POST /api/orders` | `{ runId, customerName, phone?, items: [{productId, qty}], note? }` | `{ ok, order }` with source `manual` |
| `PUT /api/orders/:id` | `{ status?, paid?, note?, items?: [{productId, qty}] }` | `{ ok, order }`; items are re-priced from the current products |
| `POST /api/runs/:id/broadcast` | `{ text }` | `{ ok, sent, skipped, failed }`: sends free text to the phone of every non-cancelled order whose phone has an open 24h window. Orders without one are skipped. |

`GET /health` keeps `{ ok, uptimeSec, rssMb }` and replaces `catalog` with `store: { products, runs, orders }`.

## 2. Settings

`Settings` stays `{ autoReply, allowedPhones }`. **The default is now `autoReply: true`.** The bot replies when
`autoReply` is on and `allowedPhones` is either empty **or** contains the sender.

## 3. Active run

The active run is the `open` run with the earliest `deliveryDate` that is today or later (Paris date).
If there is none, it's the most recent `open` run. If there is none of those either, there's no active run.
A category is closed when `now > cutoffAt`. For category `Vegetables` it is also closed when
`vegCutoffAt` is set and `now > vegCutoffAt`.

## 4. Bot conversation

State is kept per phone in the SQLite `sessions` table.

Text commands are case-insensitive and trimmed, and punctuation is tolerated.

- **Greeting** (`hi|hello|hey|namaste|namaskar|menu|start|help`): send the store name, the active run (town,
  "Friday 6 November, evening around 6pm", pickup spot) and its cutoffs ("🥗 Vegetables: order before
  Sat 31 Oct, 6pm" / "🛒 Everything else: before Thu 5 Nov, 6pm"). Then explain how to order:
  "Just type your order, e.g. *kaju katli 250g, okra 1kg, 1 bag basmati*", and list the commands
  *list* (products & prices), *my order* and *cancel*. With no active run, reply "No delivery scheduled right now…".
- **`list|products|price|prices|catalog`**: send active products grouped by category, as
  `• Okra – €4.50/kg` or `• Kaju katli (250 g box) – €6.00`. Mark closed categories "(closed)".
  Split into several messages if the text is over 3500 chars.
- **`my order|order|status`**: show the sender's current order for the active run, or "No order yet".
- **`cancel`**: cancel the sender's order for the active run, unless it is packed or collected.
- **Anything else** goes to `parseOrder()` (§5).
  - If no lines match, reply "Sorry, I couldn't find … in our list. Type *list* to see products."
  - Otherwise, drop lines whose category is closed and tell the customer. Build a draft and store it
    in the session (step `confirm`).
  - Send an **interactive reply-buttons** message. The body is a summary
    (`2 × Kaju katli (250 g box) — €12.00`, `1 kg Okra — €4.50`, the total, and any unmatched
    words as "⚠️ Not found: xyz"). The buttons are `confirm` "✅ Confirm" and `change` "✏️ Change".
- **Confirm** (button id `confirm`, or text `yes|y|ok|confirm|haan|ha|done`) while the step is `confirm`:
  - Merge the draft into the sender's existing non-cancelled order for that run, summing qty per
    product. If there is none, create one (source `bot`; name = WhatsApp profile name, else the phone).
  - Clear the session.
  - Reply "✅ Order #12 confirmed!" + items + total + "Pickup: <spot>, <day> <time>. Pay at pickup 🙏
    Send more items any time before the cutoff."
- **Change** (button id `change`, or `no|n|change`): clear the draft and reply "No problem, send your
  full order again."
- Session drafts expire after 2 h.

For inbound interactive button replies, `parseInbound` keeps `text` = the button title, and the bot uses
`m.interactive.button_reply.id` when present.

`WhatsAppClient.sendButtons(to, body, buttons: {id,title}[])` allows at most 3 buttons, titles of 20 chars
or fewer, and a body of 1024 chars or fewer. It sends `type: interactive`,
`interactive: { type: 'button', body: {text}, action: { buttons: [{type:'reply', reply:{id,title}}] } }`.
It is stored as message type `interactive`, with the body as its text.

## 5. Parser (`server/src/parser.ts`)

```ts
export interface ParsedLine { productId: string; qty: number; raw: string }
export interface ParseResult { lines: ParsedLine[]; unmatched: string[]; engine: 'gemini' | 'rules' }
export function parseOrderRules(text: string, products: Product[]): ParseResult;
export function parseOrder(text: string, products: Product[], opts: {
  geminiApiKey: string | null; geminiModel: string; log: Logger; fetch?: typeof fetch; timeoutMs?: number;
}): Promise<ParseResult>;
```

`qty` is in the product unit. Duplicate products are summed. When a key is set, Gemini is tried first
(env `GEMINI_API_KEY`; `GEMINI_MODEL`, default `gemini-2.5-flash-lite`). Any error, timeout (8 s) or
invalid output falls back to `parseOrderRules`.

## 6. Seed (`server/src/seed.ts`)

```ts
export const SEED_PRODUCTS: Product[];
export function demoRun(): Omit<Run, 'id' | 'createdAt'>;
export const DEMO_ORDERS: Array<{ phone: string; customerName: string; items: Array<{ productId: string; qty: number }> }>;
```

On boot, if the products table is empty, insert `SEED_PRODUCTS`, one demo run, and `DEMO_ORDERS`
into that run (source `manual`). Env `SEED_DEMO=false` turns off the demo run and orders.
