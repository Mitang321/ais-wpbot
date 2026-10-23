# AIS WhatsApp Bot — Final Plan

Dealer-facing WhatsApp bot for the ANYWAY IT SOLUTIONS dealer price-list
system (`ais-app`). Official **WhatsApp Cloud API**, one small container on the
Oracle (ARM) Coolify server, talking to the existing `anyway-sync` Cloudflare
Worker. No code yet — this is the agreed design.

---

## 1. Goals and non-goals

**Phase 1 (pilot)**
- An approved dealer messages the bot's number, searches products in plain text
  ("hp i5 16gb"), browses categories from a menu, and sees prices **only if**
  they are on the `price_viewers` allow-list — exactly the same rule the app uses.
- Unknown and pending numbers get a polite, fixed reply pointing them to the app.

**Phase 2**
- Outbound notifications through approved templates: account approved,
  price drops on wishlisted products, and admin campaigns ("also send on WhatsApp").
- "Talk to sales" handoff to a staff number.

**Non-goals:** the bot doesn't replace the app, doesn't take orders or payments,
and never writes to the sheet.

---

## 2. Architecture

```
Dealer's WhatsApp
      │
      ▼
Meta WhatsApp Cloud API ──webhook (HTTPS, signed)──►  whatsapp-bot  (Coolify, Oracle ARM)
      ▲                                                 • Node 22 + Hono, one process
      └──────────── Graph API send ◄────────────────────• SQLite on a volume
                                                        • in-memory catalog + search index
                                                              │  HMAC-signed POSTs
                                                              ▼
                                                   anyway-sync worker (Cloudflare)
                                                        • new bot_* actions
                                                        • Firestore (users, price_viewers,
                                                          product_prices) + KV catalog
```

**Rules that keep this safe and cheap:**
1. **The worker stays the only authority.** The bot has no Firebase service
   account, no Firestore access and no Clerk keys. It asks the worker, and the
   worker applies the same price-visibility rule as Firestore security rules.
2. **The bot never writes KV.** The free plan allows 1,000 KV writes/day and the
   sync already uses that budget (see OPERATIONS.md → Sep 2026). Every bot_*
   action is KV **read**-only.
3. **The bot caches aggressively** so most messages cost 0 Firestore reads.

---

## 3. Dealer identity: the "Link WhatsApp" flow

`User.mobile` already exists, but it's a *plain, editable profile field*, so
it can't be trusted to decide who sees prices: a dealer could type someone
else's number. WhatsApp verifies the **sender's** number, so we only need to
prove the sender owns the **account**:

1. In the dealer app (Profile), a **"Link WhatsApp"** button calls the worker
   `{action:'bot_link_code', token}`. The worker mints a short single-use code
   (e.g. `LINK-7F3K9Q`, 10-minute expiry, stored in Firestore — **not KV**).
2. The app opens `https://wa.me/<bot number>?text=LINK-7F3K9Q`. The dealer just
   taps Send.
3. The bot receives it and calls `{action:'bot_link_confirm', phone, code}`. The
   worker writes `whatsappPhone` + `whatsappLinkedAt` on the user doc and
   deletes the code.
4. From then on, `whatsappPhone` (verified) is the lookup key. The admin panel
   shows it on the dealer page and has an **Unlink** button.

New shared fields go in `@mitang/shared` (`User.whatsappPhone?`,
`User.whatsappLinkedAt?`, `User.whatsappOptOut?`, and a `bot_link_codes`
collection path). Firestore rules: dealers can't write these fields; only the
worker (service account) does.

---

## 4. Worker additions (`workers/sync`)

Same POST `{action}` contract as the existing endpoint. Every bot action
requires these headers:
`X-Bot-Timestamp` + `X-Bot-Signature = HMAC-SHA256(BOT_SHARED_SECRET, ts + body)`,
rejected if the timestamp is more than 5 minutes off (blocks replays).

| Action | Caller | Does | Cost |
|---|---|---|---|
| `bot_link_code` | dealer app (Firebase ID token) | mint link code | 1 write |
| `bot_link_confirm` | bot | verify code → set `whatsappPhone` | 1 query + 2 writes |
| `bot_lookup` | bot | phone → `{uid, name, company, status, pricesAllowed, optOut}` | 1 query + 1 read |
| `bot_meta` | bot | `{catalogVersion, categories[]}` from `app_config/global` | 1 read |
| `bot_catalog` | bot | stream `catalog:<CATEGORY>` from KV | 1 KV read |
| `bot_prices` | bot | `{uid, productIds[≤10]}` → price columns, **only if** `price_viewers/{uid}` exists | 1 + n reads |
| `bot_opt_out` | bot | set/clear `whatsappOptOut` | 1 write |

New worker secrets: `BOT_SHARED_SECRET`, plus `BOT_URL` for phase 2 (worker →
bot pushes). Mirror them in `[env.staging]`.

---

## 5. The bot service

**Where the code lives:** `ais-app/apps/whatsapp-bot` in the monorepo, so it
imports `@mitang/shared` types and paths instead of redefining them (repo
rule). Coolify builds it with a Dockerfile in that folder. This folder
(`Personal/whatsapp-bot`) only holds this plan.

**Stack (chosen for low RAM):**
- Node 22, TypeScript bundled with esbuild into a single file (like `functions/`)
- `hono` + `@hono/node-server`: HTTP
- `better-sqlite3`: state
- `minisearch`: in-memory product search
- Built-in `fetch` for the Graph API (no Meta SDK)

**Endpoints**
- `GET /webhook`: Meta verification (`hub.verify_token` → echo `hub.challenge`)
- `POST /webhook`: check `X-Hub-Signature-256` against the app secret →
  reply **200 immediately** → handle the message asynchronously
- `POST /internal/send`: phase 2, HMAC-signed calls from the worker
- `GET /health`: for the Coolify healthcheck

**Message pipeline**
1. Dedupe by WhatsApp message id (SQLite, kept 24h), because Meta retries webhooks.
2. Per-phone rate limit (e.g. 20 messages/min) to protect worker and Firestore.
3. Identify: SQLite cache `phone → lookup` (15-minute TTL), otherwise `bot_lookup`.
4. Route:
   - `LINK-xxxxxx` → link flow
   - not linked → "Register / link in the app" + CTA button to `ais.mitangs.tech`
   - pending or rejected → status message
   - `menu` / `hi` → **list message** of categories (10 rows max, paged)
   - category tap → section list → products
   - free text → search → top 5 results
   - `stop` / `start` → opt out / opt in of notifications
   - `help`
5. Reply: model, part no and key attributes, then prices (when allowed) from
   `bot_prices`, then a CTA URL button to the product in the app.

**Catalog cache:** on boot and every 2 minutes, call `bot_meta`. When
`catalogVersion` changes, re-pull changed categories via `bot_catalog` and
rebuild the MiniSearch index in memory. Prices are **never** cached for more
than 60 seconds and never written to logs.

**SQLite tables:** `seen_messages`, `dealer_cache`, `rate_limits`,
`conversations` (last menu state per phone, for "next page"), and
`outbound_log` (phase 2).

---

## 6. Meta / WhatsApp setup (manual tasks for you)

1. **Meta Business portfolio** for ANYWAY IT SOLUTIONS → start **business
   verification** (GST certificate and business address). Start this first,
   because it can take days.
2. **Meta app** (type Business) → add the WhatsApp product. Use the **free test
   number** for development (it can message up to 5 verified recipients).
3. **Production number:** a dedicated SIM that is **not** registered on the
   WhatsApp or WhatsApp Business app (or migrate it off). Set the display name
   "Anyway IT Solutions" (needs approval).
4. **System user** with a **permanent access token**
   (`whatsapp_business_messaging`, `whatsapp_business_management`).
5. **Webhook:** `https://bot.ais.mitangs.tech/webhook`, subscribe to `messages`.
6. **Templates** (phase 2, submit early because approval takes time):
   `account_approved` (utility), `price_drop` (utility),
   `campaign_generic` (marketing, with an opt-out line).

**Cost model:** replies inside the 24-hour window after a dealer messages you
are free, so all of phase 1 costs ₹0 from Meta. Outbound template messages are
billed per message (utility is a few paise, marketing is more). Check Meta's
current India rate card before turning on campaigns.

---

## 7. Deployment on Coolify (Oracle ARM)

- **DNS:** `bot.ais.mitangs.tech` → A record to the Oracle VM's public IP.
  Coolify's Traefik issues a Let's Encrypt cert. Check that ports 80/443 are open
  in the OCI security list and the VM firewall.
- **Image:** multi-stage, `node:22-alpine`, **linux/arm64**. Build
  `better-sqlite3` in the build stage. Runtime has production deps only plus the
  bundle, target < 150 MB. Run as a non-root user.
- **Run:** `node --max-old-space-size=128 dist/index.js`
- **Coolify limits:** memory **256 MB**, CPU **0.5**, restart `unless-stopped`.
- **Volume:** `/data` (SQLite). Back it up with Coolify's scheduled backup or a nightly copy.
- **Healthcheck:** `GET /health` every 30s.
- **Env:** `WA_PHONE_NUMBER_ID`, `WA_WABA_ID`, `WA_ACCESS_TOKEN`,
  `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WORKER_URL`, `BOT_SHARED_SECRET`,
  `APP_BASE_URL=https://ais.mitangs.tech`, `LOG_LEVEL`
- **Deploy:** Coolify GitHub app on the `ais-app` repo, base dir
  `apps/whatsapp-bot`, auto-deploy on `main`. Add a CI job (typecheck + tests)
  to the existing `ci.yml`.

**Expected footprint:** ~40–60 MB RAM idle, ~80–100 MB with a few thousand
products indexed, and close to 0% CPU between messages.

**Staging:** run locally against `anyway-sync-staging` with the Meta test
number, exposed through a `cloudflared` tunnel. No second Coolify app is
needed until later.

---

## 8. Security checklist

- Verify the Meta webhook signature on every POST and reject unsigned requests.
- HMAC plus timestamp in both directions between bot and worker.
- Prices come only from `bot_prices`, which re-checks `price_viewers` every time.
- Admin "Unlink" / dealer status change → worker bumps the user, and the bot's
  15-minute cache expires (phase 2: worker pushes an invalidation to the bot).
- No prices, tokens or full phone numbers in logs (mask to `+91•••••1234`).
- Respect `stop`, and never send templates to opted-out dealers.

---

## 9. Build order (with "done when")

| # | Step | Done when |
|---|---|---|
| 0 | Meta setup §6 steps 1–2 (you) | test number can send you "hello_world" |
| 1 | Shared types + Firestore rules for `whatsappPhone`, link codes | rules tests in `dev-tools` pass |
| 2 | Worker `bot_*` actions + HMAC | curl with a signature works on staging and fails without one |
| 3 | Bot skeleton: webhook verify, signature, dedupe, echo, `/health` | Meta webhook verified; test message echoes back |
| 4 | Deploy skeleton to Coolify | echo works via `bot.ais.mitangs.tech`; RAM < 80 MB |
| 5 | Link flow (app button + bot + admin column/unlink) | a dealer links in 2 taps; admin sees the number |
| 6 | Menu, search, prices | allowed dealer sees prices; non-allowed sees none |
| 7 | Hardening: rate limit, opt-out, masking, backups | checklist §8 ticked |
| 8 | **Pilot** with 3–5 dealers on the production number | a week with no errors |
| 9 | Phase 2: templates + worker → bot notifications + admin toggle | approval and price-drop messages arrive |

---

## 10. Open questions

1. Which SIM / number will the bot use, and is it free of the WhatsApp app?
2. Can you start Meta business verification now (GST docs ready)?
3. Is `mitangs.tech` DNS on Cloudflare (so you can add `bot.ais`)?
4. How much free RAM does the Coolify VM have right now?
5. Which product attributes should a WhatsApp reply show (keep it to 3–4 lines)?
