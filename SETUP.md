# Setup & Deploy — Prototype v0

Do these in order. Each step ends with a check, so you know it worked before you
move on. You'll generate three secrets once and reuse them:

```bash
node -e "for (const n of ['WA_VERIFY_TOKEN','SESSION_SECRET','BOT_SHARED_SECRET']) console.log(n+'='+require('crypto').randomBytes(32).toString('hex'))"
```

Keep them in a password manager. Never commit them.

---

## 1. Meta (WhatsApp Cloud API)

1. **developers.facebook.com → your app → WhatsApp → API Setup**: copy the
   **Phone number ID** (a long number, *not* the phone number) → `WA_PHONE_NUMBER_ID`.
2. **App settings → Basic → App secret** → `WA_APP_SECRET`.
3. **Permanent token.** The token on the API Setup page expires in 24h.
   - business.facebook.com → **Settings → Users → System users → Add** (role Admin).
   - **Assign assets**: your app (full control) + your WhatsApp account (full control).
   - **Generate token**: select the app, set expiry to **Never**, and tick
     `whatsapp_business_messaging` and `whatsapp_business_management` → `WA_TOKEN`.
4. **Test number only:** in API Setup → "To", add and verify each phone that
   should be able to message the bot (max 5).

The webhook is set up in step 4, after the server is live.

---

## 2. Cloudflare worker: `bot_catalog` action

The code is on branch `feat/bot-catalog` in `ais-app` (not pushed, not deployed).

```bash
cd ais-app/workers/sync
npx wrangler secret put BOT_SHARED_SECRET --env staging
npx wrangler deploy --env staging
```

Test on staging, then do the same for production (without `--env staging`)
and merge the branch the way you normally do.

**Check:** an unsigned request is refused:

```bash
curl -s -X POST https://anyway-sync.mitang-sync-worker.workers.dev -H "content-type: application/json" -d "{\"action\":\"bot_catalog\"}"
```

You should get a 401 error.

---

## 3. Coolify: `server/`

1. **DNS:** add an `A` record `wa-api.apps.mitangs.tech` → your Oracle VM's public IP.
   If it's on Cloudflare, start with **DNS only** (grey cloud) so Let's Encrypt
   can issue the cert. Make sure ports 80/443 are open in the OCI security list.
2. Push this repo (`whatsapp-bot`) to GitHub (private).
3. **Coolify → Project → New Resource → Private repository (GitHub App)** → pick the repo.
   - Build pack: **Dockerfile**
   - Base directory: `/server`
   - Port: `3000`
   - Domain: `https://wa-api.apps.mitangs.tech`
4. **Persistent storage:** add a volume mounted at `/data`.
5. **Resource limits (Advanced):** memory `128m`, CPUs `0.25`.
6. **Environment variables:**
   ```
   WA_TOKEN=…            WA_PHONE_NUMBER_ID=…     WA_APP_SECRET=…
   WA_VERIFY_TOKEN=…     DASHBOARD_PASSWORD=…     SESSION_SECRET=…
   DASHBOARD_ORIGIN=https://<your-vercel-app>.vercel.app
   WORKER_URL=https://anyway-sync.mitang-sync-worker.workers.dev
   BOT_SHARED_SECRET=…   (the same value as the worker)
   APP_BASE_URL=https://ais.mitangs.tech
   ```
7. Deploy.

**Check:** open `https://wa-api.apps.mitangs.tech/health`. You should see `ok: true`,
`rssMb` well under 100, and `catalog.products` > 0 once the worker step is done.

---

## 4. Meta webhook

App → **WhatsApp → Configuration → Webhook → Edit**:
- Callback URL: `https://wa-api.apps.mitangs.tech/webhook`
- Verify token: your `WA_VERIFY_TOKEN`
- **Verify and save**, then **Manage → subscribe to `messages`**.

**Check:** send "hi" from a verified phone. It should appear in Coolify's logs,
and in the dashboard after step 5.

---

## 5. Vercel: `dashboard/`

1. vercel.com → **Add New → Project** → import the same GitHub repo.
2. **Root directory:** `dashboard`. Framework: Vite (auto-detected).
3. **Env:** `VITE_API_URL=https://wa-api.apps.mitangs.tech`
4. Deploy, then copy the URL into Coolify's `DASHBOARD_ORIGIN` and redeploy the server.

**Check:** log in with `DASHBOARD_PASSWORD`, and your "hi" from step 4 is in the inbox.

---

## 6. Turn the bot on

Dashboard → **Settings** → add your number to *Allowed numbers* → switch
**Auto-reply** on. Send "menu", then a model name (e.g. "hp i5").

**Check:** you get back up to 3 products with links. There are no prices, by design.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Meta "callback URL couldn't be validated" | wrong `WA_VERIFY_TOKEN`, DNS not live yet, or no TLS cert |
| Messages never arrive | not subscribed to `messages`, or `WA_APP_SECRET` wrong (server logs a 401 on webhook) |
| Send fails `(#131030) Recipient not in allowed list` | test number: add the recipient under API Setup → To |
| Send fails `401 / OAuthException` | temporary token expired: use the System User token |
| Reply box greyed out | dealer's last message is >24h old: send a template instead |
| Dashboard "Failed to fetch" | `DASHBOARD_ORIGIN` doesn't exactly match the Vercel URL (CORS) |
| `catalog.products: 0` | `WORKER_URL` / `BOT_SHARED_SECRET` mismatch, or worker not deployed |
