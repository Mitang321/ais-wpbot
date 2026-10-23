# WhatsApp dashboard

Static SPA (Vite + React + TypeScript + Tailwind 3) for the WhatsApp bot prototype.
It talks to the `server/` REST API described in [../CONTRACT.md](../CONTRACT.md). No Vercel serverless functions.

## Features

- Password login (`POST /api/login`); the token is kept in `localStorage`. Any `401` returns to the login screen.
- WhatsApp Web-style inbox: conversation list (search, unread badges, "not allowed" marker) and a chat thread
  (in/out bubbles, `bot` tag on auto-replies, sent/delivered/read ticks, failed sends in red with the error on hover).
- Composer: Enter sends, Shift+Enter adds a new line. When the 24h window is closed the text box is disabled and a
  template sender (default `hello_world` / `en_US`) appears. Server errors (409, 502, ...) show inline.
- New chat: phone number + template, using `POST /api/send-template`.
- Settings drawer: auto-reply switch and the allowed-numbers list. The chat header also has an "Allow this number" toggle.
- Polling: the list every 5s, the open thread every 3s. Polling pauses while the tab is hidden.
- Responsive: below `md` the list and the thread are separate screens. The open chat is in the URL (`/c/<phone>`).

## Local development

```bash
npm install
cp .env.example .env.local      # VITE_API_URL=http://localhost:3000
npm run mock                    # in-memory mock API on :3000, password "test"
npm run dev                     # http://localhost:5175
```

The mock (`scripts/mock-api.mjs`, plain `node:http`) implements the contract with a few fake conversations.
`PORT` and `MOCK_PASSWORD` env vars override the defaults. Testing helpers:

- text containing `fail` returns `502` and stores a failed message
- outgoing statuses move from sent to delivered (2s) to read (5s)
- `POST /mock/inbound {"phone":"9198...","text":"hi","name":"Ravi"}` simulates an incoming message (and the
  auto-reply, when it is on and the number is allowed)

Checks: `npm run typecheck`, `npm run build` (output in `dist/`).

## Deploy on Vercel

1. Import the repo in Vercel.
2. **Root Directory:** `dashboard`
3. **Framework Preset:** Vite (build `npm run build`, output `dist`; `vercel.json` sets these too)
4. **Environment variable:** `VITE_API_URL=https://wa-api.mitangs.tech` (Production and Preview).
   It is baked in at build time, so redeploy after you change it.
5. Deploy. `vercel.json` rewrites every path to `index.html` so deep links like `/c/919812345678` work.

**CORS:** the server only accepts requests from `DASHBOARD_ORIGIN`. Set it in Coolify to the exact Vercel URL,
for example `DASHBOARD_ORIGIN=https://wa-dashboard.vercel.app` (scheme included, no trailing slash). Add a
custom domain or preview URL as a comma-separated list if you use them. If it does not match, the browser blocks
every call and the login screen shows "Can't reach the server".
