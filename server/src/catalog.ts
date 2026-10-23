/**
 * In-memory catalog pulled from the anyway-sync worker (CONTRACT §3) plus a
 * plain token-match search (CONTRACT §2). Kept deliberately small: we only
 * retain the fields the search and the reply need.
 */
import { createHmac } from 'node:crypto';
import { errMsg, type Logger } from './log.js';

export interface RawProduct {
  id: string;
  modelNumber: string;
  partNo?: string;
  series?: string;
  sectionTitle?: string;
  attrs?: Array<{ k: string; v: string }>;
  rowIndex?: number;
  updatedAt?: number;
}
export interface RawCategory {
  category: string;
  version?: number;
  products: RawProduct[];
}

export interface Product {
  id: string;
  modelNumber: string;
  category: string;
  /** First 3 attrs, for the reply. */
  topAttrs: Array<{ k: string; v: string }>;
  /** Lowercased searchable fields: modelNumber, partNo, series, sectionTitle, then each attr value. */
  fields: string[];
  rowIndex: number;
}

export interface CatalogSnapshot {
  categories: string[];
  products: Product[];
  loadedAt: number | null;
}

export function emptyCatalog(): CatalogSnapshot {
  return { categories: [], products: [], loadedAt: null };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export function toProduct(category: string, p: RawProduct): Product | null {
  const id = str(p?.id);
  const modelNumber = str(p?.modelNumber);
  if (!id || !modelNumber) return null;
  const attrs = Array.isArray(p.attrs)
    ? p.attrs.map((a) => ({ k: str(a?.k), v: str(a?.v) })).filter((a) => a.k || a.v)
    : [];
  const fields = [modelNumber, str(p.partNo), str(p.series), str(p.sectionTitle), ...attrs.map((a) => a.v)]
    .map((f) => f.toLowerCase().trim())
    .filter(Boolean);
  return {
    id,
    modelNumber,
    category,
    topAttrs: attrs.filter((a) => a.v).slice(0, 3),
    fields: [...new Set(fields)],
    rowIndex: typeof p.rowIndex === 'number' ? p.rowIndex : Number.MAX_SAFE_INTEGER,
  };
}

export function tokenize(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean))];
}

/**
 * Every query token must appear (substring, case-insensitive) in at least one
 * field. Ranked by the number of fields hit by any token; ties: model-number
 * hit, then shorter model number (closer match), then sheet order.
 */
export function search(products: Product[], query: string, limit = 3): Product[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const hits: Array<{ p: Product; score: number; modelHit: number }> = [];
  for (const p of products) {
    let ok = true;
    for (const t of tokens) {
      if (!p.fields.some((f) => f.includes(t))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let score = 0;
    for (const f of p.fields) if (tokens.some((t) => f.includes(t))) score++;
    const model = p.modelNumber.toLowerCase();
    const modelHit = tokens.filter((t) => model.includes(t)).length;
    hits.push({ p, score, modelHit });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.modelHit - a.modelHit ||
      a.p.modelNumber.length - b.p.modelNumber.length ||
      a.p.rowIndex - b.p.rowIndex,
  );
  return hits.slice(0, limit).map((h) => h.p);
}

/** lowercase hex HMAC-SHA256(secret, "<ts>.<body>") — CONTRACT §3. */
export function signWorkerRequest(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface CatalogClientOpts {
  workerUrl: string | null;
  secret: string | null;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class CatalogClient {
  snapshot: CatalogSnapshot = emptyCatalog();
  private loading: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: CatalogClientOpts) {}

  get enabled(): boolean {
    return Boolean(this.opts.workerUrl && this.opts.secret);
  }

  private async call(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const raw = JSON.stringify(body);
    const ts = String((this.opts.now ?? Date.now)());
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.workerUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-timestamp': ts,
        'x-bot-signature': signWorkerRequest(this.opts.secret!, ts, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  }

  /** Reloads the whole catalog. On failure the previous catalog is kept. */
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.doRefresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doRefresh(): Promise<void> {
    const { log } = this.opts;
    const started = Date.now();
    try {
      const list = await this.call({ action: 'bot_catalog' });
      const cats = (list.json as { ok?: boolean; categories?: unknown })?.categories;
      if (list.status !== 200 || !Array.isArray(cats)) {
        throw new Error(`category list: HTTP ${list.status}`);
      }
      const categories = cats.filter((c): c is string => typeof c === 'string' && c.length > 0);
      const prevByCat = new Map<string, Product[]>();
      for (const p of this.snapshot.products) {
        let arr = prevByCat.get(p.category);
        if (!arr) prevByCat.set(p.category, (arr = []));
        arr.push(p);
      }
      const products: Product[] = [];
      const loaded: string[] = [];
      for (const category of categories) {
        try {
          const r = await this.call({ action: 'bot_catalog', category });
          if (r.status === 404) {
            log.warn(`catalog: category ${category} not synced yet`);
            continue;
          }
          const data = r.json as RawCategory | null;
          if (r.status !== 200 || !data || !Array.isArray(data.products)) {
            throw new Error(`HTTP ${r.status}`);
          }
          for (const raw of data.products) {
            const p = toProduct(category, raw);
            if (p) products.push(p);
          }
          loaded.push(category);
        } catch (err) {
          // Keep what we had for this category.
          const prev = prevByCat.get(category);
          if (prev) {
            products.push(...prev);
            loaded.push(category);
          }
          log.warn(`catalog: category ${category} failed (${errMsg(err)}); kept ${prev?.length ?? 0} old products`);
        }
      }
      this.snapshot = { categories: loaded, products, loadedAt: Date.now() };
      log.info(`catalog: ${products.length} products in ${loaded.length} categories (${Date.now() - started} ms)`);
    } catch (err) {
      log.warn(`catalog: refresh failed (${errMsg(err)}); keeping previous catalog (${this.snapshot.products.length} products)`);
    }
  }

  start(intervalMs = 5 * 60_000): void {
    if (!this.enabled) {
      this.opts.log.warn('catalog: WORKER_URL not set; running with an empty catalog');
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
