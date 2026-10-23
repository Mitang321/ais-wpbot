/**
 * Core logic shared by the webhook and the REST API: store inbound messages
 * and statuses, send outbound messages, auto-reply (CONTRACT §2).
 */
import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import type { CatalogClient, Product } from './catalog.js';
import { search } from './catalog.js';
import type { WhatsAppClient, SendResult } from './whatsapp.js';
import type { Message, MessageStatus, MessageType } from './types.js';
import { errMsg, maskPhone, type Logger } from './log.js';

export interface BotDeps {
  store: Store;
  wa: WhatsAppClient;
  catalog: CatalogClient;
  appBaseUrl: string;
  log: Logger;
  now?: () => number;
}

export type SendOutcome = { ok: true; message: Message } | { ok: false; message: Message; error: string };

const GREETING = /^(hi|hello|menu|help)[\s!.?]*$/i;
const MAX_QUERY_ECHO = 60;

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
    const { store } = this.d;

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
          await this.maybeAutoReply(msg);
        }
      }
    }
  }

  private async maybeAutoReply(msg: Message): Promise<void> {
    const settings = this.d.store.getSettings();
    if (!settings.autoReply || !settings.allowedPhones.includes(msg.phone)) return;
    const reply = this.replyFor(msg.text);
    if (!reply) return;
    await this.sendText(msg.phone, reply, true);
  }

  /** Builds the auto-reply text for an incoming message (CONTRACT §2). No prices, ever. */
  replyFor(text: string): string | null {
    const q = text.trim();
    if (!q) return null;
    const snap = this.d.catalog.snapshot;
    if (GREETING.test(q)) {
      const cats = snap.categories.length
        ? snap.categories.map((c) => `• ${c}`).join('\n')
        : '(catalog is loading, try again in a minute)';
      return `Hi! I can look up products from the AIS catalog.\n\n*Categories*\n${cats}\n\nType a model to search, e.g. a model number, part number or series.`;
    }
    const results = search(snap.products, q, 3);
    if (!results.length) {
      const echo = q.length > MAX_QUERY_ECHO ? `${q.slice(0, MAX_QUERY_ECHO)}…` : q;
      return `No match for "${echo}". Try a model number, or type *menu*.`;
    }
    return results.map((p) => formatProduct(p, this.d.appBaseUrl)).join('\n\n');
  }
}

export function formatProduct(p: Product, baseUrl: string): string {
  const lines = [`*${p.modelNumber}*  (${p.category})`];
  for (const a of p.topAttrs) lines.push(`${a.k}: ${a.v}`);
  lines.push(`${baseUrl}/product/${encodeURIComponent(p.id)}`);
  return lines.join('\n');
}

export function digits(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '';
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
