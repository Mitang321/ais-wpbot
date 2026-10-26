import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { BOT_WA_LINK, DEFAULT_TOWN, STORE_NAME } from '../config';
import {
  addDaysIso,
  copyText,
  dayMonthLong,
  errMsg,
  euros,
  parisFriendly,
  parisLocalToMs,
  parisToday,
  pickActiveRun,
  shortDate,
  usePolling,
  weekdayLong,
} from '../lib';
import type { BroadcastResult, Run, RunStatus, RunSummary } from '../types';
import { IconChevron, IconCopy, IconMegaphone, IconPlus, IconSend, IconTruck } from './icons';
import { CutoffChips, RUN_STATUS_STYLE } from './RunBar';
import type { StoreData } from './Shell';
import { Button, Card, EmptyState, ErrorNote, Field, LoadingBlock, Modal, inputCls, toast } from './ui';

// ---------------------------------------------------------------------------
// Data: uses the Shell's shared runs when given, else loads its own.
// ---------------------------------------------------------------------------

function useRuns(store?: StoreData) {
  const [local, setLocal] = useState<RunSummary[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const reloadLocal = useCallback(async () => {
    try {
      setLocal(await api.runs());
      setLocalError(null);
    } catch (err) {
      setLocalError(errMsg(err, 'Failed to load deliveries.'));
    }
  }, []);
  usePolling(reloadLocal, 20_000, !store);
  if (store) return { runs: store.runs, error: store.runsError, reload: store.reloadRuns };
  return { runs: local, error: localError, reload: reloadLocal };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** "Friday evening, 6 November" (part of day taken from the free-text time). */
export function deliveryDayPhrase(run: Pick<Run, 'deliveryDate' | 'deliveryTime'>): string {
  const t = run.deliveryTime.toLowerCase();
  const part = ['morning', 'afternoon', 'evening', 'night'].find((w) => t.includes(w));
  return `${weekdayLong(run.deliveryDate)}${part ? ` ${part}` : ''}, ${dayMonthLong(run.deliveryDate)}`;
}

export function announcementText(run: Run): string {
  const hasVeg = run.vegCutoffAt != null && run.vegCutoffAt < run.cutoffAt;
  const lines = [
    `🛍️ *${STORE_NAME}*`,
    '',
    'Namaste everyone! 🙏',
    `We're delivering to *${run.town}* on *${deliveryDayPhrase(run)}* 🚚`,
    '',
    `📍 Pickup: ${run.pickupSpot}`,
    `🕕 Time: ${run.deliveryTime}`,
    '',
    '⏰ *Order before:*',
    ...(hasVeg
      ? [`🥗 Vegetables before ${parisFriendly(run.vegCutoffAt!)}`, `🛒 Everything else before ${parisFriendly(run.cutoffAt)}`]
      : [`🛒 Everything before ${parisFriendly(run.cutoffAt)}`]),
    '',
    `👉 Order on WhatsApp: ${BOT_WA_LINK}`,
    'Just say Hi and type your order, e.g. "okra 1kg, 2 kaju katli" 😊',
    '',
    'Fresh vegetables, sweets, spices & more. Pay at pickup.',
    'Thank you 🙏',
  ];
  return lines.join('\n');
}

function arrivedText(run: Run): string {
  return `🚚 We've arrived at ${run.pickupSpot}! Please come and collect your order 🙏`;
}

// ---------------------------------------------------------------------------
// New delivery form
// ---------------------------------------------------------------------------

function nextFriday(today: string): string {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const add = (5 - dow + 7) % 7 || 7;
  return addDaysIso(today, add);
}

function defaultCutoffs(date: string): { cutoff: string; veg: string } {
  return { cutoff: `${addDaysIso(date, -1)}T18:00`, veg: `${addDaysIso(date, -6)}T18:00` };
}

function NewRunDialog({ open, onClose, onCreated, lastSpot }: { open: boolean; onClose: () => void; onCreated: (r: Run) => void; lastSpot: string }): JSX.Element {
  const init = () => {
    const date = nextFriday(parisToday());
    const c = defaultCutoffs(date);
    return {
      town: DEFAULT_TOWN,
      date,
      time: 'evening, around 6pm',
      spot: lastSpot,
      cutoff: c.cutoff,
      useVeg: true,
      veg: c.veg,
      touchedCutoffs: false,
    };
  };
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setF(init());
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDate = (date: string) =>
    setF((x) => (x.touchedCutoffs || !/^\d{4}-\d{2}-\d{2}$/.test(date) ? { ...x, date } : { ...x, date, ...defaultCutoffs(date) }));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const town = f.town.trim();
    const pickupSpot = f.spot.trim();
    const deliveryTime = f.time.trim();
    const cutoffAt = parisLocalToMs(f.cutoff);
    const vegCutoffAt = f.useVeg ? parisLocalToMs(f.veg) : null;
    if (!town) return setError('Please enter the town.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return setError('Please choose the delivery date.');
    if (!pickupSpot) return setError('Please enter where customers collect their order.');
    if (cutoffAt == null) return setError('Please set the order cutoff.');
    if (f.useVeg && vegCutoffAt == null) return setError('Please set the vegetable cutoff, or untick it.');
    if (vegCutoffAt != null && vegCutoffAt > cutoffAt) return setError('The vegetable cutoff should be before the general cutoff.');
    if (f.cutoff.slice(0, 10) > f.date) return setError('The order cutoff should be before the delivery date.');
    setBusy(true);
    setError(null);
    try {
      const run = await api.createRun({ town, deliveryDate: f.date, deliveryTime: deliveryTime || 'evening', pickupSpot, cutoffAt, vegCutoffAt });
      toast(`Delivery to ${run.town} on ${shortDate(run.deliveryDate)} created`);
      onCreated(run);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Could not create the delivery.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New delivery"
      subtitle="All times are Paris time."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Create delivery
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Town" htmlFor="nr-town">
            <input id="nr-town" className={inputCls} value={f.town} onChange={(e) => setF({ ...f, town: e.target.value })} />
          </Field>
          <Field label="Delivery date" htmlFor="nr-date" hint={/^\d{4}-\d{2}-\d{2}$/.test(f.date) ? weekdayLong(f.date) : undefined}>
            <input id="nr-date" type="date" className={inputCls} value={f.date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Time" htmlFor="nr-time" hint="As customers will read it.">
          <input id="nr-time" className={inputCls} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        </Field>
        <Field label="Pickup spot" htmlFor="nr-spot">
          <input
            id="nr-spot"
            className={inputCls}
            value={f.spot}
            onChange={(e) => setF({ ...f, spot: e.target.value })}
            placeholder="e.g. Parking Leclerc, Manosque"
          />
        </Field>
        <Field label="Orders close" htmlFor="nr-cutoff" hint="🛒 Everything (except vegetables, if set below).">
          <input
            id="nr-cutoff"
            type="datetime-local"
            className={inputCls}
            value={f.cutoff}
            onChange={(e) => setF({ ...f, cutoff: e.target.value, touchedCutoffs: true })}
          />
        </Field>
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={f.useVeg}
              onChange={(e) => setF({ ...f, useVeg: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-300"
            />
            🥗 Earlier cutoff for vegetables
          </label>
          {f.useVeg && (
            <div className="mt-2">
              <input
                type="datetime-local"
                aria-label="Vegetable cutoff"
                className={inputCls}
                value={f.veg}
                onChange={(e) => setF({ ...f, veg: e.target.value, touchedCutoffs: true })}
              />
              <p className="mt-1 text-xs text-slate-500">So you have time to order the vegetables from your supplier.</p>
            </div>
          )}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Run card pieces
// ---------------------------------------------------------------------------

function StatusSelect({ run, onSaved }: { run: RunSummary; onSaved: () => Promise<void> }): JSX.Element {
  const [value, setValue] = useState<RunStatus>(run.status);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(run.status), [run.status]);

  const change = async (status: RunStatus) => {
    const prev = value;
    setValue(status);
    setSaving(true);
    try {
      await api.updateRun(run.id, { status });
      toast(`${run.town} · ${shortDate(run.deliveryDate)}: ${RUN_STATUS_STYLE[status].label.toLowerCase()}`);
      await onSaved();
    } catch (err) {
      setValue(prev);
      toast(errMsg(err, 'Could not change the status.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      value={value}
      disabled={saving}
      onChange={(e) => void change(e.target.value as RunStatus)}
      aria-label="Delivery status"
      className={`cursor-pointer appearance-none rounded-full border-0 py-1 pl-3 pr-7 text-xs font-semibold ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-brand-300 disabled:opacity-60 ${RUN_STATUS_STYLE[value].cls}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 8l4 4 4-4'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.4rem center',
        backgroundSize: '0.9rem',
      }}
    >
      {(Object.keys(RUN_STATUS_STYLE) as RunStatus[]).map((s) => (
        <option key={s} value={s}>
          {RUN_STATUS_STYLE[s].label}
        </option>
      ))}
    </select>
  );
}

function Stat({ label, value, tone = 'text-slate-900' }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`truncate text-base font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function Announcement({ run }: { run: Run }): JSX.Element {
  const text = useMemo(() => announcementText(run), [run]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      toast('Copied! Paste it in your WhatsApp group.');
    } else toast('Could not copy. Select the text and copy it by hand.', 'error');
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <IconMegaphone className="h-4 w-4 text-brand-600" /> Announcement for the group
          </h4>
          <p className="text-xs text-slate-500">Copy and paste it into your WhatsApp group.</p>
        </div>
        <Button variant={copied ? 'success' : 'primary'} size="sm" onClick={() => void copy()} className="shrink-0">
          {copied ? (
            '✓ Copied'
          ) : (
            <>
              <IconCopy className="h-4 w-4" /> Copy
            </>
          )}
        </Button>
      </div>
      <div className="rounded-xl bg-[#e7ddd3] p-3">
        <div className="ml-auto max-w-md whitespace-pre-wrap break-words rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-[13px] leading-relaxed text-slate-800 shadow-sm">
          {text}
        </div>
      </div>
    </section>
  );
}

function Broadcast({ run }: { run: RunSummary }): JSX.Element {
  const [text, setText] = useState(() => arrivedText(run));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const msg = text.trim();
    if (!msg) return;
    const who = run.orderCount === 1 ? '1 customer' : `${run.orderCount} customers`;
    if (!window.confirm(`Send this message on WhatsApp to ${who} of the ${run.town} delivery (${shortDate(run.deliveryDate)})?\n\n${msg}`)) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.broadcast(run.id, msg);
      setResult(r);
      toast(`Sent to ${r.sent} customer${r.sent === 1 ? '' : 's'}`, r.sent > 0 ? 'success' : 'info');
    } catch (err) {
      setError(errMsg(err, 'Could not send the message.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <IconSend className="h-4 w-4 text-leaf-600" /> Message all customers
        </h4>
        <p className="text-xs text-slate-500">
          Sent on WhatsApp to everyone with an order for this delivery ({run.orderCount}). Only customers who wrote to you in the last 24 h can receive it.
        </p>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        aria-label="Message to all customers"
        className={`${inputCls} resize-y`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="success" onClick={() => void send()} loading={busy} disabled={!text.trim() || run.orderCount === 0}>
          <IconSend className="h-4 w-4" /> Send to all
        </Button>
        <button type="button" onClick={() => setText(arrivedText(run))} className="text-xs font-medium text-slate-500 underline hover:text-slate-700">
          Reset text
        </button>
        {run.orderCount === 0 && <span className="text-xs text-slate-500">No orders yet.</span>}
      </div>
      {result && (
        <p role="status" className="rounded-lg bg-leaf-50 px-3 py-2 text-sm text-leaf-800 ring-1 ring-inset ring-leaf-200">
          ✅ Sent {result.sent} · skipped {result.skipped} (no recent chat) · failed {result.failed}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function RunCard({
  run,
  isNext,
  expanded,
  onToggle,
  onChanged,
}: {
  run: RunSummary;
  isNext: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const today = parisToday();
  const past = run.deliveryDate < today;
  const unpaid = run.totalCents - run.paidCents;
  return (
    <Card className={`overflow-hidden ${isNext ? 'ring-2 ring-brand-300' : ''}`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl leading-none ${
              past || run.status === 'delivered' ? 'bg-slate-100 text-slate-500' : 'bg-brand-50 text-brand-700'
            }`}
            aria-hidden
          >
            <span className="text-[10px] font-semibold uppercase">{shortDate(run.deliveryDate).split(' ')[0]}</span>
            <span className="text-lg font-bold">{Number(run.deliveryDate.slice(8, 10))}</span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                {run.town} · {shortDate(run.deliveryDate)}
              </h3>
              {isNext && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">Next delivery</span>}
            </div>
            <p className="truncate text-sm text-slate-600">
              {run.deliveryTime} · 📍 {run.pickupSpot}
            </p>
          </div>
          <StatusSelect run={run} onSaved={onChanged} />
        </div>

        <div className="mt-3">
          <CutoffChips run={run} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Orders" value={String(run.orderCount)} />
          <Stat label="Total" value={euros(run.totalCents)} />
          <Stat
            label="Paid"
            value={euros(run.paidCents)}
            tone={run.totalCents > 0 && unpaid <= 0 ? 'text-leaf-700' : 'text-slate-900'}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        <span className="flex items-center gap-2">
          <IconMegaphone className="h-4 w-4 text-brand-600" /> Announcement & customer messages
        </span>
        <IconChevron className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="grid gap-6 border-t border-slate-100 p-4 lg:grid-cols-2">
          <Announcement run={run} />
          <Broadcast key={run.id} run={run} />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function RunsTab({ store }: { store?: StoreData } = {}): JSX.Element {
  const { runs, error, reload } = useRuns(store);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [autoOpened, setAutoOpened] = useState(false);

  const next = useMemo(() => (runs ? pickActiveRun(runs) : null), [runs]);

  // Open the next delivery's messages by default (once).
  useEffect(() => {
    if (!autoOpened && next) {
      setExpanded(new Set([next.id]));
      setAutoOpened(true);
    }
  }, [next, autoOpened]);

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const lastSpot = runs?.[0]?.pickupSpot ?? '';

  let body: JSX.Element;
  if (!runs && error) body = <ErrorNote onRetry={() => void reload()}>{error}</ErrorNote>;
  else if (!runs) body = <LoadingBlock label="Loading deliveries…" />;
  else if (runs.length === 0)
    body = (
      <EmptyState icon="🚚" title="No delivery planned yet">
        <p>Plan your next trip: the date, where customers pick up, and until when they can order.</p>
        <Button className="mt-4" onClick={() => setCreating(true)}>
          <IconPlus className="h-4 w-4" /> New delivery
        </Button>
      </EmptyState>
    );
  else
    body = (
      <div className="space-y-4">
        {error && <ErrorNote onRetry={() => void reload()}>{error}</ErrorNote>}
        {runs.map((r) => (
          <RunCard key={r.id} run={r} isNext={next?.id === r.id} expanded={expanded.has(r.id)} onToggle={() => toggle(r.id)} onChanged={reload} />
        ))}
      </div>
    );

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-4 md:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-50 text-leaf-700">
            <IconTruck className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">Deliveries</h2>
            <p className="text-sm text-slate-500">Plan trips, announce them to the group, and message customers.</p>
          </div>
        </div>
        <Button onClick={() => setCreating(true)}>
          <IconPlus className="h-4 w-4" /> New delivery
        </Button>
      </div>

      {body}

      <NewRunDialog
        open={creating}
        onClose={() => setCreating(false)}
        lastSpot={lastSpot}
        onCreated={(run) => {
          setExpanded((s) => new Set(s).add(run.id));
          void reload();
        }}
      />
    </div>
  );
}
