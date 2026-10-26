import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errMsg, parisDateTime, runTitle, shortDate, usePolling } from '../lib';
import type { Order, Run, RunStatus } from '../types';
import { IconTruck } from './icons';
import type { StoreData } from './Shell';
import { Button, EmptyState, ErrorNote, LoadingBlock } from './ui';

export const RUN_STATUS_STYLE: Record<RunStatus, { label: string; cls: string }> = {
  open: { label: 'Open for orders', cls: 'bg-leaf-50 text-leaf-700 ring-leaf-200' },
  closed: { label: 'Orders closed', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  delivered: { label: 'Delivered', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
};

export function RunStatusPill({ status }: { status: RunStatus }): JSX.Element {
  const s = RUN_STATUS_STYLE[status];
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.cls}`}>{s.label}</span>;
}

/** 🥗 Veg closes … / 🛒 Others close … chips. */
export function CutoffChips({ run, now = Date.now() }: { run: Run; now?: number }): JSX.Element {
  const chip = (icon: string, label: string, at: number, plural: boolean) => {
    const closed = now > at;
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
          closed ? 'bg-slate-100 text-slate-500 ring-slate-200' : 'bg-brand-50 text-brand-800 ring-brand-200'
        }`}
      >
        <span aria-hidden>{icon}</span>
        {closed ? (
          <>
            {label} closed <span className="font-normal opacity-80">({parisDateTime(at)})</span>
          </>
        ) : (
          <>
            {label} {plural ? 'close' : 'closes'} {parisDateTime(at)}
          </>
        )}
      </span>
    );
  };
  const hasVeg = run.vegCutoffAt != null && run.vegCutoffAt < run.cutoffAt;
  return (
    <div className="flex flex-wrap gap-1.5">
      {hasVeg && chip('🥗', 'Veg', run.vegCutoffAt!, false)}
      {chip('🛒', hasVeg ? 'Others' : 'Orders', run.cutoffAt, true)}
    </div>
  );
}

/** Run picker + header shared by Orders and Packing. */
export function RunBar({ store, run }: { store: StoreData; run: Run | null }): JSX.Element | null {
  const { runs, selectedRunId, setSelectedRunId } = store;
  const r = run ?? runs?.find((x) => x.id === selectedRunId) ?? null;
  if (!r) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm print:border-0 print:p-0 print:shadow-none">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-50 text-leaf-700 sm:flex print:hidden">
            <IconTruck className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">{runTitle(r)}</h2>
              <span className="print:hidden">
                <RunStatusPill status={r.status} />
              </span>
            </div>
            <p className="text-sm text-slate-600">
              {r.deliveryTime} · {r.pickupSpot}
            </p>
            <div className="mt-2 print:hidden">
              <CutoffChips run={r} />
            </div>
          </div>
        </div>
        {runs && runs.length > 1 && (
          <label className="flex shrink-0 items-center gap-2 text-sm text-slate-500 print:hidden">
            <span className="whitespace-nowrap">Delivery</span>
            <select
              value={selectedRunId ?? ''}
              onChange={(e) => setSelectedRunId(Number(e.target.value))}
              className="w-full min-w-0 rounded-lg border border-slate-300 bg-white py-1.5 pl-2.5 pr-8 text-sm font-medium text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200 sm:w-56"
              aria-label="Choose delivery"
            >
              {runs.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.town} · {shortDate(x.deliveryDate)}
                  {x.status !== 'open' ? ` (${RUN_STATUS_STYLE[x.status].label.toLowerCase()})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

/** Shown instead of a tab body when there is no delivery yet / runs failed to load. */
export function NoRunGate({ store }: { store: StoreData }): JSX.Element | null {
  if (store.runsError && !store.runs) return <ErrorNote onRetry={() => void store.reloadRuns()}>{store.runsError}</ErrorNote>;
  if (!store.runs) return <LoadingBlock label="Loading deliveries…" />;
  if (store.runs.length === 0)
    return (
      <EmptyState icon="🚚" title="No delivery planned yet">
        <p>Create the next delivery (date, pickup spot, order cutoff) and orders will show up here.</p>
        <Button className="mt-4" onClick={() => store.navigate('/runs')}>
          Plan a delivery
        </Button>
      </EmptyState>
    );
  return null;
}

/** Polls the orders of one run every `intervalMs`. */
export function useRunOrders(runId: number | null, intervalMs = 5000) {
  const [data, setData] = useState<{ runId: number; run: Run; orders: Order[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(runId);
  current.current = runId;

  const load = useCallback(async () => {
    if (runId == null) return;
    try {
      const r = await api.runOrders(runId);
      if (current.current !== runId) return;
      setData({ runId, run: r.run, orders: r.orders });
      setError(null);
    } catch (err) {
      if (current.current === runId) setError(errMsg(err, 'Failed to load orders.'));
    }
  }, [runId]);
  usePolling(load, intervalMs, runId != null, runId);

  useEffect(() => {
    setError(null);
  }, [runId]);

  const fresh = data && data.runId === runId ? data : null;
  const replaceOrder = useCallback((o: Order) => {
    setData((d) => (d ? { ...d, orders: d.orders.some((x) => x.id === o.id) ? d.orders.map((x) => (x.id === o.id ? o : x)) : [...d.orders, o] } : d));
  }, []);
  return { run: fresh?.run ?? null, orders: fresh?.orders ?? null, error, reload: load, replaceOrder };
}
