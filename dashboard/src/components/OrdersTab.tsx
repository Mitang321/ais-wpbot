import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errMsg, euros, formatPhone, itemLine, parisStamp } from '../lib';
import type { Order, OrderStatus } from '../types';
import { AddOrderDialog } from './AddOrderDialog';
import { IconChat, IconPhone, IconPlus, IconSearch } from './icons';
import { NoRunGate, RunBar, useRunOrders } from './RunBar';
import type { StoreData } from './Shell';
import { Button, Card, Chip, EmptyState, ErrorNote, LoadingBlock, inputCls, toast } from './ui';

type Filter = 'all' | 'topack' | 'packed' | 'collected' | 'unpaid';

const FILTERS: Array<{ id: Filter; label: string; test: (o: Order) => boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'topack', label: 'To pack', test: (o) => o.status === 'confirmed' },
  { id: 'packed', label: 'Packed', test: (o) => o.status === 'packed' },
  { id: 'collected', label: 'Collected', test: (o) => o.status === 'collected' },
  { id: 'unpaid', label: 'Unpaid', test: (o) => o.status !== 'cancelled' && !o.paid },
];

export const ORDER_STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  confirmed: { label: 'To pack', cls: 'bg-brand-50 text-brand-800 ring-brand-200' },
  packed: { label: 'Packed', cls: 'bg-sky-50 text-sky-800 ring-sky-200' },
  collected: { label: 'Collected', cls: 'bg-leaf-50 text-leaf-800 ring-leaf-200' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500 ring-slate-200' },
};

const NEW_HIGHLIGHT_MS = 90_000;

export function OrdersTab({ store }: { store: StoreData }): JSX.Element {
  const runId = store.selectedRunId;
  const { run, orders, error, reload, replaceOrder } = useRunOrders(runId);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  // ---- live "new order" detection ------------------------------------------------
  const seen = useRef<{ runId: number | null; ids: Set<number> }>({ runId: null, ids: new Set() });
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!orders || runId == null) return;
    if (seen.current.runId !== runId) {
      seen.current = { runId, ids: new Set(orders.map((o) => o.id)) };
      setFresh(new Set());
      return;
    }
    const added = orders.filter((o) => !seen.current.ids.has(o.id));
    if (added.length === 0) return;
    added.forEach((o) => seen.current.ids.add(o.id));
    const botOnes = added.filter((o) => o.source === 'bot');
    botOnes.forEach((o) => toast(`🛒 New WhatsApp order #${o.id} from ${o.customerName} · ${euros(o.totalCents)}`, 'order'));
    if (botOnes.length > 0) void store.reloadRuns();
    setFresh((s) => new Set([...s, ...added.map((o) => o.id)]));
    const ids = added.map((o) => o.id);
    setTimeout(() => setFresh((s) => new Set([...s].filter((id) => !ids.includes(id)))), NEW_HIGHLIGHT_MS);
  }, [orders, runId, store]);

  const live = useMemo(() => (orders ?? []).filter((o) => o.status !== 'cancelled'), [orders]);
  const stats = useMemo(
    () => ({
      count: live.length,
      total: live.reduce((s, o) => s + o.totalCents, 0),
      paid: live.filter((o) => o.paid).reduce((s, o) => s + o.totalCents, 0),
      collected: live.filter((o) => o.status === 'collected').length,
    }),
    [live],
  );

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    return (orders ?? [])
      .filter(f.test)
      .filter(
        (o) =>
          !q ||
          o.customerName.toLowerCase().includes(q) ||
          String(o.id) === q.replace('#', '') ||
          (qDigits.length >= 3 && o.phone.includes(qDigits)),
      )
      .sort((a, b) => {
        const ca = a.status === 'cancelled' ? 1 : 0;
        const cb = b.status === 'cancelled' ? 1 : 0;
        return ca - cb || b.createdAt - a.createdAt;
      });
  }, [orders, filter, q, qDigits]);

  async function update(o: Order, patch: { status?: OrderStatus; paid?: boolean }, okText: string) {
    setBusy((b) => ({ ...b, [o.id]: true }));
    replaceOrder({ ...o, ...patch }); // optimistic
    try {
      replaceOrder(await api.updateOrder(o.id, patch));
      toast(okText);
      void store.reloadRuns();
    } catch (err) {
      replaceOrder(o);
      toast(errMsg(err, 'Could not update the order.'), 'error');
    } finally {
      setBusy((b) => ({ ...b, [o.id]: false }));
    }
  }

  const gate = NoRunGate({ store });

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-4 md:py-6">
      {gate ?? (
        <>
          <RunBar store={store} run={run} />

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Orders" value={orders ? String(stats.count) : '–'} />
            <Stat label="Total" value={orders ? euros(stats.total) : '–'} accent />
            <Stat
              label="Paid"
              value={orders ? euros(stats.paid) : '–'}
              sub={orders && stats.total > 0 ? `${euros(stats.total - stats.paid)} to collect` : undefined}
            />
            <Stat label="Collected" value={orders ? `${stats.collected} / ${stats.count}` : '–'} />
          </div>

          {/* Toolbar */}
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search customer name"
                  aria-label="Search orders by customer name"
                  className={`${inputCls} rounded-xl py-2.5 pl-9`}
                />
              </div>
              <Button onClick={() => { setAddOpen(true); void store.reloadProducts(); }} disabled={!run} className="shrink-0 rounded-xl" aria-label="Add order">
                <IconPlus className="h-4 w-4" />
                <span className="hidden sm:inline">Add order</span>
                <span className="sm:hidden">Add</span>
              </Button>
            </div>
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
              {FILTERS.map((f) => (
                <Chip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)} count={orders ? orders.filter(f.test).length : undefined}>
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>

          {error && <ErrorNote onRetry={() => void reload()}>{error}</ErrorNote>}
          {!orders && !error && <LoadingBlock label="Loading orders…" />}
          {orders && orders.length === 0 && (
            <EmptyState icon="🛍️" title="No orders yet">
              New WhatsApp orders appear here by themselves. Orders taken by phone can be added with “Add order”.
            </EmptyState>
          )}
          {orders && orders.length > 0 && visible.length === 0 && (
            <p className="rounded-2xl bg-white px-4 py-8 text-center text-sm text-slate-500 shadow-sm">No orders match this filter.</p>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            {visible.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                isNew={fresh.has(o.id)}
                busy={!!busy[o.id]}
                onStatus={(s) =>
                  void update(o, { status: s }, s === 'cancelled' ? `Order #${o.id} cancelled` : `#${o.id} ${o.customerName}: ${ORDER_STATUS[s].label.toLowerCase()}`)
                }
                onPaid={(paid) => void update(o, { paid }, paid ? `#${o.id} marked paid 💶` : `#${o.id} marked unpaid`)}
              />
            ))}
          </div>
          {orders && <p className="pb-2 text-center text-xs text-slate-400">Updates live every 5 seconds</p>}

          {run && (
            <AddOrderDialog
              open={addOpen}
              onClose={() => setAddOpen(false)}
              run={run}
              products={store.products}
              onCreated={(o) => {
                seen.current.ids.add(o.id);
                replaceOrder(o);
                setAddOpen(false);
                toast(`Order #${o.id} for ${o.customerName} added`);
                void store.reloadRuns();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }): JSX.Element {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-2xl font-semibold tabular-nums tracking-tight ${accent ? 'text-brand-700' : 'text-slate-900'}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

const STEPS: OrderStatus[] = ['confirmed', 'packed', 'collected'];

function OrderCard({
  order: o,
  isNew,
  busy,
  onStatus,
  onPaid,
}: {
  order: Order;
  isNew: boolean;
  busy: boolean;
  onStatus: (s: OrderStatus) => void;
  onPaid: (paid: boolean) => void;
}): JSX.Element {
  const cancelled = o.status === 'cancelled';
  const st = ORDER_STATUS[o.status];
  return (
    <article
      className={`flex flex-col rounded-2xl border bg-white shadow-sm ${isNew ? 'animate-flash border-brand-300' : 'border-slate-200'} ${
        cancelled ? 'opacity-60' : ''
      }`}
      aria-label={`Order ${o.id} from ${o.customerName}`}
    >
      {/* Head */}
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-600">#{o.id}</span>
            <h3 className={`truncate text-base font-semibold text-slate-900 ${cancelled ? 'line-through' : ''}`}>{o.customerName}</h3>
            {isNew && <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">New</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {o.source === 'bot' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-leaf-50 px-2 py-0.5 font-medium text-leaf-700 ring-1 ring-inset ring-leaf-200">
                <IconChat className="h-3.5 w-3.5" /> WhatsApp bot
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                <IconPhone className="h-3.5 w-3.5" /> Manual
              </span>
            )}
            {o.phone && (
              <a href={`tel:+${o.phone}`} className="whitespace-nowrap hover:text-slate-800 hover:underline">
                {formatPhone(o.phone)}
              </a>
            )}
            <span aria-hidden>·</span>
            <span className="whitespace-nowrap">{parisStamp(o.createdAt)}</span>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${st.cls}`}>{st.label}</span>
      </div>

      {/* Items */}
      <ul className="mx-4 mt-3 space-y-1 border-t border-dashed border-slate-200 pt-2.5 text-sm">
        {o.items.map((it) => (
          <li key={it.productId} className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 text-slate-800">{itemLine(it)}</span>
            <span className="shrink-0 tabular-nums text-slate-500">{euros(it.lineTotalCents)}</span>
          </li>
        ))}
      </ul>
      {o.note && <p className="mx-4 mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">📝 {o.note}</p>}

      <div className="mx-4 mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5">
        <span className="text-sm text-slate-500">Total</span>
        <span className="text-lg font-semibold tabular-nums text-slate-900">{euros(o.totalCents)}</span>
      </div>

      {/* Actions */}
      <div className="mt-auto flex flex-wrap items-center gap-2 rounded-b-2xl bg-slate-50/80 px-4 py-3">
        {cancelled ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onStatus('confirmed')}>
            Restore order
          </Button>
        ) : (
          <>
            <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 bg-white" role="group" aria-label="Order status">
              {STEPS.map((s) => {
                const on = o.status === s;
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={busy || on}
                    aria-pressed={on}
                    onClick={() => onStatus(s)}
                    className={`border-r border-slate-200 px-2.5 py-1.5 text-xs font-semibold last:border-r-0 transition-colors ${
                      on ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                    } disabled:cursor-default`}
                  >
                    {s === 'confirmed' ? 'Confirmed' : ORDER_STATUS[s].label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={busy}
              aria-pressed={o.paid}
              onClick={() => onPaid(!o.paid)}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                o.paid ? 'bg-leaf-600 text-white hover:bg-leaf-700' : 'border border-dashed border-slate-400 bg-white text-slate-600 hover:border-slate-500'
              }`}
            >
              {o.paid ? '✓ Paid' : '€ Mark paid'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Cancel order #${o.id} from ${o.customerName}?`)) onStatus('cancelled');
              }}
              className="ml-auto rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-700"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </article>
  );
}
