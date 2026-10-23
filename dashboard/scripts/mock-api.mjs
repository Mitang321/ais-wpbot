// In-memory mock of the wa-server REST API (CONTRACT.md section 1) for local dashboard work.
// Usage: node scripts/mock-api.mjs   (PORT=3000, MOCK_PASSWORD=test by default)
//
// Extras for manual testing:
//   - sending text containing "fail" returns 502 and stores a failed message
//   - outbound statuses advance sent -> delivered (2s) -> read (5s)
//   - with autoReply on, an allowed contact's inbound "hi" gets a bot reply
//   - POST /mock/inbound { phone, text, name? } simulates a webhook message
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.MOCK_PASSWORD || 'test';
const H = 3_600_000;
const now = Date.now();

const tokens = new Map(); // token -> expiresAt
const settings = { autoReply: false, allowedPhones: ['919812345678'] };
const contacts = new Map(); // phone -> { phone, name, lastInboundAt, unread }
const messages = []; // Message[]

let seq = 0;
const wamid = () => `wamid.MOCK${Date.now()}${++seq}`;

function addContact(phone, name, lastInboundAt, unread = 0) {
  contacts.set(phone, { phone, name, lastInboundAt, unread });
}
function addMsg(m) {
  const msg = { id: wamid(), auto: false, type: 'text', ...m };
  messages.push(msg);
  return msg;
}

// --- seed data -------------------------------------------------------------
addContact('919812345678', 'Ravi Traders', now - 20 * 60_000, 0);
addMsg({ phone: '919812345678', direction: 'in', text: 'hi', status: 'received', ts: now - 26 * H });
addMsg({ phone: '919812345678', direction: 'out', text: 'Hello! Type a model number to search the catalog.', status: 'read', auto: true, ts: now - 26 * H + 3000 });
addMsg({ phone: '919812345678', direction: 'in', text: 'Do you have HP i5 laptops?', status: 'received', ts: now - 25 * 60_000 });
addMsg({ phone: '919812345678', direction: 'out', text: '*HP 250 G9*  (LAPTOP)\ncpu: i5-1235U\nram: 8GB\nssd: 512GB\nhttps://ais.mitangs.tech/product/abc123', status: 'delivered', auto: true, ts: now - 25 * 60_000 + 2000 });
addMsg({ phone: '919812345678', direction: 'in', text: 'Great, thanks. Any stock of the 15 inch?', status: 'received', ts: now - 20 * 60_000 });

addContact('917700011122', null, now - 3 * 24 * H, 0);
addMsg({ phone: '917700011122', direction: 'out', text: 'hello_world', type: 'template', status: 'read', ts: now - 4 * 24 * H });
addMsg({ phone: '917700011122', direction: 'in', text: 'Who is this?', status: 'received', ts: now - 3 * 24 * H });
addMsg({ phone: '917700011122', direction: 'out', text: 'Hi, this is AIS. Following up on the quote.', status: 'failed', error: '(#131047) Re-engagement message: more than 24 hours have passed', ts: now - 3 * 24 * H + 25 * H });

addContact('447911123456', 'Priya (UK)', now - 2 * H, 2);
addMsg({ phone: '447911123456', direction: 'in', text: 'Hello, is the Dell 7420 still available?', status: 'received', ts: now - 2 * H - 60_000 });
addMsg({ phone: '447911123456', direction: 'in', text: '[image]', type: 'image', status: 'received', ts: now - 2 * H });

// --- helpers -----------------------------------------------------------------
function conversation(phone) {
  const c = contacts.get(phone);
  const msgs = messages.filter((m) => m.phone === phone);
  const last = msgs[msgs.length - 1];
  return {
    phone,
    name: c.name,
    lastMessageAt: last ? last.ts : 0,
    lastMessagePreview: last ? last.text.split('\n')[0].slice(0, 80) : '',
    lastInboundAt: c.lastInboundAt,
    windowOpen: c.lastInboundAt != null && Date.now() - c.lastInboundAt < 24 * H,
    unread: c.unread,
    allowed: settings.allowedPhones.includes(phone),
  };
}

function advanceStatus(msg) {
  setTimeout(() => msg.status === 'sent' && (msg.status = 'delivered'), 2000);
  setTimeout(() => msg.status === 'delivered' && (msg.status = 'read'), 5000);
}

function inbound(phone, text, name) {
  if (!contacts.has(phone)) addContact(phone, name ?? null, null, 0);
  const c = contacts.get(phone);
  if (name) c.name = name;
  c.lastInboundAt = Date.now();
  c.unread += 1;
  addMsg({ phone, direction: 'in', text, status: 'received', ts: Date.now() });
  if (settings.autoReply && settings.allowedPhones.includes(phone)) {
    const reply = /^(hi|hello|menu|help)$/i.test(text.trim())
      ? 'Hi! Categories: LAPTOP, DESKTOP, MONITOR.\nType a model to search.'
      : `No match for "${text}". Try a model number, or type *menu*.`;
    advanceStatus(addMsg({ phone, direction: 'out', text: reply, status: 'sent', auto: true, ts: Date.now() + 500 }));
  }
}

function send(res, status, body, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(body));
}
const fail = (res, status, error, message, origin) => send(res, status, { ok: false, error, message }, origin);

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- server --------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  console.log(req.method, req.url);

  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
  if (path === '/health') return send(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), rssMb: 30, catalog: { products: 0, categories: 0, loadedAt: null } }, origin);

  const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
  if (body === null) return fail(res, 400, 'bad_json', 'Body is not valid JSON.', origin);

  if (path === '/api/login' && req.method === 'POST') {
    if (body.password !== PASSWORD) return fail(res, 401, 'bad_password', 'Wrong password.', origin);
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 12 * H;
    tokens.set(token, expiresAt);
    return send(res, 200, { ok: true, token, expiresAt }, origin);
  }

  if (path === '/mock/inbound' && req.method === 'POST') {
    inbound(String(body.phone).replace(/\D/g, ''), String(body.text ?? ''), body.name);
    return send(res, 200, { ok: true }, origin);
  }

  if (path.startsWith('/api/')) {
    const auth = req.headers.authorization || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const exp = tokens.get(tok);
    if (!exp || exp < Date.now()) return fail(res, 401, 'unauthorized', 'Missing or expired token.', origin);
  }

  if (path === '/api/conversations' && req.method === 'GET') {
    const list = [...contacts.keys()].map(conversation).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return send(res, 200, { ok: true, conversations: list }, origin);
  }

  const m = path.match(/^\/api\/conversations\/(\d+)$/);
  if (m && req.method === 'GET') {
    const phone = m[1];
    if (!contacts.has(phone)) return fail(res, 404, 'not_found', 'No conversation with this number.', origin);
    contacts.get(phone).unread = 0;
    const before = Number(url.searchParams.get('before')) || Infinity;
    const msgs = messages.filter((x) => x.phone === phone && x.ts < before).slice(-200);
    return send(res, 200, { ok: true, contact: conversation(phone), messages: msgs }, origin);
  }

  if (path === '/api/send' && req.method === 'POST') {
    const to = String(body.to ?? '').replace(/\D/g, '');
    const text = String(body.text ?? '').trim();
    if (!to || !text) return fail(res, 400, 'bad_request', '`to` and `text` are required.', origin);
    if (!contacts.has(to) || !conversation(to).windowOpen)
      return fail(res, 409, 'window_closed', 'The 24h window is closed. Send a template instead.', origin);
    if (/fail/i.test(text)) {
      addMsg({ phone: to, direction: 'out', text, status: 'failed', error: '(#131000) Something went wrong (mock)', ts: Date.now() });
      return fail(res, 502, 'whatsapp_error', 'WhatsApp API error: (#131000) Something went wrong (mock)', origin);
    }
    await new Promise((r) => setTimeout(r, 400));
    const msg = addMsg({ phone: to, direction: 'out', text, status: 'sent', ts: Date.now() });
    advanceStatus(msg);
    return send(res, 200, { ok: true, message: msg }, origin);
  }

  if (path === '/api/send-template' && req.method === 'POST') {
    const to = String(body.to ?? '').replace(/\D/g, '');
    const template = String(body.template ?? '').trim();
    if (!to || !template) return fail(res, 400, 'bad_request', '`to` and `template` are required.', origin);
    if (template !== 'hello_world') return fail(res, 502, 'whatsapp_error', `WhatsApp API error: (#132001) Template name does not exist in the translation (${template})`, origin);
    if (!contacts.has(to)) addContact(to, null, null, 0);
    const msg = addMsg({ phone: to, direction: 'out', type: 'template', text: template, status: 'sent', ts: Date.now() });
    advanceStatus(msg);
    return send(res, 200, { ok: true, message: msg }, origin);
  }

  if (path === '/api/settings' && req.method === 'GET') return send(res, 200, { ok: true, settings }, origin);
  if (path === '/api/settings' && req.method === 'PUT') {
    if (typeof body.autoReply === 'boolean') settings.autoReply = body.autoReply;
    if (Array.isArray(body.allowedPhones))
      settings.allowedPhones = [...new Set(body.allowedPhones.map((p) => String(p).replace(/\D/g, '')).filter(Boolean))];
    return send(res, 200, { ok: true, settings }, origin);
  }

  return fail(res, 404, 'not_found', `No route ${req.method} ${path}`, origin);
});

server.listen(PORT, () => console.log(`mock wa-api on http://localhost:${PORT}  (password: ${PASSWORD})`));
