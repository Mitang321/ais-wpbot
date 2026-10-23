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
} from './types.js';

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
`;

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

const DEFAULT_SETTINGS: Settings = { autoReply: false, allowedPhones: [] };

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
          autoReply: v.autoReply === true,
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

export function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  return new Store(join(dataDir, 'wa.db'));
}
