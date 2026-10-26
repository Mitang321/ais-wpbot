/**
 * Gemini "shop assistant": one call that decides what the customer wants (order, question, list, my order,
 * cancel, greeting) and writes a short answer for questions. Used only when the rule parser can't fully read a
 * message, so plain orders stay instant. Never throws: returns null on any failure (caller falls back to rules).
 */
import type { Product } from './types.js';
import { normalizeQty, type ParsedLine } from './parser.js';
import { errMsg, type Logger } from './log.js';

export type Intent = 'order' | 'answer' | 'list' | 'my_order' | 'cancel' | 'greeting';

export interface AssistantResult {
  intent: Intent;
  lines: ParsedLine[];
  unmatched: string[];
  reply: string;
}

export interface AssistantInput {
  storeName: string;
  /** Delivery info as plain text (town, date, pickup, cutoffs), or "No delivery scheduled". */
  delivery: string;
  /** Active products, with `closed` true when its category's cutoff has passed. */
  products: Array<Product & { closed: boolean }>;
  /** The customer's current order as text, or "none". */
  currentOrder: string;
  /** Recent chat, oldest first, e.g. "Customer: hi" / "Shop: Namaste…". */
  history: string[];
  message: string;
}

export interface AssistantOpts {
  apiKey: string;
  model: string;
  api?: 'vertex' | 'studio';
  log: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You are the friendly WhatsApp assistant of an Indian grocery store in France that delivers to nearby towns.
Customers are Indian families; they write in English, Hinglish, Hindi, Gujarati or French, often with typos.
Decide the intent of the customer's latest message:
- "order": they want to buy or add items (e.g. "2 kaju katli and some bhindi", "add 1 more atta", "I need rice 20kg"). Fill lines.
- "answer": a question or anything else (availability, price, delivery date/time/place, payment, "do you have paneer?", thanks, chit-chat). Write reply.
- "list": they want to see all products / the price list.
- "my_order": they want to see their current order.
- "cancel": they want to cancel their whole order.
- "greeting": just hello / hi / namaste with nothing else.
Order lines: match each item to exactly one productId from the catalogue. qty is in the product unit: unit "kg" means kilograms (500 g -> 0.5); pack/pc/bunch means number of packs ("500g" of a "250 g box" -> 2; "1 bag 20kg" of a "20 kg bag" -> 1). Default qty 1 ("some", "a little" -> 1 for packs, 0.5 kg for kg items). Prefer the pack size matching a stated weight. Put requested items that are not in the catalogue in unmatched. Never invent productIds. Include items from CLOSED categories too (the shop explains the cutoff).
Replies (for "answer"): warm, short (1-4 lines), simple English (mirror Hinglish lightly if the customer uses it), 1-2 emojis max. Use ONLY the facts given (delivery info, catalogue, prices in EUR, current order). Payment is at pickup. If something is not in the catalogue, say so kindly and suggest a close item if there is one. If you don't know, say the shop owner will reply. End questions about products with how to order, e.g. "Just type *paneer 1* to add it 🙂" (use the product name, never the productId). Never say an order was placed or changed: for "order" intent the shop shows a summary with Confirm buttons, so leave reply empty.
Respond with ONLY this JSON: {"intent": "order|answer|list|my_order|cancel|greeting", "lines": [{"productId": "...", "qty": 1, "raw": "..."}], "unmatched": ["..."], "reply": "..."}`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['order', 'answer', 'list', 'my_order', 'cancel', 'greeting'] },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { productId: { type: 'STRING' }, qty: { type: 'NUMBER' }, raw: { type: 'STRING' } },
        required: ['productId', 'qty', 'raw'],
      },
    },
    unmatched: { type: 'ARRAY', items: { type: 'STRING' } },
    reply: { type: 'STRING' },
  },
  required: ['intent', 'lines', 'unmatched', 'reply'],
};

const INTENTS = new Set<Intent>(['order', 'answer', 'list', 'my_order', 'cancel', 'greeting']);

/** Set after the model rejected the strict request once; later calls go straight to plain JSON mode. */
let simple400 = false;

export async function askAssistant(input: AssistantInput, opts: AssistantOpts): Promise<AssistantResult | null> {
  const started = Date.now();
  try {
    const f = opts.fetch ?? globalThis.fetch;
    const catalogue = input.products
      .map((p) => {
        const price = `€${(p.priceCents / 100).toFixed(2)}${p.unit === 'kg' ? '/kg' : ''}`;
        return `${p.id} | ${p.name} | ${p.category}${p.closed ? ' (CLOSED for this delivery)' : ''} | ${p.unit} | ${p.packLabel ?? ''} | ${price} | ${p.aliases.join(', ')}`;
      })
      .join('\n');
    const context = [
      `Store: ${input.storeName}`,
      `Delivery: ${input.delivery}`,
      `Customer's current order: ${input.currentOrder}`,
      '',
      'Catalogue (id | name | category | unit | packLabel | price | aliases):',
      catalogue,
      '',
      'Recent chat:',
      ...(input.history.length ? input.history : ['(none)']),
      '',
      `Customer's latest message:\n${input.message}`,
    ].join('\n');

    const model = encodeURIComponent(opts.model);
    const call = (simple: boolean) =>
      f(
        opts.api === 'studio'
          ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
          : `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: context }] }],
          // Some models reject a strict schema or thinkingConfig (HTTP 400): retry with plain JSON mode.
          generationConfig: simple
            ? { responseMimeType: 'application/json', temperature: 0.2 }
            : {
                responseMimeType: 'application/json',
                responseSchema: RESPONSE_SCHEMA,
                temperature: 0.2,
                maxOutputTokens: 800,
                thinkingConfig: { thinkingLevel: 'minimal' },
              },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      });
    let res = await call(simple400);
    if (res.status === 400 && !simple400) {
      const body = await res.text().catch(() => '');
      opts.log.warn(`assistant: Gemini 400, retrying without schema: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
      simple400 = true;
      res = await call(true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini HTTP ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    const out = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
    const json = out.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const parsed = JSON.parse(json) as { intent?: unknown; lines?: unknown; unmatched?: unknown; reply?: unknown };
    const intent = String(parsed.intent ?? '') as Intent;
    if (!INTENTS.has(intent)) throw new Error(`bad intent ${JSON.stringify(parsed.intent)}`);

    const byId = new Map(input.products.map((p) => [p.id, p]));
    const lines: ParsedLine[] = [];
    for (const l of Array.isArray(parsed.lines) ? (parsed.lines as any[]) : []) {
      const p = byId.get(String(l?.productId ?? ''));
      const qty = Number(l?.qty);
      if (!p || !Number.isFinite(qty) || qty <= 0) continue; // drop bad lines, keep the rest
      const prev = lines.find((x) => x.productId === p.id);
      if (prev) prev.qty = normalizeQty(p, prev.qty + qty);
      else lines.push({ productId: p.id, qty: normalizeQty(p, qty), raw: String(l?.raw ?? '').trim() });
    }
    const unmatched = Array.isArray(parsed.unmatched)
      ? (parsed.unmatched as unknown[]).map((s) => String(s).trim()).filter(Boolean)
      : [];
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 1500) : '';
    opts.log.info(`assistant: ${intent} (${lines.length} lines) in ${Date.now() - started} ms`);
    return { intent, lines, unmatched, reply };
  } catch (err) {
    opts.log.warn(`assistant: failed after ${Date.now() - started} ms, using rules: ${errMsg(err)}`);
    return null;
  }
}
