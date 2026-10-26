/** SQLite storage via the built-in node:sqlite (no native modules). */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  WINDOW_MS,
  type Conversation,
  type Message,
  type MessageStatus,
  type MessageType,
  type Direction,
  type Settings,
  type Product,
  type ProductUnit,
  type Run,
  type RunStatus,
  type RunSummary,
  type Order,
  type OrderItem,
  type OrderStatus,
} from './types.js';
import { SEED_PRODUCTS, demoRun, DEMO_ORDERS } from './seed.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  phone                TEXT PRIMARY KEY,
  name                 TEXT,
  last_inbound_at      INTEGER,
  last_message_at      INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT NOT NULL DEFAULT '',
  unread               INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS contacts_last_message_at ON contacts(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  wa_id     TEXT PRIMARY KEY,           -- WhatsApp id (wamid...) or local id; unique => Meta retries dedupe
  phone     TEXT NOT NULL,
  direction TEXT NOT NULL,              -- 'in' | 'out'
  type      TEXT NOT NULL,
  text      TEXT NOT NULL,
  status    TEXT NOT NULL,
  error     TEXT,
  auto      INTEGER NOT NULL DEFAULT 0,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_phone_ts ON messages(phone, ts);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  unit        TEXT NOT NULL,
  pack_label  TEXT,
  pack_grams  INTEGER,
  price_cents INTEGER NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  town          TEXT NOT NULL,
  delivery_date TEXT NOT NULL,             -- YYYY-MM-DD (Europe/Paris)
  delivery_time TEXT NOT NULL,
  pickup_spot   TEXT NOT NULL,
  cutoff_at     INTEGER NOT NULL,
  veg_cutoff_at INTEGER,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL,
  items         TEXT NOT NULL,             -- JSON OrderItem[]
  total_cents   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  paid          INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_run ON orders(run_id, id);
CREATE INDEX IF NOT EXISTS orders_run_phone ON orders(run_id, phone);

CREATE TABLE IF NOT EXISTS sessions (
  phone      TEXT PRIMARY KEY,
  state      TEXT NOT NULL,                -- JSON
  updated_at INTEGER NOT NULL
);
`;

interface ProductRow {
  id: string;
  name: string;
  category: string;
  unit: string;
  pack_label: string | null;
  pack_grams: number | null;
  price_cents: number;
  aliases: string;
  active: number;
  sort: number;
}
interface RunRow {
  id: number;
  town: string;
  delivery_date: string;
  delivery_time: string;
  pickup_spot: string;
  cutoff_at: number;
  veg_cutoff_at: number | null;
  status: string;
  created_at: number;
}
interface OrderRow {
  id: number;
  run_id: number;
  phone: string;
  customer_name: string;
  items: string;
  total_cents: number;
  status: string;
  paid: number;
  note: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface ItemInput { productId: string; qty: number }
export type ProductInput = Omit<Product, 'id' | 'active' | 'sort'> & { active?: boolean; sort?: number };
export type RunInput = Omit<Run, 'id' | 'createdAt'>;
export interface OrderPatch { status?: OrderStatus; paid?: boolean; note?: string; items?: OrderItem[] }

const PREVIEW_LEN = 100;
const STATUS_RANK: Record<MessageStatus, number> = { received: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

interface ContactRow {
  phone: string;
  name: string | null;
  last_inbound_at: number | null;
  last_message_at: number;
  last_message_preview: string;
  unread: number;
}
interface MessageRow {
  wa_id: string;
  phone: string;
  direction: string;
  type: string;
  text: string;
  status: string;
  error: string | null;
  auto: number;
  ts: number;
}

const DEFAULT_SETTINGS: Settings = { autoReply: true, allowedPhones: [] };

export class Store {
  readonly db: DatabaseSync;
  private st: Record<string, StatementSync>;
  private settingsCache: Settings | null = null;

  /** `file` is a path or ':memory:' (tests). */
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    // Keep SQLite's page cache small: we're on a 128 MB container.
    this.db.exec('PRAGMA cache_size = -2000;'); // ~2 MB
    this.db.exec(SCHEMA);
    this.st = {
      insertMsg: this.db.prepare(
        `INSERT OR IGNORE INTO messages (wa_id, phone, direction, type, text, status, error, auto, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      touchContact: this.db.prepare(
        `INSERT INTO contacts (phone, last_inbound_at, last_message_at, last_message_preview, unread)
         VALUES (:phone, :inbound, :ts, :preview, :unread)
         ON CONFLICT(phone) DO UPDATE SET
           last_inbound_at = CASE WHEN :inbound IS NOT NULL AND (last_inbound_at IS NULL OR :inbound > last_inbound_at)
                                  THEN :inbound ELSE last_inbound_at END,
           last_message_preview = CASE WHEN :ts >= last_message_at THEN :preview ELSE last_message_preview END,
           last_message_at = MAX(last_message_at, :ts),
           unread = unread + :unread`,
      ),
      setName: this.db.prepare(
        `INSERT INTO contacts (phone, name) VALUES (?, ?)
         ON CONFLICT(phone) DO UPDATE SET name = excluded.name`,
      ),
      getMsg: this.db.prepare('SELECT * FROM messages WHERE wa_id = ?'),
      setStatus: this.db.prepare('UPDATE messages SET status = ?, error = ? WHERE wa_id = ?'),
      getContact: this.db.prepare('SELECT * FROM contacts WHERE phone = ?'),
      listContacts: this.db.prepare('SELECT * FROM contacts ORDER BY last_message_at DESC'),
      msgsLatest: this.db.prepare(
        'SELECT * FROM (SELECT * FROM messages WHERE phone = ? ORDER BY ts DESC, rowid DESC LIMIT ?) ORDER BY ts ASC',
      ),
      msgsBefore: this.db.prepare(
        'SELECT * FROM (SELECT * FROM messages WHERE phone = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?) ORDER BY ts ASC',
      ),
      markRead: this.db.prepare('UPDATE contacts SET unread = 0 WHERE phone = ?'),
      getSetting: this.db.prepare('SELECT value FROM settings WHERE key = ?'),
      putSetting: this.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
    };
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Stores a message and updates the contact. Returns false if the id already existed (Meta retry). */
  addMessage(m: Message): boolean {
    return this.tx(() => {
      const res = this.st.insertMsg!.run(
        m.id, m.phone, m.direction, m.type, m.text, m.status, m.error ?? null, m.auto ? 1 : 0, m.ts,
      );
      if (Number(res.changes) === 0) return false;
      const inbound = m.direction === 'in';
      this.st.touchContact!.run({
        phone: m.phone,
        inbound: inbound ? m.ts : null,
        ts: m.ts,
        preview: m.text.slice(0, PREVIEW_LEN),
        unread: inbound ? 1 : 0,
      });
      return true;
    });
  }

  setContactName(phone: string, name: string): void {
    this.st.setName!.run(phone, name);
  }

  /** Applies a webhook status. Never downgrades (read stays read); 'failed' always wins. */
  updateStatus(id: string, status: MessageStatus, error?: string): boolean {
    const row = this.st.getMsg!.get(id) as MessageRow | undefined;
    if (!row) return false;
    const cur = row.status as MessageStatus;
    if (cur === 'failed' && status !== 'failed') return false;
    if (status !== 'failed' && STATUS_RANK[status] <= STATUS_RANK[cur]) return false;
    this.st.setStatus!.run(status, status === 'failed' ? (error ?? row.error ?? 'Failed') : row.error, id);
    return true;
  }

  getMessage(id: string): Message | null {
    const row = this.st.getMsg!.get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  getConversation(phone: string, now = Date.now()): Conversation | null {
    const row = this.st.getContact!.get(phone) as ContactRow | undefined;
    return row ? this.toConversation(row, now) : null;
  }

  listConversations(now = Date.now()): Conversation[] {
    return (this.st.listContacts!.all() as unknown as ContactRow[]).map((r) => this.toConversation(r, now));
  }

  /** Last `limit` messages (optionally before `before`), oldest -> newest. */
  getMessages(phone: string, before?: number, limit = 200): Message[] {
    const rows = (before !== undefined
      ? this.st.msgsBefore!.all(phone, before, limit)
      : this.st.msgsLatest!.all(phone, limit)) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  markRead(phone: string): void {
    this.st.markRead!.run(phone);
  }

  getSettings(): Settings {
    if (this.settingsCache) return this.settingsCache;
    const row = this.st.getSetting!.get('settings') as { value: string } | undefined;
    let s: Settings = { ...DEFAULT_SETTINGS };
    if (row) {
      try {
        const v = JSON.parse(row.value) as Partial<Settings>;
        s = {
          autoReply: typeof v.autoReply === 'boolean' ? v.autoReply : DEFAULT_SETTINGS.autoReply,
          allowedPhones: Array.isArray(v.allowedPhones) ? v.allowedPhones.filter((p) => typeof p === 'string') : [],
        };
      } catch {
        /* corrupted -> defaults */
      }
    }
    this.settingsCache = s;
    return s;
  }

  saveSettings(s: Settings): Settings {
    this.st.putSetting!.run('settings', JSON.stringify(s));
    this.settingsCache = { autoReply: s.autoReply, allowedPhones: [...s.allowedPhones] };
    return this.settingsCache;
  }

  // ---------- products ----------

  listProducts(): Product[] {
    return (this.db.prepare('SELECT * FROM products ORDER BY sort ASC, name COLLATE NOCASE ASC').all() as unknown as ProductRow[])
      .map(toProduct);
  }

  getProduct(id: string): Product | null {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
    return row ? toProduct(row) : null;
  }

  /** Inserts a product with an id slugged from its name (made unique). */
  createProduct(input: ProductInput): Product {
    const base = slugify(input.name) || 'product';
    let id = base;
    for (let n = 2; this.getProduct(id); n++) id = `${base}-${n}`;
    const maxSort = (this.db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM products').get() as { m: number }).m;
    const p: Product = {
      id,
      name: input.name,
      category: input.category,
      unit: input.unit,
      packLabel: input.packLabel ?? null,
      packGrams: input.packGrams ?? null,
      priceCents: input.priceCents,
      aliases: input.aliases ?? [],
      active: input.active ?? true,
      sort: input.sort ?? maxSort + 1,
    };
    this.insertProduct(p);
    return p;
  }

  insertProduct(p: Product): void {
    this.db
      .prepare(
        `INSERT INTO products (id, name, category, unit, pack_label, pack_grams, price_cents, aliases, active, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.category, p.unit, p.packLabel, p.packGrams, p.priceCents, JSON.stringify(p.aliases), p.active ? 1 : 0, p.sort);
  }

  updateProduct(id: string, patch: Partial<Omit<Product, 'id'>>): Product | null {
    const cur = this.getProduct(id);
    if (!cur) return null;
    const p: Product = { ...cur, ...patch, id };
    this.db
      .prepare(
        `UPDATE products SET name = ?, category = ?, unit = ?, pack_label = ?, pack_grams = ?, price_cents = ?,
           aliases = ?, active = ?, sort = ? WHERE id = ?`,
      )
      .run(p.name, p.category, p.unit, p.packLabel, p.packGrams, p.priceCents, JSON.stringify(p.aliases), p.active ? 1 : 0, p.sort, id);
    return p;
  }

  /**
   * Prices items from the current products (lineTotal = round(qty * unitPrice)). Same product twice is summed.
   * Returns the ids that don't exist in `missing`.
   */
  priceItems(lines: ItemInput[]): { items: OrderItem[]; missing: string[] } {
    const byId = new Map<string, OrderItem>();
    const missing: string[] = [];
    for (const l of lines) {
      const p = this.getProduct(l.productId);
      if (!p) {
        missing.push(l.productId);
        continue;
      }
      const prev = byId.get(p.id);
      const qty = roundQty((prev?.qty ?? 0) + l.qty);
      byId.set(p.id, {
        productId: p.id,
        name: p.name,
        category: p.category,
        qty,
        unit: p.unit,
        packLabel: p.packLabel,
        unitPriceCents: p.priceCents,
        lineTotalCents: lineTotalCents(qty, p.priceCents),
      });
    }
    return { items: [...byId.values()], missing };
  }

  // ---------- runs ----------

  getRun(id: number): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  createRun(input: RunInput, now = Date.now()): Run {
    const res = this.db
      .prepare(
        `INSERT INTO runs (town, delivery_date, delivery_time, pickup_spot, cutoff_at, veg_cutoff_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.town, input.deliveryDate, input.deliveryTime, input.pickupSpot, input.cutoffAt, input.vegCutoffAt, input.status, now);
    return this.getRun(Number(res.lastInsertRowid))!;
  }

  updateRun(id: number, patch: Partial<RunInput>): Run | null {
    const cur = this.getRun(id);
    if (!cur) return null;
    const r: Run = { ...cur, ...patch, id };
    this.db
      .prepare(
        `UPDATE runs SET town = ?, delivery_date = ?, delivery_time = ?, pickup_spot = ?, cutoff_at = ?, veg_cutoff_at = ?,
           status = ? WHERE id = ?`,
      )
      .run(r.town, r.deliveryDate, r.deliveryTime, r.pickupSpot, r.cutoffAt, r.vegCutoffAt, r.status, id);
    return r;
  }

  /** Newest deliveryDate first, with totals over non-cancelled orders. */
  listRunSummaries(): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_cents), 0) AS total,
                COALESCE(SUM(CASE WHEN o.paid = 1 THEN o.total_cents ELSE 0 END), 0) AS paid_total
         FROM runs r LEFT JOIN orders o ON o.run_id = r.id AND o.status != 'cancelled'
         GROUP BY r.id ORDER BY r.delivery_date DESC, r.id DESC`,
      )
      .all() as unknown as Array<RunRow & { order_count: number; total: number; paid_total: number }>;
    return rows.map((r) => ({ ...toRun(r), orderCount: r.order_count, totalCents: r.total, paidCents: r.paid_total }));
  }

  /** GROCERY-CONTRACT §3: earliest open run due today or later (Paris), else the most recent open run. */
  activeRun(now = Date.now()): Run | null {
    const today = parisDate(now);
    const next = this.db
      .prepare("SELECT * FROM runs WHERE status = 'open' AND delivery_date >= ? ORDER BY delivery_date ASC, id ASC LIMIT 1")
      .get(today) as RunRow | undefined;
    if (next) return toRun(next);
    const last = this.db
      .prepare("SELECT * FROM runs WHERE status = 'open' ORDER BY delivery_date DESC, id DESC LIMIT 1")
      .get() as RunRow | undefined;
    return last ? toRun(last) : null;
  }

  // ---------- orders ----------

  getOrder(id: number): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    return row ? toOrder(row) : null;
  }

  /** Oldest first, cancelled included. */
  listOrders(runId: number): Order[] {
    return (this.db.prepare('SELECT * FROM orders WHERE run_id = ? ORDER BY id ASC').all(runId) as unknown as OrderRow[]).map(toOrder);
  }

  /** The sender's latest non-cancelled order for a run. */
  findOpenOrder(runId: number, phone: string): Order | null {
    if (!phone) return null;
    const row = this.db
      .prepare("SELECT * FROM orders WHERE run_id = ? AND phone = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1")
      .get(runId, phone) as OrderRow | undefined;
    return row ? toOrder(row) : null;
  }

  createOrder(
    o: { runId: number; phone: string; customerName: string; items: OrderItem[]; note?: string; source: Order['source'] },
    now = Date.now(),
  ): Order {
    const res = this.db
      .prepare(
        `INSERT INTO orders (run_id, phone, customer_name, items, total_cents, status, paid, note, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', 0, ?, ?, ?, ?)`,
      )
      .run(o.runId, o.phone, o.customerName, JSON.stringify(o.items), sumItems(o.items), o.note ?? '', o.source, now, now);
    return this.getOrder(Number(res.lastInsertRowid))!;
  }

  updateOrder(id: number, patch: OrderPatch, now = Date.now()): Order | null {
    const cur = this.getOrder(id);
    if (!cur) return null;
    const items = patch.items ?? cur.items;
    const o: Order = {
      ...cur,
      status: patch.status ?? cur.status,
      paid: patch.paid ?? cur.paid,
      note: patch.note ?? cur.note,
      items,
      totalCents: sumItems(items),
      updatedAt: now,
    };
    this.db
      .prepare('UPDATE orders SET items = ?, total_cents = ?, status = ?, paid = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(o.items), o.totalCents, o.status, o.paid ? 1 : 0, o.note, now, id);
    return o;
  }

  // ---------- bot sessions ----------

  getSession<T = unknown>(phone: string): { state: T; updatedAt: number } | null {
    const row = this.db.prepare('SELECT state, updated_at FROM sessions WHERE phone = ?').get(phone) as
      | { state: string; updated_at: number }
      | undefined;
    if (!row) return null;
    try {
      return { state: JSON.parse(row.state) as T, updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  setSession(phone: string, state: unknown, now = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO sessions (phone, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
      )
      .run(phone, JSON.stringify(state), now);
  }

  clearSession(phone: string): void {
    this.db.prepare('DELETE FROM sessions WHERE phone = ?').run(phone);
  }

  // ---------- misc ----------

  storeCounts(): { products: number; runs: number; orders: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      products: n('SELECT COUNT(*) AS n FROM products'),
      runs: n('SELECT COUNT(*) AS n FROM runs'),
      orders: n("SELECT COUNT(*) AS n FROM orders WHERE status != 'cancelled'"),
    };
  }

  /** GROCERY-CONTRACT §6: when there are no products, insert the seed catalogue (+ demo run and orders). */
  seedIfEmpty(opts: { seedDemo: boolean; now?: number }): boolean {
    if (this.storeCounts().products > 0) return false;
    const now = opts.now ?? Date.now();
    this.tx(() => {
      for (const p of SEED_PRODUCTS) this.insertProduct(p);
      if (opts.seedDemo) {
        const run = this.createRun(demoRun(), now);
        for (const d of DEMO_ORDERS) {
          const { items } = this.priceItems(d.items);
          if (!items.length) continue;
          this.createOrder({ runId: run.id, phone: d.phone, customerName: d.customerName, items, source: 'manual' }, now);
        }
      }
    });
    return true;
  }

  private toConversation(r: ContactRow, now: number): Conversation {
    const lastInboundAt = r.last_inbound_at ?? null;
    return {
      phone: r.phone,
      name: r.name ?? null,
      lastMessageAt: r.last_message_at,
      lastMessagePreview: r.last_message_preview,
      lastInboundAt,
      windowOpen: isWindowOpen(lastInboundAt, now),
      unread: r.unread,
      allowed: this.getSettings().allowedPhones.includes(r.phone),
    };
  }
}

export function isWindowOpen(lastInboundAt: number | null, now = Date.now()): boolean {
  return lastInboundAt !== null && now - lastInboundAt < WINDOW_MS;
}

function toMessage(r: MessageRow): Message {
  const m: Message = {
    id: r.wa_id,
    phone: r.phone,
    direction: r.direction as Direction,
    type: r.type as MessageType,
    text: r.text,
    status: r.status as MessageStatus,
    auto: r.auto === 1,
    ts: r.ts,
  };
  if (r.error) m.error = r.error;
  return m;
}

export function lineTotalCents(qty: number, unitPriceCents: number): number {
  return Math.round(qty * unitPriceCents);
}

/** Avoids float noise like 0.30000000000000004 kg. */
export function roundQty(q: number): number {
  return Math.round(q * 1000) / 1000;
}

const sumItems = (items: OrderItem[]) => items.reduce((s, i) => s + i.lineTotalCents, 0);

/** "Kaju Katli 250 g" -> "kaju-katli-250-g" */
export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const parisDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar date in Europe/Paris as "YYYY-MM-DD". */
export function parisDate(ms: number): string {
  const parts = Object.fromEntries(parisDayFmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseJsonArray<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    unit: r.unit as ProductUnit,
    packLabel: r.pack_label ?? null,
    packGrams: r.pack_grams ?? null,
    priceCents: r.price_cents,
    aliases: parseJsonArray<string>(r.aliases),
    active: r.active === 1,
    sort: r.sort,
  };
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    town: r.town,
    deliveryDate: r.delivery_date,
    deliveryTime: r.delivery_time,
    pickupSpot: r.pickup_spot,
    cutoffAt: r.cutoff_at,
    vegCutoffAt: r.veg_cutoff_at ?? null,
    status: r.status as RunStatus,
    createdAt: r.created_at,
  };
}

function toOrder(r: OrderRow): Order {
  return {
    id: r.id,
    runId: r.run_id,
    phone: r.phone,
    customerName: r.customer_name,
    items: parseJsonArray<OrderItem>(r.items),
    totalCents: r.total_cents,
    status: r.status as OrderStatus,
    paid: r.paid === 1,
    note: r.note,
    source: r.source as Order['source'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  return new Store(join(dataDir, 'wa.db'));
}
