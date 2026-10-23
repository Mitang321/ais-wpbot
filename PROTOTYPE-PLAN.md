# WhatsApp Bot — Prototype v0 Plan

The smallest version that works end to end. The full design in
[PLAN.md](PLAN.md) stays the long-term target. This file covers only the first
prototype.

## What v0 does

1. A dealer sends a WhatsApp message to your Meta number, and it shows up in a
   web **dashboard**.
2. You can **reply** from the dashboard, or start a chat with a template message.
3. An **auto-reply bot** (on/off switch in the dashboard) answers product
   searches from the AIS catalog: model, key attributes, and a link to
   `ais.mitangs.tech`. **No prices in v0**, so nothing can leak while the
   dealer-linking flow doesn't exist yet.

Not in v0: dealer linking, prices, notifications, campaigns.

## The split: what runs where

```
                 ┌────────────── Vercel (free) ──────────────┐
  You (browser) ─►  dashboard: static Vite + React + Tailwind │
                 └──────────────────────┬────────────────────┘
                                        │ HTTPS, bearer token
                                        ▼
 Meta Cloud API ──webhook──►  ┌──── Coolify (Oracle ARM) ────┐      anyway-sync worker
        ▲                     │  wa-server: one Node process │ ───► bot_catalog (read-only,
        └───── send ◄─────────│  • webhook + small REST API  │      HMAC) → KV catalog
                              │  • SQLite file on a volume   │
                              └──────────────────────────────┘
```

**Why the backend can't live on Vercel:** Vercel functions could technically
receive the webhook. What Vercel can't do is keep **state**: no local disk for
the message history, and no always-on process holding the catalog in memory.
So the Coolify container holds only that state plus the webhook. Everything
visual lives on Vercel and is just static files, with no Vercel server code at all.

## Coolify side: `server/`

**Stack, picked for the lowest footprint:**
- **Node 24** (`node:24-alpine`, arm64) with the **built-in `node:sqlite`**. No
  native module to compile, so the image is small.
- **Hono** as the only runtime dependency. Bundled with esbuild into one file.
- **Coolify limits: 128 MB RAM, 0.25 CPU.** Expected use is about 40–60 MB.

**Endpoints**

| Route | Purpose |
|---|---|
| `GET /webhook` | Meta verification (`hub.verify_token` → `hub.challenge`) |
| `POST /webhook` | check `X-Hub-Signature-256`, store message/status, return 200 at once, then auto-reply if on |
| `POST /api/login` | dashboard password → signed token (12h) |
| `GET /api/conversations` | contacts, newest first, with last message and unread count |
| `GET /api/conversations/:phone` | messages for one contact |
| `POST /api/send` | free-text reply (only inside the 24h window) |
| `POST /api/send-template` | template message (e.g. Meta's default `hello_world`), works any time |
| `GET/PUT /api/settings` | auto-reply on/off |
| `GET /health` | Coolify healthcheck |

CORS allows only the Vercel dashboard origin.

**SQLite (`/data/wa.db`)**
- `contacts(phone, name, last_inbound_at, unread)`
- `messages(wa_id, phone, direction, type, text, status, ts)`. Status
  (sent → delivered → read) is updated from webhook status events, and `wa_id`
  is unique, so Meta's retries are deduped for free.
- `settings(key, value)`

**Auto-reply logic:** text message comes in → if bot is on → search the cached
catalog (simple token match on model, part no, series and attributes) → reply
with the top 3, or "no match, type *menu*" → log the reply as an outbound message.
The catalog is pulled from the worker on boot and refreshed every 5 minutes.

**Env vars:** `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`,
`WA_VERIFY_TOKEN`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `DASHBOARD_ORIGIN`,
`WORKER_URL`, `BOT_SHARED_SECRET`

## Worker side: one small addition

The `/catalog` route needs a dealer's Firebase ID token, which the server
doesn't have. Add **one read-only action** to `anyway-sync`:
`{action:'bot_catalog', category?}` with an HMAC header (`BOT_SHARED_SECRET`).
- Without a category it returns the category list.
- With a category it streams `catalog:<CATEGORY>` from KV.

No KV writes, no prices. Deploy it to staging first.

## Vercel side: `dashboard/`

- Vite + React + Tailwind, the same stack as the AIS admin panel.
- Pages:
  - **Login:** one password field.
  - **Inbox:** contact list on the left, chat on the right, reply box at the bottom.
    The reply box is disabled outside the 24h window, with a "Send template"
    button instead.
  - **New chat:** phone number + template.
  - **Header:** auto-reply switch.
- Updates by **polling every 5 seconds** (simplest; can move to SSE later).
- Env: `VITE_API_URL=https://wa-api.mitangs.tech`. Vercel root directory = `dashboard`.

## Repo layout

This folder becomes its own git repo (simpler than the monorepo for a
prototype; it can move into `ais-app/apps/` later):

```
whatsapp-bot/
├─ server/      → Coolify (Dockerfile build pack, base dir /server, port 3000, volume /data)
├─ dashboard/   → Vercel (root dir /dashboard)
└─ PLAN.md, PROTOTYPE-PLAN.md
```

## Meta checklist (you)

- [ ] **Permanent token.** The token on the Meta "API Setup" page **expires
      after 24 hours**. Create a **System User** in Business Settings, give it
      the app + WhatsApp account, and generate a token with
      `whatsapp_business_messaging` and `whatsapp_business_management`.
- [ ] Note the **Phone Number ID** (not the phone number itself) and the **App Secret**.
- [ ] If you're on the **test number**, add up to 5 recipient numbers (yours and
      a dealer friend's) under "To".
- [ ] After step 3 below: set the webhook URL `https://wa-api.mitangs.tech/webhook`
      + verify token, and subscribe to the **messages** field.

## Build order (each step is testable on its own)

| # | Step | Done when |
|---|---|---|
| 1 | `server/`: webhook + SQLite + send, run locally behind a `cloudflared` tunnel | message from your phone lands in SQLite, and `curl /api/send` replies |
| 2 | Dockerfile + Coolify app + DNS `wa-api.mitangs.tech` | Meta webhook verifies against the Coolify URL; RAM < 60 MB |
| 3 | `dashboard/` on Vercel: login, inbox, reply, template | full chat from the browser |
| 4 | Worker `bot_catalog` (staging → prod) + auto-reply search | "hp i5" on WhatsApp → top 3 products + link |
| 5 | Try it with 2–3 real dealers | a day with no errors in Coolify logs |

**Rough effort:** steps 1–3 take about a day, and step 4 about half a day.

## Things to know

- **24-hour rule:** free-text replies only work within 24h of the dealer's last
  message. Outside it, you can only send approved templates.
- **Cost:** replying to dealers who message you is free. Templates you start
  are billed per message (a few paise for utility templates).
- **Prototype security:** one shared dashboard password. Before more people use
  it, swap it for the Clerk admin login from the AIS admin panel.
