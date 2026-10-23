import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { dayKey, dayLabel, displayName, formatPhone, initials, usePolling } from '../lib';
import type { Conversation, Message, UiMessage } from '../types';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { Avatar, Button, ErrorNote, Spinner } from './ui';

const THREAD_POLL_MS = 3000;
const PAGE_SIZE = 200;

function windowLabel(c: Conversation | null): string {
  if (!c) return '';
  if (!c.windowOpen || !c.lastInboundAt) return '24h window closed';
  const left = c.lastInboundAt + 86_400_000 - Date.now();
  if (left <= 0) return '24h window closed';
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return `Window open · ${h > 0 ? `${h}h ` : ''}${m}m left`;
}

function mergeById(...lists: Message[][]): Message[] {
  const map = new Map<string, Message>();
  for (const list of lists) for (const m of list) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

export function ChatThread({
  phone,
  fallback,
  allowed,
  allowBusy,
  onToggleAllowed,
  onBack,
  onActivity,
}: {
  phone: string;
  /** Row from the conversation list, shown until the thread loads. */
  fallback: Conversation | undefined;
  allowed: boolean;
  allowBusy: boolean;
  onToggleAllowed: () => void;
  onBack: () => void;
  /** Called after a send or a read so the list can refresh. */
  onActivity: () => void;
}): JSX.Element {
  const [contact, setContact] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [older, setOlder] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [locals, setLocals] = useState<UiMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const forceScroll = useRef(true);
  const keepOffset = useRef<number | null>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api.thread(phone);
      setContact(r.contact);
      setMessages(r.messages);
      setNotFound(false);
      setLoadError(null);
      if (firstLoad.current) {
        firstLoad.current = false;
        setHasMore(r.messages.length >= PAGE_SIZE);
        onActivity(); // server marked it read
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
        setMessages([]);
        setLoadError(null);
      } else {
        setLoadError(err instanceof Error ? err.message : 'Failed to load messages.');
      }
    }
  }, [phone, onActivity]);

  usePolling(load, THREAD_POLL_MS, true, phone);

  async function loadOlder() {
    const all = mergeById(older, messages ?? []);
    if (!all.length) return;
    setLoadingOlder(true);
    try {
      const r = await api.thread(phone, all[0].ts);
      const el = scrollRef.current;
      keepOffset.current = el ? el.scrollHeight - el.scrollTop : null;
      setOlder((prev) => mergeById(r.messages, prev));
      setHasMore(r.messages.length >= PAGE_SIZE);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }

  const display: UiMessage[] = useMemo(() => {
    const server = mergeById(older, messages ?? []);
    // Hide a local failed bubble once the server reports its own failed copy.
    const visibleLocals = locals.filter(
      (l) =>
        l.pending ||
        !server.some((s) => s.direction === 'out' && s.status === 'failed' && s.text === l.text && Math.abs(s.ts - l.ts) < 60_000),
    );
    return [...server, ...visibleLocals].sort((a, b) => a.ts - b.ts);
  }, [older, messages, locals]);

  // Auto-scroll: stick to bottom when already there, on first load, or after sending.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepOffset.current !== null) {
      el.scrollTop = el.scrollHeight - keepOffset.current;
      keepOffset.current = null;
      return;
    }
    if (forceScroll.current || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      if (messages !== null) forceScroll.current = false;
    }
  }, [display, messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function handleSend(text: string): Promise<boolean> {
    setSendError(null);
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimistic: UiMessage = {
      id: localId,
      phone,
      direction: 'out',
      type: 'text',
      text,
      status: 'sent',
      auto: false,
      ts: Date.now(),
      pending: true,
      local: true,
    };
    forceScroll.current = true;
    setLocals((l) => [...l, optimistic]);
    try {
      const msg = await api.send(phone, text);
      setLocals((l) => l.filter((m) => m.id !== localId));
      setMessages((prev) => mergeById(prev ?? [], [msg]));
      onActivity();
      return true;
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      if (e?.status === 409) {
        // Nothing was sent: drop the bubble, give the text back and refresh window state.
        setLocals((l) => l.filter((m) => m.id !== localId));
        setSendError(e.message || '24h window closed — send a template instead.');
        void load();
        return false;
      }
      const message = err instanceof Error ? err.message : 'Send failed.';
      setLocals((l) => l.map((m) => (m.id === localId ? { ...m, pending: false, status: 'failed', error: message } : m)));
      setSendError(message);
      return true;
    }
  }

  async function handleTemplate(template: string, language: string): Promise<boolean> {
    setSendError(null);
    try {
      const msg = await api.sendTemplate(phone, template, language);
      forceScroll.current = true;
      setMessages((prev) => mergeById(prev ?? [], [msg]));
      setNotFound(false);
      onActivity();
      return true;
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Template send failed.');
      return false;
    }
  }

  const header = contact ?? fallback ?? null;
  const name = header ? displayName(header) : formatPhone(phone);
  const windowOpen = (contact ?? fallback)?.windowOpen ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 md:hidden"
          aria-label="Back to conversations"
        >
          ←
        </button>
        <Avatar label={header ? initials(header) : '#'} muted={!allowed} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{name}</p>
          <p className="truncate text-xs text-slate-500">
            {header?.name ? `${formatPhone(phone)} · ` : ''}
            <span className={windowOpen ? 'text-emerald-600' : 'text-amber-700'}>{windowLabel(contact ?? fallback ?? null)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleAllowed}
          disabled={allowBusy}
          aria-pressed={allowed}
          title={allowed ? 'Bot may auto-reply to this number. Click to remove.' : 'Bot will not auto-reply. Click to allow.'}
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            allowed
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${allowed ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          {allowed ? 'Allowed' : 'Allow this number'}
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="chat-bg min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6">
        {loadError && (
          <div className="mb-3">
            <ErrorNote onRetry={() => void load()}>{loadError}</ErrorNote>
          </div>
        )}
        {messages === null && !loadError && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {hasMore && (
          <div className="mb-3 flex justify-center">
            <Button variant="secondary" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>
              Load older messages
            </Button>
          </div>
        )}
        {messages !== null && display.length === 0 && (
          <div className="mx-auto mt-10 max-w-xs rounded-lg bg-white/80 px-4 py-3 text-center text-sm text-slate-500 shadow-sm">
            {notFound ? 'No conversation with this number yet. Send a template to start one.' : 'No messages yet.'}
          </div>
        )}
        <div className="space-y-1.5">
          {display.map((m, i) => {
            const newDay = i === 0 || dayKey(display[i - 1].ts) !== dayKey(m.ts);
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className="flex justify-center py-2">
                    <span className="rounded-md bg-white px-2.5 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm">
                      {dayLabel(m.ts)}
                    </span>
                  </div>
                )}
                <MessageBubble m={m} />
              </Fragment>
            );
          })}
        </div>
      </div>

      <Composer
        windowOpen={windowOpen}
        error={sendError}
        onDismissError={() => setSendError(null)}
        onSend={handleSend}
        onSendTemplate={handleTemplate}
      />
    </div>
  );
}
