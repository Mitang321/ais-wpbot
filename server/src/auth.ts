/** Stateless dashboard sessions: token = "<expiresAt>.<hex HMAC(SESSION_SECRET, expiresAt)>". */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sign = (secret: string, expiresAt: string) =>
  createHmac('sha256', secret).update(`wa-session.${expiresAt}`).digest('hex');

export function issueToken(secret: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_TTL_MS;
  return { token: `${expiresAt}.${sign(secret, String(expiresAt))}`, expiresAt };
}

export function verifyToken(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const m = /^(\d{13,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = m[1]!;
  if (Number(exp) <= now) return false;
  const a = Buffer.from(m[2]!, 'hex');
  const b = Buffer.from(sign(secret, exp), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time string compare (hash both sides so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Fixed-window counter per key (e.g. IP). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** Returns true if the attempt is allowed. */
  take(key: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) this.prune(now);
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    e.count++;
    return e.count <= this.max;
  }

  prune(now = Date.now()): void {
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
  }
}
