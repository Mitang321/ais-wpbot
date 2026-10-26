/** Meta Graph API client (send only) + webhook signature check. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SendResult = { ok: true; id: string } | { ok: false; error: string; status: number };

export interface WhatsAppOpts {
  graphBaseUrl: string;
  phoneNumberId: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WhatsAppClient {
  constructor(private opts: WhatsAppOpts) {}

  sendText(to: string, text: string): Promise<SendResult> {
    return this.post({ to, type: 'text', text: { body: text, preview_url: true } });
  }

  sendTemplate(to: string, name: string, language: string): Promise<SendResult> {
    return this.post({ to, type: 'template', template: { name, language: { code: language } } });
  }

  /** Interactive reply-buttons message: at most 3 buttons, titles <= 20 chars, body <= 1024 chars. */
  sendButtons(to: string, body: string, buttons: Array<{ id: string; title: string }>): Promise<SendResult> {
    if (!buttons.length || buttons.length > 3) {
      return Promise.resolve({ ok: false, status: 0, error: 'Reply buttons: 1 to 3 buttons allowed' });
    }
    const long = buttons.find((b) => b.title.length > 20 || !b.title || !b.id || b.id.length > 256);
    if (long) return Promise.resolve({ ok: false, status: 0, error: `Reply buttons: invalid button "${long.title}"` });
    if (!body || body.length > 1024) {
      return Promise.resolve({ ok: false, status: 0, error: 'Reply buttons: body must be 1 to 1024 characters' });
    }
    return this.post({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    });
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.graphBaseUrl}/${encodeURIComponent(this.opts.phoneNumberId)}/messages`;
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      return { ok: false, status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    const id = json?.messages?.[0]?.id;
    if (res.ok && typeof id === 'string') return { ok: true, id };
    const e = json?.error;
    let error = typeof e?.message === 'string' ? e.message : `Graph API HTTP ${res.status}`;
    const details = e?.error_data?.details;
    if (typeof details === 'string' && details && !error.includes(details)) error += ` — ${details}`;
    if (typeof e?.code === 'number') error += ` (code ${e.code})`;
    return { ok: false, status: res.status, error };
  }
}

/** Verifies `X-Hub-Signature-256: sha256=<hex>` over the raw body (timing-safe). */
export function verifyMetaSignature(appSecret: string, rawBody: Uint8Array, header: string | undefined): boolean {
  if (!header) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
