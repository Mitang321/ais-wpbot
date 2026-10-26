import { useMemo, useState } from 'react';
import { STORE_NAME, VEG_CATEGORY } from '../config';
import { aggregatePacking, copyText, euros, productLabel, qtyShort, qtyTotal, runTitle, type PackGroup } from '../lib';
import type { Run } from '../types';
import { IconChevron, IconCopy, IconPrint } from './icons';
import { NoRunGate, RunBar, useRunOrders } from './RunBar';
import type { StoreData } from './Shell';
import { Button, Card, EmptyState, ErrorNote, LoadingBlock, toast } from './ui';

const CATEGORY_ICON: Record<string, string> = {
  Vegetables: '🥬',
  Sweets: '🍬',
  'Rice & Atta': '🌾',
  'Dal & Pulses': '🫘',
  Spices: '🌶️',
  Snacks: '🥨',
  Dairy: '🧀',
  Frozen: '🧊',
  Pickles: '🥭',
  Drinks: '🥤',
};
export function categoryIcon(c: string): string {
  return CATEGORY_ICON[c] ?? CATEGORY_ICON[c.split(' & ')[0]!] ?? '🛒';
}

function whatsappText(groups: PackGroup[], run: Run, title: string): string {
  const lines = [`*${title}*`, `${runTitle(run)} · ${run.deliveryTime}`, ''];
  for (const g of groups) {
    lines.push(`*${g.category}*`);
    for (const r of g.rows) lines.push(`• ${productLabel(r)} – ${qtyTotal(r.qty, r.unit)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function PackingTab({ store }: { store: StoreData }): JSX.Element {
  const { run, orders, error, reload } = useRunOrders(store.selectedRunId, 10_000);
  const groups = useMemo(() => (orders ? aggregatePacking(orders, store.products ?? []) : null), [orders, store.products]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const live = (orders ?? []).filter((o) => o.status !== 'cancelled');
  const lines = groups?.reduce((n, g) => n + g.rows.length, 0) ?? 0;
  const vegKg = groups?.find((g) => g.category === VEG_CATEGORY)?.rows.reduce((s, r) => s + (r.unit === 'kg' ? r.qty : 0), 0) ?? 0;
  const toPack = live.filter((o) => o.status === 'confirmed').length;
  const veg = groups?.filter((g) => g.category === VEG_CATEGORY) ?? [];

  async function copy(text: string, what: string) {
    if (await copyText(text)) toast(`${what} copied. Paste it in WhatsApp 👍`);
    else toast('Could not copy. Select the text and copy it by hand.', 'error');
  }

  const gate = NoRunGate({ store });

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-4 md:py-6 print:max-w-none print:p-0">
      {gate ?? (
        <>
          <div className="hidden print:block">
            <p className="text-sm text-slate-500">{STORE_NAME} · Packing list</p>
          </div>
          <RunBar store={store} run={run} />

          {error && <ErrorNote onRetry={() => void reload()}>{error}</ErrorNote>}
          {!groups && !error && <LoadingBlock label="Adding up the orders…" />}

          {groups && run && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
                <Mini label="Orders" value={String(live.length)} />
                <Mini label="Products" value={String(lines)} />
                <Mini label="Vegetables" value={`${Math.round(vegKg * 10) / 10} kg`} />
                <Mini label="Still to pack" value={`${toPack} order${toPack === 1 ? '' : 's'}`} />
              </div>

              <div className="flex flex-wrap gap-2 print:hidden">
                <Button onClick={() => void copy(whatsappText(groups, run, `${STORE_NAME} – packing list`), 'Packing list')} disabled={lines === 0}>
                  <IconCopy className="h-4 w-4" /> Copy as WhatsApp text
                </Button>
                <Button
                  variant="success"
                  onClick={() => void copy(whatsappText(veg, run, 'Vegetable order'), 'Vegetable order')}
                  disabled={veg.length === 0}
                >
                  🥬 Vegetable order for supplier
                </Button>
                <Button variant="secondary" onClick={() => window.print()} disabled={lines === 0}>
                  <IconPrint className="h-4 w-4" /> Print
                </Button>
              </div>

              {lines === 0 && (
                <EmptyState icon="📦" title="Nothing to pack yet">
                  The list fills up by itself as orders come in.
                </EmptyState>
              )}

              {groups.map((g) => (
                <Card key={g.category} className="overflow-hidden print:break-inside-avoid print:rounded-none print:border-x-0 print:shadow-none">
                  <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                    <span aria-hidden>{categoryIcon(g.category)}</span>
                    <h3 className="flex-1 text-sm font-semibold uppercase tracking-wide text-slate-700">{g.category}</h3>
                    <span className="text-xs text-slate-500">
                      {g.rows.length} product{g.rows.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {g.rows.map((r) => {
                      const isOpen = !!open[r.productId];
                      return (
                        <li key={r.productId}>
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setOpen((m) => ({ ...m, [r.productId]: !isOpen }))}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
                          >
                            <IconChevron className={`h-4 w-4 shrink-0 text-slate-400 transition-transform print:hidden ${isOpen ? 'rotate-90' : ''}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[15px] font-medium text-slate-900">{productLabel(r)}</span>
                              <span className="block text-xs text-slate-500">
                                {r.customers.length} customer{r.customers.length === 1 ? '' : 's'} · {euros(r.cents)}
                              </span>
                            </span>
                            <span className="shrink-0 rounded-lg bg-brand-50 px-2.5 py-1 text-base font-semibold tabular-nums text-brand-800 print:bg-transparent">
                              {qtyTotal(r.qty, r.unit)}
                            </span>
                          </button>
                          <ul className={`${isOpen ? 'block' : 'hidden'} space-y-1 bg-slate-50/70 px-4 pb-3 pl-11 pt-1 text-sm print:block print:bg-transparent print:pb-2 print:pt-0`}>
                            {r.customers.map((c) => (
                              <li key={c.orderId} className="flex items-baseline gap-2 text-slate-600">
                                <span className="w-16 shrink-0 tabular-nums font-medium text-slate-800">{qtyShort(c.qty, r.unit)}</span>
                                <span className="min-w-0 flex-1 truncate">
                                  {c.name} <span className="text-xs text-slate-400">#{c.orderId}</span>
                                </span>
                                {c.status !== 'confirmed' && (
                                  <span className="shrink-0 text-xs text-leaf-700">{c.status === 'packed' ? 'packed' : 'collected'} ✓</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Card className="px-4 py-3 print:rounded-none print:shadow-none">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-slate-900">{value}</p>
    </Card>
  );
}
