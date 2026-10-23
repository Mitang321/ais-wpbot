import { useEffect, useRef } from 'react';
import type { Conversation } from './types';

/** Digits only: strips "+", spaces, dashes, brackets. */
export function normalizePhone(input: string): string {
  return input.replace(/\D+/g, '');
}

/** "919812345678" -> "+91 98123 45678". Good enough for display. */
export function formatPhone(phone: string): string {
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
