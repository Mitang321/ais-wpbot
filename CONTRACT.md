# Prototype v0 — Interface Contract

The single source of truth that `server/`, `dashboard/` and the `anyway-sync`
worker addition are all built against. See [PROTOTYPE-PLAN.md](PROTOTYPE-PLAN.md)
for the why.

## 1. Server REST API (`server/`, Coolify, port 3000)

Base URL in production: `https://wa-api.mitangs.tech`.
All `/api/*` routes except `/api/login` need `Authorization: Bearer <token>`.
All bodies and responses are JSON. Errors: `{ "ok": false, "error": "<code>", "message": "<human text>" }`
with a 4xx/5xx status. CORS: only `DASHBOARD_ORIGIN` (comma-separated list allowed), methods GET/POST/PUT/OPTIONS,
headers `Authorization, Content-Type`.

Phone numbers are WhatsApp IDs: digits only, country code included, no `+` (e.g. `919812345678`).
Timestamps are Unix **milliseconds**.

| Method & path | Request | Response |
|---|---|---|
| `GET /health` | – | `{ ok: true, uptimeSec, rssMb, catalog: { products, categories, loadedAt } }` |
| `GET /webhook` | `hub.mode`, `hub.verify_token`, `hub.challenge` | `200` text challenge, or `403` |
| `POST /webhook` | Meta payload, `X-Hub-Signature-256` | always `200` fast after the signature checks out (`401` if bad) |
| `POST /api/login` | `{ password }` | `{ ok: true, token, expiresAt }` (12h) or `401` |
| `GET /api/conversations` | – | `{ ok: true, conversations: Conversation[] }` newest activity first |
| `GET /api/conversations/:phone` | `?before=<ts>` optional | `{ ok: true, contact: Conversation, messages: Message[] }` oldest→newest, last 200; also marks it read |
| `POST /api/send` | `{ to, text }` | `{ ok: true, message: Message }`. `409 window_closed` when the last inbound message is more than 24h old |
| `POST /api/send-template` | `{ to, template, language? }` (default `en_US`) | `{ ok: true, message: Message }` |
| `GET /api/settings` | – | `{ ok: true, settings: Settings }` |
| `PUT /api/settings` | partial `Settings` | `{ ok: true, settings: Settings }` |

```ts
interface Conversation {
  phone: string;
  name: string | null;          // WhatsApp profile name from the webhook
  lastMessageAt: number;
  lastMessagePreview: string;
  lastInboundAt: number | null; // drives the 24h window
  windowOpen: boolean;          // lastInboundAt within 24h
  unread: number;
  allowed: boolean;             // phone is in settings.allowedPhones
}
interface Message {
  id: string;                   // WhatsApp message id (wamid…) or local id for failed sends
  phone: string;
  direction: 'in' | 'out';
  type: 'text' | 'template' | 'interactive' | 'image' | 'other';
  text: string;                 // body, template name, or "[image]" etc.
  status: 'received' | 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  auto: boolean;                // true when the bot sent it
  ts: number;
}
interface Settings {
  autoReply: boolean;           // default false
  allowedPhones: string[];      // auto-reply only to these numbers (protects catalog data)
}
```

## 2. Auto-reply behaviour

Runs only when `autoReply` is on **and** the sender is in `allowedPhones`.
Other senders are stored and shown in the inbox, but get no reply.

- `hi` / `hello` / `menu` / `help` → greeting + list of categories + "type a model to search".
- Any other text → search the catalog (case-insensitive token match over `modelNumber`, `partNo`, `series`, `sectionTitle`
  and attribute values; every query token must match; rank by number of fields hit) → top 3:
  ```
  *<modelNumber>*  (<category>)
  <first 3 attrs as "k: v">
  https://ais.mitangs.tech/product/<id>
  ```
  If nothing matches: "No match for "<q>". Try a model number, or type *menu*."
- **Never** includes prices (v0 has none).

## 3. Worker addition (`ais-app/workers/sync`)

New POST action on the existing endpoint, `https://anyway-sync.mitang-sync-worker.workers.dev`.

Request headers:
- `X-Bot-Timestamp: <unix ms>`
- `X-Bot-Signature: <lowercase hex HMAC-SHA256(BOT_SHARED_SECRET, "<timestamp>.<raw body>")>`

The worker rejects with `401` if the secret isn't configured, the signature is wrong (constant-time compare),
or the timestamp is more than 5 minutes off.

| Body | Response |
|---|---|
| `{ "action": "bot_catalog" }` | `{ ok: true, categories: string[] }` |
| `{ "action": "bot_catalog", "category": "LAPTOP" }` | the stored KV JSON as-is: `{ category, version, products: [{ id, modelNumber, partNo?, series?, sectionTitle?, attrs: [{k,v}], rowIndex, updatedAt }] }`, or `404` if not synced |

**Read-only:** zero KV writes and zero Firestore writes. New secret: `BOT_SHARED_SECRET` (prod + staging).

The server refreshes: categories list → each category, on boot and every 5 minutes, with the whole catalog kept in memory.
