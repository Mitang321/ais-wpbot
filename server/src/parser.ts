/**
 * Free-text grocery order parser (GROCERY-CONTRACT.md §5).
 * - parseOrderRules: dependency-free fuzzy matcher (aliases, typos, quantities/units).
 * - parseOrder: tries Gemini first when a key is configured, falls back to the rules. Never throws.
 */
import type { Product } from './types.js';
import { errMsg, type Logger } from './log.js';

export interface ParsedLine { productId: string; qty: number; raw: string }
export interface ParseResult { lines: ParsedLine[]; unmatched: string[]; engine: 'gemini' | 'rules' }

// ---------- vocabulary ----------

const WEIGHT_UNITS: Record<string, number> = {
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000, kilogramme: 1000,
  g: 1, gm: 1, gms: 1, gr: 1, grm: 1, grms: 1, gram: 1, grams: 1, gramme: 1, grammes: 1,
};
const COUNT_UNITS = new Set([
  'pack', 'packs', 'packet', 'packets', 'pkt', 'pkts', 'pk', 'bag', 'bags', 'box', 'boxes', 'tin', 'tins',
  'pc', 'pcs', 'piece', 'pieces', 'bunch', 'bunches', 'x', 'nos', 'no.', 'unit', 'units', 'bottle', 'bottles',
  'l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters', 'jar', 'jars', 'dozen',
]);
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  half: 0.5, quarter: 0.25, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, adha: 0.5, aadha: 0.5,
};
const STOPWORDS = new Set([
  'of', 'the', 'please', 'pls', 'plz', 'plss', 'need', 'needed', 'want', 'wanted', 'i', 'me', 'my', 'some', 'a', 'an',
  'and', 'for', 'to', 'also', 'more', 'add', 'with', 'would', 'like', 'can', 'could', 'get', 'give', 'us', 'we',
  'it', 'is', 'am', 'will', 'take', 'order', 'qty', 'quantity', 'of', 'in', 'on', 'just', 'only', 'each', 'per',
  'kindly', 'send', 'require', 'required', 'bhai', 'ji',
  // greetings / politeness
  'hi', 'hello', 'hey', 'hii', 'hiii', 'namaste', 'namaskar', 'bonjour', 'salut', 'thanks', 'thank', 'you', 'thx',
  'ty', 'merci', 'ok', 'okay', 'regards', 'jsk', 'jai', 'shree', 'shri', 'krishna', 'good', 'morning', 'evening',
  'afternoon', 'dear', 'sir', 'madam', 'list', 'items', 'item', 'below', 'following', 'this', 'week', 'here', 'are',
]);
const SKIP_LINE = /^\s*(?:order\s*)?(?:customer\s*)?name\s*[:\-=]/i;

// ---------- helpers ----------

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** 1 = exact, 0.8 = typo-tolerant match, 0 = no match. */
function tokenSim(phraseTok: string, chunkTok: string): number {
  if (phraseTok === chunkTok) return 1;
  const len = Math.min(phraseTok.length, chunkTok.length);
  if (len < 4) return 0;
  const max = len >= 7 ? 2 : 1;
  return levenshtein(phraseTok, chunkTok, max) <= max ? 0.8 : 0;
}

/** Lowercase, split glued numbers/units ("20Kg" -> "20 kg", "x2" -> "x 2"), drop punctuation. */
function tokenize(s: string): string[] {
  const norm = s
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/×/g, ' x ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^\p{L}\p{N}.,/]+/gu, ' ');
  return norm
    .split(/\s+/)
    .map((t) => (/^\d+(?:[.,]\d+)?$|^\d+\/\d+$/.test(t) ? t : t.replace(/^[.,/]+|[.,/]+$/g, '')))
    .flatMap((t) => (/^\d/.test(t) || !t.includes('/') ? [t] : t.split('/')))
    .filter(Boolean);
}

function parseNumber(t: string): number | null {
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  const f = /^(\d+)\/(\d+)$/.exec(t);
  if (f) return Number(f[2]) ? Number(f[1]) / Number(f[2]) : null;
  return NUMBER_WORDS[t] ?? null;
}

interface Qty { count: number | null; grams: number | null; rest: string[] }

function extractQty(tokens: string[]): Qty {
  let count: number | null = null;
  let grams: number | null = null;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const n = parseNumber(t);
    if (n !== null && n > 0) {
      const next = tokens[i + 1];
      if (next !== undefined && WEIGHT_UNITS[next] !== undefined) {
        if (grams === null) grams = n * WEIGHT_UNITS[next]!;
        i++;
      } else {
        if (next !== undefined && COUNT_UNITS.has(next)) i++;
        if (count === null) count = n;
      }
      continue;
    }
    if (WEIGHT_UNITS[t] !== undefined || COUNT_UNITS.has(t)) continue; // bare unit words ("kg okra", "x")
    rest.push(t);
  }
  return { count, grams, rest };
}

// ---------- product index ----------

interface Indexed { product: Product; phrases: string[][] }
const indexCache = new WeakMap<Product[], Indexed[]>();

function phraseTokens(s: string): string[] {
  return tokenize(s).filter((t) => parseNumber(t) === null && !WEIGHT_UNITS[t] && !COUNT_UNITS.has(t) && !STOPWORDS.has(t));
}

function indexProducts(products: Product[]): Indexed[] {
  const hit = indexCache.get(products);
  if (hit) return hit;
  const out = products.map((product) => {
    const sources = [product.name, product.name.replace(/\(.*?\)/g, ' '), ...product.aliases];
    for (const m of product.name.matchAll(/\(([^)]*)\)/g)) sources.push(...(m[1] ?? '').split('/'));
    const seen = new Set<string>();
    const phrases: string[][] = [];
    for (const src of sources) {
      const toks = phraseTokens(src);
      const key = toks.join(' ');
      if (toks.length && !seen.has(key)) { seen.add(key); phrases.push(toks); }
    }
    return { product, phrases };
  });
  indexCache.set(products, out);
  return out;
}

/** Sum over chunk tokens covered by fully matched phrases (best similarity per token). */
function scoreProduct(ix: Indexed, words: string[]): number {
  const best = new Array<number>(words.length).fill(0);
  for (const phrase of ix.phrases) {
    const hits: Array<[number, number]> = [];
    for (const pt of phrase) {
      let bi = -1, bs = 0;
      words.forEach((w, i) => { const s = tokenSim(pt, w); if (s > bs) { bs = s; bi = i; } });
      if (bi < 0) { hits.length = 0; break; }
      hits.push([bi, bs]);
    }
    for (const [i, s] of hits) if (s > best[i]!) best[i] = s;
  }
  return best.reduce((a, b) => a + b, 0);
}

function packPreference(p: Product, grams: number | null): number {
  if (grams === null || !p.packGrams) return 0;
  if (Math.abs(grams - p.packGrams) <= p.packGrams * 0.05) return 3;
  const r = grams / p.packGrams;
  if (r > 1 && Math.abs(r - Math.round(r)) < 0.05) return 2 + p.packGrams / 1e9; // bigger dividing pack wins
  return 0;
}

export function normalizeQty(p: Product, qty: number): number {
  if (p.unit === 'kg') return Math.max(0.1, Math.round(qty * 10) / 10);
  return Math.max(1, Math.round(qty));
}

function qtyFor(p: Product, q: Qty): number {
  const { count, grams } = q;
  if (p.unit === 'kg') {
    if (grams !== null) return normalizeQty(p, (grams / 1000) * (count ?? 1));
    return normalizeQty(p, count ?? 1);
  }
  if (grams !== null && p.packGrams) {
    const ratio = grams / p.packGrams;
    if (count !== null && Math.abs(count * p.packGrams - grams) <= p.packGrams * 0.05) return normalizeQty(p, count);
    if (Math.abs(ratio - 1) <= 0.05) return normalizeQty(p, count ?? 1);
    if (ratio > 1) return normalizeQty(p, Math.round(ratio) * (count ?? 1));
    return normalizeQty(p, count ?? 1);
  }
  return normalizeQty(p, count ?? 1);
}

function splitChunks(text: string): string[] {
  return text
    .split(/\r?\n|;|&|\+|\band\b|(?<!\d),|,(?!\d)/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function mergeLines(lines: ParsedLine[]): ParsedLine[] {
  const by = new Map<string, ParsedLine>();
  for (const l of lines) {
    const prev = by.get(l.productId);
    if (prev) { prev.qty += l.qty; prev.raw = `${prev.raw} + ${l.raw}`; }
    else by.set(l.productId, { ...l });
  }
  return [...by.values()];
}

// ---------- rules engine ----------

export function parseOrderRules(text: string, products: Product[]): ParseResult {
  const active = products.filter((p) => p.active);
  const index = indexProducts(active);
  const lines: ParsedLine[] = [];
  const unmatched: string[] = [];

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (SKIP_LINE.test(line)) continue;
    for (const raw of splitChunks(line)) {
      const tokens = tokenize(raw);
      const q = extractQty(tokens);
      const words = q.rest.filter((t) => !STOPWORDS.has(t));
      if (!words.length) {
        if (q.count !== null || q.grams !== null) unmatched.push(raw);
        continue;
      }
      let best: { p: Product; score: number; pref: number } | null = null;
      for (const ix of index) {
        const score = scoreProduct(ix, words);
        if (score <= 0) continue;
        const pref = packPreference(ix.product, q.grams);
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && pref > best.pref)) {
          best = { p: ix.product, score, pref };
        }
      }
      if (!best) { unmatched.push(raw); continue; }
      lines.push({ productId: best.p.id, qty: qtyFor(best.p, q), raw });
    }
  }
  const merged = mergeLines(lines).map((l) => {
    const p = active.find((x) => x.id === l.productId)!;
    return { ...l, qty: normalizeQty(p, l.qty) };
  });
  return { lines: merged, unmatched, engine: 'rules' };
}

// ---------- Gemini engine ----------

export interface ParseOptions {
  geminiApiKey: string | null;
  geminiModel: string;
  log: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SYSTEM_PROMPT =
  'You convert WhatsApp grocery orders for an Indian grocery store into structured lines. ' +
  'Customers write in English, Hinglish, Gujarati or French, with typos. Match each requested item to exactly one ' +
  'productId from the catalogue. qty is in the product unit: for unit "kg" it is kilograms (500 g -> 0.5); for ' +
  'pack/pc/bunch it is the number of packs (e.g. "500g" of a "250 g box" -> 2; "1 pack (20kg)" of a "20 kg bag" -> 1). ' +
  'Default qty is 1. Prefer the pack size matching the stated weight. Ignore greetings, names and "Order Name:" lines. ' +
  'Put requested items that are not in the catalogue in unmatched (original text). Never invent productIds.';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { productId: { type: 'STRING' }, qty: { type: 'NUMBER' }, raw: { type: 'STRING' } },
        required: ['productId', 'qty', 'raw'],
      },
    },
    unmatched: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['lines', 'unmatched'],
};

async function parseWithGemini(text: string, products: Product[], opts: ParseOptions): Promise<ParseResult> {
  const f = opts.fetch ?? globalThis.fetch;
  const catalogue = products
    .map((p) => `${p.id} | ${p.name} | ${p.unit} | ${p.packLabel ?? ''} | ${p.aliases.join(', ')}`)
    .join('\n');
  const model = encodeURIComponent(opts.geminiModel || 'gemini-flash-lite-latest');
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.geminiApiKey! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [{ text: `Catalogue (id | name | unit | packLabel | aliases):\n${catalogue}\n\nCustomer message:\n${text}` }],
      }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const out = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
  if (!out) throw new Error('Gemini returned no text');
  const parsed = JSON.parse(out) as { lines?: unknown; unmatched?: unknown };
  if (!Array.isArray(parsed.lines)) throw new Error('Gemini output has no lines array');

  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: ParsedLine[] = [];
  for (const l of parsed.lines as any[]) {
    const p = byId.get(String(l?.productId ?? ''));
    if (!p) throw new Error(`Gemini returned unknown productId ${JSON.stringify(String(l?.productId ?? '')).slice(0, 60)}`);
    const qty = Number(l?.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Gemini returned invalid qty for ${p.id}`);
    lines.push({ productId: p.id, qty: normalizeQty(p, qty), raw: String(l?.raw ?? '').trim() });
  }
  const merged = mergeLines(lines).map((l) => ({ ...l, qty: normalizeQty(byId.get(l.productId)!, l.qty) }));
  const unmatched = Array.isArray(parsed.unmatched)
    ? (parsed.unmatched as unknown[]).map((s) => String(s).trim()).filter(Boolean)
    : [];
  return { lines: merged, unmatched, engine: 'gemini' };
}

export async function parseOrder(text: string, products: Product[], opts: ParseOptions): Promise<ParseResult> {
  let rules: ParseResult;
  try {
    rules = parseOrderRules(text, products);
  } catch (err) {
    opts.log.error(`parser: rules failed: ${errMsg(err)}`);
    rules = { lines: [], unmatched: String(text ?? '').trim() ? [String(text).trim()] : [], engine: 'rules' };
  }
  if (!opts.geminiApiKey) return rules;
  try {
    const active = products.filter((p) => p.active);
    const g = await parseWithGemini(text, active, opts);
    if (g.lines.length === 0 && rules.lines.length > 0) {
      opts.log.warn('parser: Gemini found no lines but rules did; using rules');
      return rules;
    }
    return g;
  } catch (err) {
    opts.log.warn(`parser: Gemini failed, using rules: ${errMsg(err)}`);
    return rules;
  }
}
