import { displayName, formatPhone, initials, relativeTime } from '../lib';
import type { Conversation } from '../types';
import { Avatar, ErrorNote, Spinner, inputCls } from './ui';

export function ConversationList({
  conversations,
  error,
  selected,
  search,
  onSearch,
  onSelect,
  onRetry,
}: {
  conversations: Conversation[] | null;
  error: string | null;
  selected: string | null;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (phone: string) => void;
  onRetry: () => void;
}): JSX.Element {
  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D+/g, '');
  const filtered = (conversations ?? []).filter(
    (c) =>
      !q ||
      (c.name ?? '').toLowerCase().includes(q) ||
      (qDigits.length > 0 && c.phone.includes(qDigits)) ||
      c.lastMessagePreview.toLowerCase().includes(q),
  );
  const now = Date.now();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-slate-200 px-3 py-2">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name, number or message"
          aria-label="Search conversations"
          className={inputCls}
        />
      </div>
      {error && (
        <div className="p-3">
          <ErrorNote onRetry={onRetry}>{error}</ErrorNote>
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversations">
        {conversations === null && !error && (
          <li className="flex justify-center p-8">
            <Spinner />
          </li>
        )}
        {conversations !== null && filtered.length === 0 && (
          <li className="px-4 py-10 text-center text-sm text-slate-500">
            {q ? 'No conversations match your search.' : 'No conversations yet. Messages sent to your WhatsApp number will show up here.'}
          </li>
        )}
        {filtered.map((c) => {
          const active = c.phone === selected;
          return (
            <li key={c.phone}>
              <button
                type="button"
                onClick={() => onSelect(c.phone)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left transition-colors ${
                  active ? 'bg-brand-50' : 'hover:bg-slate-50'
                }`}
              >
                <Avatar label={initials(c)} muted={!c.allowed} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`truncate text-sm ${c.unread > 0 ? 'font-semibold text-slate-900' : 'font-medium text-slate-800'}`}>
                      {displayName(c)}
                    </span>
                    <span className={`ml-auto shrink-0 text-xs ${c.unread > 0 ? 'font-medium text-emerald-600' : 'text-slate-400'}`}>
                      {c.lastMessageAt ? relativeTime(c.lastMessageAt, now) : ''}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="truncate text-xs text-slate-500">
                      {c.name ? <span className="text-slate-400">{formatPhone(c.phone)} · </span> : null}
                      {c.lastMessagePreview || <em className="text-slate-400">No messages</em>}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {!c.allowed && (
                        <span
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500"
                          title="Not in allowed numbers: the bot will not auto-reply"
                        >
                          not allowed
                        </span>
                      )}
                      {c.unread > 0 && (
                        <span
                          className="min-w-[1.25rem] rounded-full bg-emerald-500 px-1.5 py-0.5 text-center text-[11px] font-semibold leading-none text-white"
                          aria-label={`${c.unread} unread`}
                        >
                          {c.unread > 99 ? '99+' : c.unread}
                        </span>
                      )}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
