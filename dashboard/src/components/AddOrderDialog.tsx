import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { categoryOrder, errMsg, euros, isCategoryClosed, normalizePhone, num, productLabel, unitPrice } from '../lib';
import type { Order, Product, Run } from '../types';
import { IconSearch } from './icons';
import { Button, ErrorNote, Field, LoadingBlock, Modal, inputCls } from './ui';

function step(p: Product): number {
  return p.unit === 'kg' ? 0.5 : 1;
}

export function AddOrderDialog({
  open,
  onClose,
  run,
  products,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  run: Run;
  products: Product[] | null;
  onCreated: (o: Order) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setPhone('');
      setNote('');
      setSearch('');
      setQty({});
      setError(null);
    }
  }, [open]);

  const active = useMemo(() => (products ?? []).filter((p) => p.active), [products]);
  const byId = useMemo(() => new Map(active.map((p) => [p.id, p])), [active]);
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      active.filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.aliases.some((a) => a.includes(q)),
      ),
    [active, q],
  );
  const groups = categoryOrder(
    filtered.map((p) => p.category),
    active,
  ).map((c) => ({ category: c, items: filtered.filter((p) => p.category === c) }));

  const chosen = Object.entries(qty)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ p: byId.get(id)!, n }))
    .filter((x) => x.p);
  const total = chosen.reduce((s, x) => s + Math.round(x.n * x.p.priceCents), 0);
  const phoneDigits = normalizePhone(phone);
  const phoneOk = !phone.trim() || (phoneDigits.length >= 8 && phoneDigits.length <= 15);
  const canSave = name.trim().length > 0 && chosen.length > 0 && phoneOk && !busy;

  function bump(p: Product, dir: 1 | -1) {
    setQty((m) => {
      const cur = m[p.id] ?? 0;
      let next = cur + dir * step(p);
      if (dir === 1 && cur === 0 && p.unit === 'kg') next = 1;
      next = Math.max(0, Math.round(next * 100) / 100);
      return { ...m, [p.id]: next };
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api.createOrder({
        runId: run.id,
        customerName: name.trim(),
        phone: phoneDigits || undefined,
        items: chosen.map((x) => ({ productId: x.p.id, qty: x.n })),
        note: note.trim() || undefined,
      });
      onCreated(order);
    } catch (err) {
      setError(errMsg(err, 'Could not save the order.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an order"
      subtitle="For orders that came by phone or in the group"
      wide
      footer={
        <>
          <span className="mr-auto text-sm text-slate-600">
            {chosen.length === 0 ? (
              'No products yet'
            ) : (
              <>
                {chosen.length} product{chosen.length > 1 ? 's' : ''} · <strong className="text-slate-900">{euros(total)}</strong>
              </>
            )}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave} loading={busy}>
            Save order
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name" htmlFor="ao-name">
            <input id="ao-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Anita" autoComplete="off" />
          </Field>
          <Field label="Phone (optional)" htmlFor="ao-phone" hint={!phoneOk ? 'Digits with country code, e.g. 33 6 12 34 56 78' : undefined}>
            <input
              id="ao-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputCls}
              inputMode="tel"
              placeholder="+33 6 12 34 56 78"
              autoComplete="off"
            />
          </Field>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Products</p>
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search okra, kaju, atta…"
              aria-label="Search products"
              className={`${inputCls} pl-9`}
            />
          </div>
          <div className="mt-2 max-h-[40dvh] overflow-y-auto rounded-xl border border-slate-200 sm:max-h-72">
            {!products && <LoadingBlock label="Loading products…" />}
            {products && filtered.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">No product matches “{search}”.</p>}
            {groups.map((g) => (
              <div key={g.category}>
                <p className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 backdrop-blur">
                  {g.category}
                  {isCategoryClosed(run, g.category) && <span className="ml-2 normal-case text-amber-700">· cutoff passed</span>}
                </p>
                <ul className="divide-y divide-slate-100">
                  {g.items.map((p) => {
                    const n = qty[p.id] ?? 0;
                    return (
                      <li key={p.id} className={`flex items-center gap-3 px-3 py-2 ${n > 0 ? 'bg-brand-50/60' : ''}`}>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">{productLabel(p)}</p>
                          <p className="text-xs text-slate-500">{unitPrice(p)}</p>
                        </div>
                        {n === 0 ? (
                          <button
                            type="button"
                            onClick={() => bump(p, 1)}
                            className="rounded-full border border-brand-300 px-3 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                            aria-label={`Add ${p.name}`}
                          >
                            Add
                          </button>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => bump(p, -1)}
                              className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-lg leading-none text-slate-700 hover:bg-white"
                              aria-label={`Less ${p.name}`}
                            >
                              −
                            </button>
                            <span className="w-14 text-center text-sm font-semibold tabular-nums text-slate-900">
                              {p.unit === 'kg' ? `${num(n)} kg` : num(n)}
                            </span>
                            <button
                              type="button"
                              onClick={() => bump(p, 1)}
                              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-lg leading-none text-white hover:bg-brand-700"
                              aria-label={`More ${p.name}`}
                            >
                              +
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <Field label="Note (optional)" htmlFor="ao-note">
          <input id="ao-note" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="e.g. will pay by Lydia" />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
