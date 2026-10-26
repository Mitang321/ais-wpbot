import { useEffect, useRef } from 'react';
import { TZ, VEG_CATEGORY } from './config';
import type { Conversation, Order, OrderItem, Product, ProductUnit, Run } from './types';

/** Digits only: strips "+", spaces, dashes, brackets. */
export function normalizePhone(input: string): string {
  return input.replace(/\D+/g, '');
}

/** "33612345678" -> "+33 6 12 34 56 78", "919812345678" -> "+91 98123 45678". Good enough for display. */
export function formatPhone(phone: string): string {
  if (!phone) return '';
  if (phone.startsWith('33') && phone.length === 11) {
    const r = phone.slice(2);
    return `+33 ${r[0]} ${(r.slice(1).match(/.{1,2}/g) ?? []).join(' ')}`;
  }
  if (phone.length > 10) {
    const cc = phone.slice(0, phone.length - 10);
    const rest = phone.slice(-10);
    return `+${cc} ${rest.slice(0, 5)} ${rest.slice(5)}`;
  }
  return `+${phone}`;
}

export function displayName(c: Pick<Conversation, 'name' | 'phone'>): string {
  return c.name?.trim() || formatPhone(c.phone);
}

export function initials(c: Pick<Conversation, 'name' | 'phone'>): string {
  const n = c.name?.trim();
  if (!n) return '#';
  const parts = n
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '#';
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Compact relative time for the conversation list. */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const d = new Date(ts);
  if (sameDay(d, new Date(now))) return clockTime(ts);
  if (sameDay(d, new Date(now - 86_400_000))) return 'Yesterday';
  if (diff < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  if (sameDay(d, new Date(now))) return 'Today';
  if (sameDay(d, new Date(now - 86_400_000))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Calls `fn` every `intervalMs` while the tab is visible. Runs immediately on start
 * (and whenever `key` changes), and again as soon as the tab becomes visible.
 * Calls never overlap; the next one is scheduled after the previous finishes.
 */
export function usePolling(
  fn: () => Promise<unknown> | void,
  intervalMs: number,
  enabled = true,
  key: unknown = null,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (cancelled || running) return;
      if (document.visibilityState === 'hidden') return; // resumed by visibilitychange
      running = true;
      try {
        await fnRef.current();
      } catch {
        /* callers surface their own errors */
      } finally {
        running = false;
        if (!cancelled) {
          clearTimeout(timer);
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        void tick();
      }
    };

    void tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled, key]);
}

// ---------------------------------------------------------------------------
// Grocery store helpers: money, quantities, Paris time, packing, clipboard.
// ---------------------------------------------------------------------------

/** 1250 -> "€12.50" */
export function euros(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** 1250 -> "12.50", for inputs. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "12,5" / "12.50" / "€12" -> 1250, or null when not a valid amount. */
export function parseEuros(input: string): number | null {
  const t = input.replace(/[€\s]/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** 1.5 -> "1.5", 2 -> "2" */
export function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

const UNIT_WORDS: Record<ProductUnit, [string, string]> = {
  kg: ['kg', 'kg'],
  pack: ['pack', 'packs'],
  pc: ['pc', 'pcs'],
  bunch: ['bunch', 'bunches'],
};

/** Product name with its pack label: "Kaju katli (250 g box)". */
export function productLabel(p: { name: string; packLabel: string | null }): string {
  const label = p.packLabel?.trim();
  if (!label || /^(1\s*)?(pc|piece|bunch)$/i.test(label)) return p.name;
  // Skip the label when the name already says the size ("Kaju katli 250 g" + "250 g box").
  const size = /(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)\b/i.exec(label);
  if (size && new RegExp(`${size[1]}\\s*${size[2]}\\b`, 'i').test(p.name)) return p.name;
  return `${p.name} (${label})`;
}

/** One order line: "1.5 kg Okra" or "2 × Kaju katli (250 g box)". */
export function itemLine(it: Pick<OrderItem, 'qty' | 'unit' | 'name' | 'packLabel'>): string {
  return it.unit === 'kg' ? `${num(it.qty)} kg ${it.name}` : `${num(it.qty)} × ${productLabel(it)}`;
}

/** Aggregated quantity: "6 kg", "4 packs", "1 bunch". */
export function qtyTotal(qty: number, unit: ProductUnit): string {
  const [one, many] = UNIT_WORDS[unit];
  return `${num(qty)} ${unit === 'kg' || qty === 1 ? one : many}`;
}

/** Short quantity for a customer breakdown: "1.5 kg", "2 ×". */
export function qtyShort(qty: number, unit: ProductUnit): string {
  return unit === 'kg' ? `${num(qty)} kg` : `${num(qty)} ×`;
}

/** Price per unit: "€4.50/kg", "€6.00" (per pack), "€1.50/bunch". */
export function unitPrice(p: Pick<Product, 'priceCents' | 'unit'>): string {
  if (p.unit === 'kg') return `${euros(p.priceCents)}/kg`;
  if (p.unit === 'bunch') return `${euros(p.priceCents)}/bunch`;
  if (p.unit === 'pc') return `${euros(p.priceCents)}/pc`;
  return euros(p.priceCents);
}

export const UNIT_OPTIONS: Array<{ value: ProductUnit; label: string }> = [
  { value: 'kg', label: 'per kg' },
  { value: 'pack', label: 'per pack / box / bag' },
  { value: 'pc', label: 'per piece' },
  { value: 'bunch', label: 'per bunch' },
];

// ---- Paris time ----------------------------------------------------------------

function parisParts(ts: number): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Paris offset from UTC at instant ts, in ms (+1h winter, +2h summer). */
function parisOffset(ts: number): number {
  const p = parisParts(ts);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** "2026-11-05T18:00" (Paris wall clock, from <input type="datetime-local">) -> Unix ms. */
export function parisLocalToMs(local: string): number | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const first = guess - parisOffset(guess);
  return guess - parisOffset(first); // second pass handles DST edges
}

/** Unix ms -> "2026-11-05T18:00" in Paris, for <input type="datetime-local">. */
export function msToParisLocal(ts: number): string {
  const p = parisParts(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Today's date in Paris: "2026-10-26". */
export function parisToday(now = Date.now()): string {
  return msToParisLocal(now).slice(0, 10);
}

function dateFromIso(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, day || 1, 12));
}

/** "2026-11-06" -> "Fri 6 Nov" */
export function shortDate(d: string): string {
  return dateFromIso(d)
    .toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');
}

/** "2026-11-06" -> "Friday" */
export function weekdayLong(d: string): string {
  return dateFromIso(d).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long' });
}

/** "2026-11-06" -> "6 November" */
export function dayMonthLong(d: string): string {
  return dateFromIso(d).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long' });
}

/** "2026-11-06" + n days -> ISO date. */
export function addDaysIso(d: string, n: number): string {
  const x = dateFromIso(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** ms -> "Sat 31 Oct" (Paris). */
export function parisShortDay(ts: number): string {
  return new Date(ts)
    .toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');
}

/** ms -> "18:00" (Paris). */
export function parisClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** ms -> "Sat 31 Oct 18:00" (Paris). */
export function parisDateTime(ts: number): string {
  return `${parisShortDay(ts)} ${parisClock(ts)}`;
}

/** ms -> "Sat 31 Oct, 6pm" (Paris), friendly for WhatsApp text. */
export function parisFriendly(ts: number): string {
  const p = parisParts(ts);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'am' : 'pm';
  const time = p.minute ? `${h12}:${String(p.minute).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
  return `${parisShortDay(ts)}, ${time}`;
}

/** ms -> "14:05" when today (Paris), else "Fri 6 Nov 14:05". */
export function parisStamp(ts: number, now = Date.now()): string {
  return parisToday(ts) === parisToday(now) ? parisClock(ts) : parisDateTime(ts);
}

// ---- runs ------------------------------------------------------------------------

/** GROCERY-CONTRACT §3: the open run with the earliest deliveryDate >= today (Paris), else the most recent open run. */
export function pickActiveRun<T extends Run>(runs: T[], now = Date.now()): T | null {
  const today = parisToday(now);
  const open = runs.filter((r) => r.status === 'open');
  const upcoming = open.filter((r) => r.deliveryDate >= today).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
  if (upcoming[0]) return upcoming[0];
  return [...open].sort((a, b) => b.deliveryDate.localeCompare(a.deliveryDate))[0] ?? null;
}

export function runTitle(r: Pick<Run, 'town' | 'deliveryDate'>): string {
  return `${r.town} · ${shortDate(r.deliveryDate)}`;
}

export function isCategoryClosed(run: Run, category: string, now = Date.now()): boolean {
  if (now > run.cutoffAt) return true;
  return category === VEG_CATEGORY && run.vegCutoffAt != null && now > run.vegCutoffAt;
}

/** Vegetables first, then by the smallest product sort in the category, then by name. */
export function categoryOrder(categories: string[], products: Product[] = []): string[] {
  const minSort = new Map<string, number>();
  for (const p of products) minSort.set(p.category, Math.min(minSort.get(p.category) ?? Infinity, p.sort));
  return [...new Set(categories)].sort((a, b) => {
    if (a === VEG_CATEGORY) return -1;
    if (b === VEG_CATEGORY) return 1;
    const sa = minSort.get(a) ?? Infinity;
    const sb = minSort.get(b) ?? Infinity;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.localeCompare(b);
  });
}

// ---- packing list ------------------------------------------------------------------

export interface PackRow {
  productId: string;
  name: string;
  packLabel: string | null;
  category: string;
  unit: ProductUnit;
  qty: number;
  cents: number;
  customers: Array<{ orderId: number; name: string; qty: number; status: Order['status'] }>;
}

export interface PackGroup {
  category: string;
  rows: PackRow[];
}

/** Sums non-cancelled orders per product, grouped by category (Vegetables first). */
export function aggregatePacking(orders: Order[], products: Product[] = []): PackGroup[] {
  const rows = new Map<string, PackRow>();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const it of o.items) {
      let r = rows.get(it.productId);
      if (!r) {
        r = {
          productId: it.productId,
          name: it.name,
          packLabel: it.packLabel,
          category: it.category,
          unit: it.unit,
          qty: 0,
          cents: 0,
          customers: [],
        };
        rows.set(it.productId, r);
      }
      r.qty += it.qty;
      r.cents += it.lineTotalCents;
      r.customers.push({ orderId: o.id, name: o.customerName, qty: it.qty, status: o.status });
    }
  }
  const sortOf = new Map(products.map((p) => [p.id, p.sort]));
  const all = [...rows.values()];
  return categoryOrder(
    all.map((r) => r.category),
    products,
  ).map((category) => ({
    category,
    rows: all
      .filter((r) => r.category === category)
      .sort((a, b) => (sortOf.get(a.productId) ?? 0) - (sortOf.get(b.productId) ?? 0) || a.name.localeCompare(b.name)),
  }));
}

// ---- clipboard ---------------------------------------------------------------------

/** Copies text; falls back to a hidden textarea where the Clipboard API is unavailable (plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function errMsg(err: unknown, fallback = 'Something went wrong.'): string {
  return err instanceof Error ? err.message : fallback;
}
