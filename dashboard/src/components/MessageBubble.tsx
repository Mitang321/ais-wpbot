import { clockTime } from '../lib';
import type { UiMessage } from '../types';

function Ticks({ m }: { m: UiMessage }): JSX.Element | null {
  if (m.direction !== 'out') return null;
  if (m.pending) {
    return (
      <span className="text-slate-400" title="Sending…" aria-label="Sending">
        🕓
      </span>
    );
  }
  switch (m.status) {
    case 'failed':
      return (
        <span className="font-bold text-red-600" title={m.error || 'Failed to send'} aria-label="Failed">
          !
        </span>
      );
    case 'read':
      return (
        <span className="tracking-[-0.3em] text-sky-500" title="Read" aria-label="Read">
          ✓✓
        </span>
      );
    case 'delivered':
      return (
        <span className="tracking-[-0.3em] text-slate-400" title="Delivered" aria-label="Delivered">
          ✓✓
        </span>
      );
    default:
      return (
        <span className="text-slate-400" title="Sent" aria-label="Sent">
          ✓
        </span>
      );
  }
}

export function MessageBubble({ m }: { m: UiMessage }): JSX.Element {
  const out = m.direction === 'out';
  const failed = m.status === 'failed';
  const bubbleCls = failed
    ? 'border border-red-300 bg-red-50 text-red-900'
    : out
      ? m.auto
        ? 'border border-brand-200 bg-brand-50 text-slate-900'
        : 'bg-emerald-100 text-slate-900'
      : 'bg-white text-slate-900';

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative max-w-[85%] rounded-lg px-3 py-1.5 shadow-sm sm:max-w-[70%] ${bubbleCls} ${m.pending ? 'opacity-70' : ''}`}
        title={failed ? m.error || 'Failed to send' : undefined}
      >
        {(m.auto || m.type !== 'text') && (
          <div className="mb-0.5 flex flex-wrap gap-1">
            {m.auto && (
              <span className="rounded bg-brand-600 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">
                bot
              </span>
            )}
            {m.type !== 'text' && (
              <span className="rounded bg-slate-200 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-600">
                {m.type}
              </span>
            )}
          </div>
        )}
        <p className="whitespace-pre-wrap break-words text-sm leading-snug">{m.text}</p>
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[11px] leading-none text-slate-500">
          {failed && <span className="max-w-[16rem] truncate text-red-600">{m.error || 'Failed'}</span>}
          <span>{clockTime(m.ts)}</span>
          <Ticks m={m} />
        </div>
      </div>
    </div>
  );
}
