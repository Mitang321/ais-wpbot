# wa-server

The WhatsApp bot prototype backend. It is a single Node process that handles:

- the Meta webhook,
- a SQLite inbox,
- the dashboard REST API,
- the grocery ordering bot for Indian Store Marseille (products, delivery runs, orders).

The API is specified in [../CONTRACT.md](../CONTRACT.md) and [../GROCERY-CONTRACT.md](../GROCERY-CONTRACT.md).

- Node 24, TypeScript (ESM), Hono. `node:sqlite` is built in, so there are no native modules.
- esbuild bundles everything into one `dist/index.js` (~65 KB). The runtime image has no `node_modules`.
- SQLite lives at `$DATA_DIR/wa.db` (WAL mode). The tables are `contacts`, `messages`, `settings`, `products`, `runs`, `orders` and `sessions` (bot drafts). `messages.wa_id` is unique, so Meta retries are deduped.

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `WA_TOKEN` | yes | | Permanent System User token. Never logged. |
| `WA_PHONE_NUMBER_ID` | yes | | Phone Number ID (not the number itself). |
| `WA_APP_SECRET` | yes | | Verifies `X-Hub-Signature-256`. |
| `WA_VERIFY_TOKEN` | yes | | Must match the token set in the Meta webhook config. |
| `DASHBOARD_PASSWORD` | yes | | Shared dashboard password. |
| `SESSION_SECRET` | yes | | Signs the 12h login tokens. Changing it logs everyone out. |
| `DASHBOARD_ORIGIN` | | | CORS origin(s), comma-separated, e.g. `https://wa-dashboard.vercel.app`. |
| `STORE_NAME` | | `Indian Store Marseille` | Shown in bot greetings. |
| `GEMINI_API_KEY` | | | Enables Gemini order parsing. Without it, only the rules parser runs. Never logged. |
| `GEMINI_MODEL` | | `gemini-2.5-flash-lite` | |
| `SEED_DEMO` | | `true` | On first boot (no products) the seed catalogue is always inserted; `false` skips the demo run and orders. |
| `PORT` | | `3000` | |
| `DATA_DIR` | | `./data` (`/data` in Docker) | |

The process exits at boot if a required var is missing. Copy `.env.example` to `.env` for local runs; `npm start` and `npm run dev` load it.

## Run

```sh
npm ci
npm run dev        # node --watch + tsx, loads .env
npm test           # node:test via tsx (Graph + Gemini fetch are mocked)
npm run typecheck
npm run build      # -> dist/index.js
npm start          # node --max-old-space-size=96 dist/index.js
```

To receive real webhooks locally, run `cloudflared tunnel --url http://localhost:3000` and set `<tunnel>/webhook` in Meta.

On boot, an empty database is seeded from `src/seed.ts`. `GET /health` shows the store counts (products, runs, orders) and the RSS.

## Docker

```sh
docker build -t wa-server .
docker run --rm -p 3000:3000 --env-file .env -v wa-data:/data -m 128m wa-server
```

The image is multi-stage. The runtime stage is `node:24-alpine` running as the non-root `node` user, with `VOLUME /data` and a `HEALTHCHECK` on `/health`. `SIGTERM` closes the HTTP server, waits for in-flight webhook work, then closes SQLite.

## Deploy on Coolify

1. Create a new resource from this repo.
   - **Build pack:** Dockerfile
   - **Base directory:** `/server`
   - **Exposed port:** `3000`
   - **Domain:** `https://wa-api.apps.mitangs.tech`
2. Add a **persistent storage** volume mounted at **`/data`**. Without it, the inbox is lost on every redeploy.
3. Set the resource limits to **memory 128M** and CPU 0.25.
4. Add the env vars from the table above. Keep `WA_TOKEN`, `WA_APP_SECRET`, `SESSION_SECRET`, `DASHBOARD_PASSWORD` and `GEMINI_API_KEY` as secrets.
5. After the deploy, check that `GET https://wa-api.apps.mitangs.tech/health` returns `ok: true`. Then set the Meta webhook to `https://wa-api.apps.mitangs.tech/webhook` with the verify token, and subscribe to the **messages** field.

Only one replica can run, because SQLite on a volume supports a single writer.
