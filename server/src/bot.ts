/**
 * Core logic shared by the webhook and the REST API: store inbound messages
 * and statuses, send outbound messages, and the grocery ordering conversation
 * (GROCERY-CONTRACT §4).
 */
import { randomUUID } from 'node:crypto';
import type { ItemInput, Store } from './db.js';
import { roundQty } from './db.js';
import type { WhatsAppClient, SendResult } from './whatsapp.js';
import type { Message, MessageStatus, MessageType, Order, OrderItem, Product, Run } from './types.js';
import { parseOrder, parseOrderRules, type ParseResult } from './parser.js';
import { askAssistant } from './assistant.js';
import { errMsg, maskPhone, type Logger } from './log.js';

export interface BotDeps {
  store: Store;
  wa: WhatsAppClient;
  storeName: string;
  geminiApiKey: string | null;
  geminiModel: string;
  log: Logger;
  now?: () => number;
  /** Test hook: replaces parseOrder(). */
  parse?: (text: string, products: Product[]) => Promise<ParseResult>;
}

export type SendOutcome = { ok: true; message: Message } | { ok: false; message: Message; error: string };

/** Draft kept in the `sessions` table while waiting for Confirm / Change. */
export interface DraftSession {
  step: 'confirm';
  runId: number;
  lines: ItemInput[];
}

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ECHO = 60;
const MAX_LIST_CHARS = 3500;
const VEG = 'Vegetables';

const GREET = new Set(['hi', 'hii', 'hello', 'hey', 'namaste', 'namaskar', 'menu', 'start', 'help']);
const LIST = new Set(['list', 'products', 'product', 'price', 'prices', 'catalog', 'catalogue']);
const MY_ORDER = new Set(['my order', 'order', 'status', 'myorder']);
const CANCEL = new Set(['cancel', 'cancel order', 'cancel my order']);
const YES = new Set(['yes', 'y', 'ok', 'okay', 'confirm', 'haan', 'ha', 'han', 'done']);
const NO = new Set(['no', 'n', 'change']);

export const BUTTONS = [
  { id: 'confirm', title: '✅ Confirm' },
  { id: 'change', title: '✏️ Change' },
];

export class Bot {
  constructor(private d: BotDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // ---------- outbound ----------

  private async record(
    phone: string,
    type: MessageType,
    text: string,
    auto: boolean,
    send: () => Promise<SendResult>,
  ): Promise<SendOutcome> {
    const r = await send();
    const base = { phone, direction: 'out' as const, type, text, auto, ts: this.now() };
    if (r.ok) {
      const message: Message = { ...base, id: r.id, status: 'sent' };
      this.d.store.addMessage(message);
      return { ok: true, message };
    }
    const message: Message = { ...base, id: `local-${randomUUID()}`, status: 'failed', error: r.error };
    this.d.store.addMessage(message);
    this.d.log.warn(`send ${type} to ${maskPhone(phone)} failed: ${r.error}`);
    return { ok: false, message, error: r.error };
  }

  sendText(phone: string, text: string, auto = false): Promise<SendOutcome> {
    return this.record(phone, 'text', text, auto, () => this.d.wa.sendText(phone, text));
  }

  sendTemplate(phone: string, template: string, language: string): Promise<SendOutcome> {
    return this.record(phone, 'template', template, false, () => this.d.wa.sendTemplate(phone, template, language));
  }

  sendButtons(phone: string, body: string, buttons: Array<{ id: string; title: string }>, auto = true): Promise<SendOutcome> {
    return this.record(phone, 'interactive', body, auto, () => this.d.wa.sendButtons(phone, body, buttons));
  }

  // ---------- webhook ----------

  /** Processes one Meta webhook payload (already signature-checked). Never throws. */
  async handleWebhook(payload: unknown): Promise<void> {
    const entries = (payload as any)?.entry;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (change?.field !== 'messages') continue;
        const value = change.value ?? {};
        try {
          await this.handleValue(value);
        } catch (err) {
          this.d.log.error(`webhook: processing failed: ${errMsg(err)}`);
        }
      }
    }
  }

  private async handleValue(value: any): Promise<void> {
    const { store, wa } = this.d;

    // Reply from the number the customer actually wrote to; a mismatch causes Meta error 131047.
    const toId = typeof value.metadata?.phone_number_id === 'string' ? value.metadata.phone_number_id : '';
    if (toId && Array.isArray(value.messages) && toId !== wa.replyFromId) {
      if (toId !== wa.phoneNumberId) {
        this.d.log.warn(`webhook: message sent to phone_number_id ${toId}, WA_PHONE_NUMBER_ID is ${wa.phoneNumberId}; replying from ${toId}`);
      }
      wa.replyFromId = toId;
    }

    if (Array.isArray(value.contacts)) {
      for (const c of value.contacts) {
        const phone = digits(c?.wa_id);
        const name = c?.profile?.name;
        if (phone && typeof name === 'string' && name.trim()) store.setContactName(phone, name.trim().slice(0, 200));
      }
    }

    if (Array.isArray(value.statuses)) {
      for (const s of value.statuses) {
        const id = typeof s?.id === 'string' ? s.id : '';
        const status = s?.status as MessageStatus;
        if (!id || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        let error: string | undefined;
        if (status === 'failed') {
          const e = Array.isArray(s.errors) ? s.errors[0] : undefined;
          const details = e?.error_data?.details;
          error = [e?.title ?? e?.message, details && details !== e?.title ? details : null, e?.code ? `(code ${e.code})` : null]
            .filter(Boolean)
            .join(' — ') || 'Failed';
          this.d.log.warn(`status: ${id} to ${maskPhone(digits(s?.recipient_id))} failed: ${error}`);
        }
        store.updateStatus(id, status, error);
      }
    }

    if (Array.isArray(value.messages)) {
      for (const m of value.messages) {
        const msg = parseInbound(m, this.now());
        if (!msg) continue;
        const isNew = store.addMessage(msg);
        if (!isNew) continue; // Meta retry: already stored, already answered
        this.d.log.info(`inbound ${msg.type} from ${maskPhone(msg.phone)}`);
        if (msg.type === 'text' || msg.type === 'interactive') {
          await this.maybeAutoReply(msg, inboundButtonId(m));
        }
      }
    }
  }

  private async maybeAutoReply(msg: Message, buttonId: string | null): Promise<void> {
    const s = this.d.store.getSettings();
    if (!s.autoReply) return;
    if (s.allowedPhones.length && !s.allowedPhones.includes(msg.phone)) return;
    if (!msg.id.startsWith('local-')) void this.d.wa.markReadTyping(msg.id);
    const started = Date.now();
    try {
      await this.converse(msg.phone, msg.text, buttonId);
      this.d.log.info(`bot: replied to ${maskPhone(msg.phone)} in ${Date.now() - started} ms`);
    } catch (err) {
      this.d.log.error(`bot: reply to ${maskPhone(msg.phone)} failed: ${errMsg(err)}`);
    }
  }

  // ---------- conversation (GROCERY-CONTRACT §4) ----------

  /** Handles one inbound text / button reply from `phone`. */
  async converse(phone: string, text: string, buttonId: string | null = null): Promise<void> {
    const { store } = this.d;
    const now = this.now();
    const t = normalize(text);
    if (!t && !buttonId) return;

    let session = store.getSession<DraftSession>(phone);
    if (session && (now - session.updatedAt > SESSION_TTL_MS || session.state?.step !== 'confirm')) {
      store.clearSession(phone);
      session = null;
    }

    const isYes = buttonId === 'confirm' || (!buttonId && YES.has(t));
    const isNo = buttonId === 'change' || (!buttonId && NO.has(t));
    if (isYes || isNo) {
      if (!session) {
        await this.reply(phone, 'There is nothing waiting to be confirmed 🙂\nJust type your order, e.g. *okra 1kg, 2 kaju katli*');
        return;
      }
      if (isYes) return this.confirm(phone, session.state);
      store.clearSession(phone);
      await this.reply(phone, 'No problem 👍 Send your full order again.');
      return;
    }

    if (GREET.has(t)) return this.reply(phone, this.greeting(now));
    if (LIST.has(t)) {
      for (const part of this.productList(now)) await this.reply(phone, part);
      return;
    }
    if (MY_ORDER.has(t)) return this.reply(phone, this.myOrder(phone, now));
    if (CANCEL.has(t)) return this.cancel(phone, now);
    return this.understand(phone, text, now);
  }

  /**
   * Free text: a clean order the rules fully understand goes straight to confirmation (fast, no AI).
   * Anything else (questions, Hinglish, typos, mixed messages) goes to the Gemini assistant.
   */
  private async understand(phone: string, text: string, now: number): Promise<void> {
    const { store } = this.d;
    if (!this.d.geminiApiKey || this.d.parse) return this.takeOrder(phone, text, now);
    const products = store.listProducts().filter((p) => p.active);
    const rules = parseOrderRules(text, products);
    if (rules.lines.length && !rules.unmatched.length) return this.takeOrder(phone, text, now, rules);

    const run = store.activeRun(now);
    const order = run ? store.findOpenOrder(run.id, phone) : null;
    const history = store
      .getMessages(phone, undefined, 9)
      .slice(0, -1) // the latest message is passed separately
      .map((m) => `${m.direction === 'in' ? 'Customer' : 'Shop'}: ${m.text.slice(0, 300)}`);
    const ai = await askAssistant(
      {
        storeName: this.d.storeName,
        delivery: run
          ? `${run.town}, ${formatDay(run.deliveryDate)}, ${run.deliveryTime}. Pickup: ${run.pickupSpot}. ${cutoffLines(run, now).join(' ')}`
          : 'No delivery scheduled right now.',
        products: products.map((p) => ({ ...p, closed: run ? isCategoryClosed(run, p.category, now) : true })),
        currentOrder: order ? `#${order.id}: ${order.items.map(itemLine).join('; ')} (total ${euros(order.totalCents)})` : 'none',
        history,
        message: text,
      },
      { apiKey: this.d.geminiApiKey, model: this.d.geminiModel, log: this.d.log },
    );
    if (!ai) return this.takeOrder(phone, text, now, rules);
    switch (ai.intent) {
      case 'greeting':
        return this.reply(phone, this.greeting(now));
      case 'list':
        for (const part of this.productList(now)) await this.reply(phone, part);
        return;
      case 'my_order':
        return this.reply(phone, this.myOrder(phone, now));
      case 'cancel':
        return this.cancel(phone, now);
      case 'order':
        if (ai.lines.length) return this.takeOrder(phone, text, now, { lines: ai.lines, unmatched: ai.unmatched, engine: 'gemini' });
        if (ai.reply) return this.reply(phone, ai.reply);
        return this.takeOrder(phone, text, now, rules);
      default:
        if (ai.reply) return this.reply(phone, ai.reply);
        return this.takeOrder(phone, text, now, rules);
    }
  }

  private async reply(phone: string, text: string): Promise<void> {
    await this.sendText(phone, text, true);
  }

  private customerName(phone: string): string {
    return this.d.store.getConversation(phone)?.name?.trim() || phone;
  }

  greeting(now: number): string {
    const run = this.d.store.activeRun(now);
    const hello = `🙏 Namaste! Welcome to *${this.d.storeName}* 🛍️`;
    if (!run) {
      return `${hello}\n\nNo delivery scheduled right now… We'll send a message as soon as the next one is planned 🙏`;
    }
    const lines = [
      hello,
      '',
      `🚚 Next delivery: *${run.town}*`,
      `📅 ${formatDay(run.deliveryDate)}, ${run.deliveryTime}`,
      `📍 Pickup: ${run.pickupSpot}`,
      '',
      ...cutoffLines(run, now),
      '',
      '✍️ Just type your order, e.g. *kaju katli 250g, okra 1kg, 1 bag basmati*',
      '',
      '• *list* – products & prices',
      '• *my order* – see your order',
      '• *cancel* – cancel your order',
    ];
    return lines.join('\n');
  }

  /** Active products by category, split into messages of <= 3500 chars. */
  productList(now: number): string[] {
    const run = this.d.store.activeRun(now);
    const groups = new Map<string, Product[]>();
    for (const p of this.d.store.listProducts()) {
      if (!p.active) continue;
      const g = groups.get(p.category) ?? [];
      g.push(p);
      groups.set(p.category, g);
    }
    if (!groups.size) return ['Our product list is being updated, please try again a bit later 🙏'];
    const blocks: string[] = [`🛒 *${this.d.storeName}* – products & prices`];
    for (const [cat, ps] of groups) {
      const closed = run ? isCategoryClosed(run, cat, now) : false;
      blocks.push([`\n*${cat}*${closed ? ' (closed)' : ''}`, ...ps.map(productLine)].join('\n'));
    }
    blocks.push('\n✍️ To order, just type e.g. *okra 1kg, 2 kaju katli*');
    const out: string[] = [];
    let cur = '';
    for (const b of blocks) {
      for (const piece of splitLong(b, MAX_LIST_CHARS)) {
        if (cur && cur.length + 1 + piece.length > MAX_LIST_CHARS) {
          out.push(cur.trim());
          cur = '';
        }
        cur += (cur ? '\n' : '') + piece;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  myOrder(phone: string, now: number): string {
    const run = this.d.store.activeRun(now);
    if (!run) return 'No delivery scheduled right now… We\'ll let you know when the next one is planned 🙏';
    const order = this.d.store.findOpenOrder(run.id, phone);
    if (!order) {
      return `No order yet for the ${formatDay(run.deliveryDate)} delivery 🙂\nJust type what you need, e.g. *okra 1kg, 2 kaju katli*`;
    }
    const status: Record<Order['status'], string> = {
      confirmed: '✅ Confirmed',
      packed: '📦 Packed',
      collected: '👍 Collected',
      cancelled: '❌ Cancelled',
    };
    return [
      `🧾 *Your order #${order.id}* – ${status[order.status]}${order.paid ? ' · 💶 Paid' : ''}`,
      '',
      ...order.items.map(itemLine),
      '',
      `*Total: ${euros(order.totalCents)}*`,
      `📍 Pickup: ${run.pickupSpot}, ${formatDay(run.deliveryDate)}, ${run.deliveryTime}`,
    ].join('\n');
  }

  private async cancel(phone: string, now: number): Promise<void> {
    const { store } = this.d;
    store.clearSession(phone);
    const run = store.activeRun(now);
    const order = run ? store.findOpenOrder(run.id, phone) : null;
    if (!run || !order) {
      await this.reply(phone, "You don't have an order to cancel 🙂");
      return;
    }
    if (order.status === 'packed' || order.status === 'collected') {
      await this.reply(phone, `Your order #${order.id} is already ${order.status} 📦 so I can't cancel it here. Please message the store directly 🙏`);
      return;
    }
    store.updateOrder(order.id, { status: 'cancelled' }, now);
    await this.reply(phone, `❌ Order #${order.id} is cancelled.\nYou can order again any time before the cutoff 🙂`);
  }

  private async takeOrder(phone: string, text: string, now: number, preParsed?: ParseResult): Promise<void> {
    const { store } = this.d;
    const run = store.activeRun(now);
    if (!run) {
      await this.reply(phone, "No delivery scheduled right now… We'll send a message as soon as the next one is planned 🙏");
      return;
    }
    const products = store.listProducts().filter((p) => p.active);
    const parsed = preParsed ?? await (this.d.parse
      ? this.d.parse(text, products)
      : parseOrder(text, products, {
          geminiApiKey: this.d.geminiApiKey,
          geminiModel: this.d.geminiModel,
          log: this.d.log,
        }));
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = parsed.lines.filter((l) => byId.has(l.productId) && Number.isFinite(l.qty) && l.qty > 0);

    if (!lines.length) {
      const what = parsed.unmatched.length ? parsed.unmatched.join(', ') : text.trim();
      await this.reply(phone, `Sorry, I couldn't find "${echo(what)}" in our list 🙁\nType *list* to see products.`);
      return;
    }

    const open = lines.filter((l) => !isCategoryClosed(run, byId.get(l.productId)!.category, now));
    const dropped = lines.filter((l) => !open.includes(l)).map((l) => byId.get(l.productId)!);
    const closedNote = dropped.length ? closedMessage(run, dropped, now) : '';

    if (!open.length) {
      store.clearSession(phone);
      await this.reply(phone, closedNote);
      return;
    }

    const draft: DraftSession = { step: 'confirm', runId: run.id, lines: open.map((l) => ({ productId: l.productId, qty: l.qty })) };
    store.setSession(phone, draft, now);

    const { items } = store.priceItems(draft.lines);
    const existing = store.findOpenOrder(run.id, phone);
    const parts = [
      existing ? `🧾 Adding to your order #${existing.id}:` : '🧾 Your order:',
      ...items.map(itemLine),
      '',
      `*Total: ${euros(items.reduce((s, i) => s + i.lineTotalCents, 0))}*`,
    ];
    if (parsed.unmatched.length) parts.push(`⚠️ Not found: ${echo(parsed.unmatched.join(', '))}`);
    if (closedNote) parts.push(closedNote);
    parts.push('', 'Is this correct?');
    let body = parts.join('\n');
    if (body.length > 1024) {
      await this.reply(phone, body);
      body = 'Is this order correct?';
    }
    await this.sendButtons(phone, body, BUTTONS);
  }

  private async confirm(phone: string, draft: DraftSession): Promise<void> {
    const { store } = this.d;
    const now = this.now();
    store.clearSession(phone);
    const run = store.getRun(draft.runId);
    if (!run || run.status !== 'open') {
      await this.reply(phone, 'Sorry, ordering for this delivery is closed now 🙏 Type *hi* to see the next delivery.');
      return;
    }
    const { items } = store.priceItems(draft.lines);
    const ok = items.filter((i) => !isCategoryClosed(run, i.category, now));
    if (!ok.length) {
      await this.reply(phone, 'Sorry, the order cutoff has passed for these items 🙏');
      return;
    }
    const existing = store.findOpenOrder(run.id, phone);
    let order: Order;
    if (existing) {
      const merged = store.priceItems([
        ...existing.items.map((i) => ({ productId: i.productId, qty: i.qty })),
        ...ok.map((i) => ({ productId: i.productId, qty: i.qty })),
      ]);
      // Keep old lines for products that were deleted since (priceItems drops unknown ids).
      const kept = existing.items.filter((i) => merged.missing.includes(i.productId));
      order = store.updateOrder(existing.id, { items: [...merged.items, ...kept] }, now)!;
    } else {
      order = store.createOrder({ runId: run.id, phone, customerName: this.customerName(phone), items: ok, source: 'bot' }, now);
    }
    this.d.log.info(`order #${order.id} ${existing ? 'updated' : 'created'} for ${maskPhone(phone)}`);
    await this.reply(
      phone,
      [
        `✅ Order #${order.id} confirmed!`,
        '',
        ...order.items.map(itemLine),
        '',
        `*Total: ${euros(order.totalCents)}*`,
        '',
        `📍 Pickup: ${run.pickupSpot}, ${formatDay(run.deliveryDate)}, ${run.deliveryTime}. Pay at pickup 🙏`,
        'Send more items any time before the cutoff.',
      ].join('\n'),
    );
  }
}

// ---------- helpers ----------

/** GROCERY-CONTRACT §3. */
export function isCategoryClosed(run: Run, category: string, now: number): boolean {
  if (now > run.cutoffAt) return true;
  return category === VEG && run.vegCutoffAt !== null && now > run.vegCutoffAt;
}

function cutoffLines(run: Run, now: number): string[] {
  if (now > run.cutoffAt) return ['⛔ Orders for this delivery are closed.'];
  if (run.vegCutoffAt === null) return [`🛒 Order before ${formatCutoff(run.cutoffAt)}`];
  const veg = now > run.vegCutoffAt
    ? '🥗 Vegetables: closed for this delivery'
    : `🥗 Vegetables: order before ${formatCutoff(run.vegCutoffAt)}`;
  return [veg, `🛒 Everything else: before ${formatCutoff(run.cutoffAt)}`];
}

function closedMessage(run: Run, dropped: Product[], now: number): string {
  const names = dropped.map((p) => p.name).join(', ');
  if (now > run.cutoffAt) return `⛔ Sorry, orders for the ${formatDay(run.deliveryDate)} delivery are closed (${echo(names)}).`;
  return `⛔ Vegetables are closed for this delivery, so I left out: ${echo(names)}`;
}

/** "€12.00" */
export function euros(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function formatQty(q: number): string {
  return String(roundQty(q));
}

/**
 * " (250 g box)", or "" when the label adds nothing: no label, a bare unit word ("bunch", "1 pc"),
 * or a size the name already says ("Kaju katli 250 g" + "250 g box").
 */
export function labelSuffix(name: string, packLabel: string | null): string {
  const label = (packLabel ?? '').replace(/[()]/g, '').trim();
  if (!label || /^(1\s*)?(pc|pcs|piece|bunch|pack)$/i.test(label)) return '';
  const size = /\d+(?:[.,]\d+)?\s*(?:kg|g|l|ml)\b/i.exec(label)?.[0];
  const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '');
  if (size && squash(name).includes(squash(size))) return '';
  return ` (${label})`;
}

/** "2 × Kaju katli (250 g box) — €12.00" / "1 kg Okra — €4.50" */
export function itemLine(i: OrderItem): string {
  if (i.unit === 'kg') return `${formatQty(i.qty)} kg ${i.name} — ${euros(i.lineTotalCents)}`;
  return `${formatQty(i.qty)} × ${i.name}${labelSuffix(i.name, i.packLabel)} — ${euros(i.lineTotalCents)}`;
}

/** "• Okra – €4.50/kg" / "• Kaju katli (250 g box) – €6.00" */
export function productLine(p: Product): string {
  if (p.unit === 'kg') return `• ${p.name} – ${euros(p.priceCents)}/kg`;
  const label = labelSuffix(p.name, p.packLabel);
  if (label) return `• ${p.name}${label} – ${euros(p.priceCents)}`;
  return `• ${p.name} – ${euros(p.priceCents)}${p.unit === 'bunch' ? '/bunch' : ''}`;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "2026-11-06" -> "Friday 6 November" */
export function formatDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return dayFmt.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)));
}

const cutoffFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Europe/Paris',
});

/** ms -> "Sat 31 Oct, 6pm" (Europe/Paris) */
export function formatCutoff(ms: number): string {
  const p = Object.fromEntries(cutoffFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = p.hour === '0' ? '12' : p.hour;
  const time = `${hour}${p.minute && p.minute !== '00' ? `:${p.minute}` : ''}${String(p.dayPeriod ?? '').toLowerCase()}`;
  return `${p.weekday} ${p.day} ${p.month}, ${time}`;
}

/** Lowercase, punctuation -> spaces, collapsed. "My order!" -> "my order" */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function echo(s: string): string {
  const t = s.trim();
  return t.length > MAX_ECHO ? `${t.slice(0, MAX_ECHO)}…` : t;
}

function splitLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let cur = '';
  for (const line of s.split('\n')) {
    if (cur && cur.length + 1 + line.length > max) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}

export function digits(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '';
}

/** Button id of an interactive reply (or template quick-reply payload); not stored. */
export function inboundButtonId(m: any): string | null {
  const id = m?.interactive?.button_reply?.id ?? m?.button?.payload;
  return typeof id === 'string' && id ? id : null;
}

/** Meta inbound message -> our Message (placeholder text for media/other types). */
export function parseInbound(m: any, now: number): Message | null {
  const id = typeof m?.id === 'string' ? m.id : '';
  const phone = digits(m?.from);
  if (!id || !phone) return null;
  const tsSec = Number(m.timestamp);
  const ts = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : now;
  const t = String(m.type ?? 'unknown');

  let type: MessageType = 'other';
  let text: string;
  switch (t) {
    case 'text':
      type = 'text';
      text = String(m.text?.body ?? '');
      break;
    case 'interactive': {
      type = 'interactive';
      const i = m.interactive ?? {};
      text = String(i.button_reply?.title ?? i.list_reply?.title ?? i.nfm_reply?.body ?? '[interactive]');
      break;
    }
    case 'button': // quick-reply button on a template
      type = 'interactive';
      text = String(m.button?.text ?? m.button?.payload ?? '[button]');
      break;
    case 'image': {
      type = 'image';
      const cap = m.image?.caption;
      text = typeof cap === 'string' && cap ? `[image] ${cap}` : '[image]';
      break;
    }
    case 'location':
      text = '[location]';
      break;
    case 'unsupported':
      text = '[unsupported message]';
      break;
    default: {
      const cap = m[t]?.caption;
      text = typeof cap === 'string' && cap ? `[${t}] ${cap}` : `[${t}]`;
    }
  }
  return { id, phone, direction: 'in', type, text: text.slice(0, 4096), status: 'received', auto: false, ts };
}
