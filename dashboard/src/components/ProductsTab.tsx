import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { UNIT_OPTIONS, categoryOrder, centsToInput, errMsg, euros, parseEuros, unitPrice } from '../lib';
import type { Product, ProductUnit } from '../types';
import { IconPlus, IconSearch } from './icons';
import type { StoreData } from './Shell';
import { Button, Card, EmptyState, ErrorNote, Field, LoadingBlock, Modal, Toggle, inputCls, selectCls, toast } from './ui';

// ---------------------------------------------------------------------------
// Data: uses the Shell's shared product list when given, else loads its own.
// ---------------------------------------------------------------------------

function useProducts(store?: StoreData) {
  const [local, setLocal] = useState<Product[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const reloadLocal = useCallback(async () => {
    try {
      setLocal(await api.products());
      setLocalError(null);
    } catch (err) {
      setLocalError(errMsg(err, 'Failed to load products.'));
    }
  }, []);
  useEffect(() => {
    if (!store) void reloadLocal();
  }, [store == null, reloadLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (store) {
    return {
      products: store.products,
      error: store.productsError,
      reload: store.reloadProducts,
      setProducts: store.setProducts,
    };
  }
  return { products: local, error: localError, reload: reloadLocal, setProducts: setLocal };
}

function matches(p: Product, q: string): boolean {
  if (!q) return true;
  const hay = [p.name, p.category, p.packLabel ?? '', ...p.aliases].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

const UNIT_SHORT: Record<ProductUnit, string> = { kg: 'per kg', pack: 'per pack', pc: 'per piece', bunch: 'per bunch' };

function sizeLabel(p: Product): string {
  if (p.packLabel) return p.packLabel;
  return UNIT_SHORT[p.unit];
}

// ---------------------------------------------------------------------------
// Inline price editor
// ---------------------------------------------------------------------------

function PriceCell({ product, onSave }: { product: Product; onSave: (cents: number) => Promise<boolean> }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const start = () => {
    done.current = false;
    setValue(centsToInput(product.priceCents));
    setInvalid(false);
    setEditing(true);
  };

  const commit = async () => {
    if (done.current) return;
    const cents = parseEuros(value);
    if (cents == null || cents <= 0) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    done.current = true;
    if (cents === product.priceCents) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onSave(cents);
    setSaving(false);
    if (ok) setEditing(false);
    else {
      done.current = false;
      inputRef.current?.focus();
    }
  };

  const cancel = () => {
    done.current = true;
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        title="Tap to change the price"
        className="group inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-right font-semibold tabular-nums text-slate-900 hover:border-brand-200 hover:bg-brand-50"
      >
        {unitPrice(product)}
        <span aria-hidden className="text-xs text-slate-300 group-hover:text-brand-500">
          ✎
        </span>
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-sm text-slate-500">€</span>
      <input
        ref={inputRef}
        inputMode="decimal"
        value={value}
        disabled={saving}
        aria-label={`Price of ${product.name} in euros`}
        aria-invalid={invalid}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit()}
        className={`w-20 rounded-md border px-2 py-1 text-right text-sm font-semibold tabular-nums focus:outline-none focus:ring-2 ${
          invalid ? 'border-red-400 focus:ring-red-200' : 'border-brand-400 focus:ring-brand-200'
        }`}
      />
      {product.unit !== 'pack' && <span className="text-xs text-slate-500">/{product.unit}</span>}
      {saving && <span className="text-xs text-slate-400">Saving…</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add product dialog
// ---------------------------------------------------------------------------

interface Draft {
  name: string;
  category: string;
  unit: ProductUnit;
  packLabel: string;
  packGrams: string;
  price: string;
  aliases: string;
}

const EMPTY_DRAFT: Draft = { name: '', category: '', unit: 'pack', packLabel: '', packGrams: '', price: '', aliases: '' };

function AddProductDialog({
  open,
  onClose,
  categories,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  categories: string[];
  onCreated: (p: Product) => void;
}): JSX.Element {
  const [d, setD] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setD({ ...EMPTY_DRAFT, category: categories[0] ?? '' });
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const name = d.name.trim();
    const category = d.category.trim();
    const priceCents = parseEuros(d.price);
    if (!name) return setError('Please enter the product name.');
    if (!category) return setError('Please choose or type a category.');
    if (priceCents == null || priceCents <= 0) return setError('Please enter a valid price, e.g. 4.50');
    let packGrams: number | null = null;
    if (d.packGrams.trim()) {
      const g = Number(d.packGrams.replace(',', '.'));
      if (!Number.isFinite(g) || g <= 0) return setError('Pack grams must be a positive number.');
      packGrams = Math.round(g);
    }
    const aliases = d.aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProduct({
        name,
        category,
        unit: d.unit,
        packLabel: d.packLabel.trim() || null,
        packGrams,
        priceCents,
        aliases,
      });
      onCreated(p);
      toast(`Added ${p.name}`);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Could not add the product.'));
    } finally {
      setBusy(false);
    }
  };

  const priceHint = d.unit === 'kg' ? 'Price for 1 kg' : d.unit === 'bunch' ? 'Price for 1 bunch' : d.unit === 'pc' ? 'Price for 1 piece' : 'Price for 1 pack';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add product"
      subtitle="Customers can order it on WhatsApp right away."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Add product
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="Name" htmlFor="np-name">
          <input
            id="np-name"
            className={inputCls}
            value={d.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Kaju katli"
            autoFocus
          />
        </Field>

        <Field label="Category" htmlFor="np-cat" hint="Pick one below or type a new one.">
          <input
            id="np-cat"
            className={inputCls}
            value={d.category}
            onChange={(e) => set('category', e.target.value)}
            list="np-cat-list"
            placeholder="e.g. Sweets"
          />
          <datalist id="np-cat-list">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {categories.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('category', c)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                    d.category === c ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Sold" htmlFor="np-unit">
            <select id="np-unit" className={selectCls} value={d.unit} onChange={(e) => set('unit', e.target.value as ProductUnit)}>
              {UNIT_OPTIONS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price (€)" htmlFor="np-price" hint={priceHint}>
            <input
              id="np-price"
              className={inputCls}
              inputMode="decimal"
              value={d.price}
              onChange={(e) => set('price', e.target.value)}
              placeholder="4.50"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Pack label" htmlFor="np-pack" hint="Optional">
            <input
              id="np-pack"
              className={inputCls}
              value={d.packLabel}
              onChange={(e) => set('packLabel', e.target.value)}
              placeholder="250 g box"
            />
          </Field>
          <Field label="Pack grams" htmlFor="np-grams" hint="Optional">
            <input
              id="np-grams"
              className={inputCls}
              inputMode="numeric"
              value={d.packGrams}
              onChange={(e) => set('packGrams', e.target.value)}
              placeholder="250"
            />
          </Field>
        </div>

        <Field label="Other names" htmlFor="np-aliases" hint="Comma-separated. Helps the bot understand orders, e.g. bhindi, lady finger.">
          <input
            id="np-aliases"
            className={inputCls}
            value={d.aliases}
            onChange={(e) => set('aliases', e.target.value)}
            placeholder="kaju barfi, cashew sweet"
          />
        </Field>

        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function ProductsTab({ store }: { store?: StoreData } = {}): JSX.Element {
  const { products, error, reload, setProducts } = useProducts(store);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const replace = useCallback(
    (p: Product) => setProducts((list) => (list ? (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]) : [p])),
    [setProducts],
  );

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const savePrice = async (p: Product, priceCents: number): Promise<boolean> => {
    try {
      replace(await api.updateProduct(p.id, { priceCents }));
      toast(`${p.name}: now ${euros(priceCents)}`);
      return true;
    } catch (err) {
      toast(errMsg(err, 'Could not save the price.'), 'error');
      return false;
    }
  };

  const setActive = async (p: Product, active: boolean) => {
    setBusy(p.id, true);
    replace({ ...p, active }); // optimistic
    try {
      replace(await api.updateProduct(p.id, { active }));
      toast(active ? `${p.name} is back on the list` : `${p.name} hidden from customers`, active ? 'success' : 'info');
    } catch (err) {
      replace(p);
      toast(errMsg(err, 'Could not update the product.'), 'error');
    } finally {
      setBusy(p.id, false);
    }
  };

  const categories = useMemo(() => (products ? categoryOrder(products.map((p) => p.category), products) : []), [products]);

  const groups = useMemo(() => {
    if (!products) return [];
    const q = query.trim();
    return categories
      .map((category) => ({
        category,
        items: products
          .filter((p) => p.category === category && matches(p, q))
          .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
      }))
      .filter((g) => g.items.length > 0);
  }, [products, categories, query]);

  const activeCount = products?.filter((p) => p.active).length ?? 0;
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  let body: JSX.Element;
  if (!products && error) body = <ErrorNote onRetry={() => void reload()}>{error}</ErrorNote>;
  else if (!products) body = <LoadingBlock label="Loading products…" />;
  else if (products.length === 0)
    body = (
      <EmptyState icon="🧺" title="No products yet">
        <p>Add the products you sell, with their prices. Customers will see them when they type “list” on WhatsApp.</p>
        <Button className="mt-4" onClick={() => setAdding(true)}>
          <IconPlus className="h-4 w-4" /> Add product
        </Button>
      </EmptyState>
    );
  else if (groups.length === 0)
    body = (
      <EmptyState icon="🔍" title={`Nothing matches “${query.trim()}”`}>
        <button type="button" className="font-medium text-brand-700 underline" onClick={() => setQuery('')}>
          Clear search
        </button>
      </EmptyState>
    );
  else
    body = (
      <div className="space-y-5">
        {error && <ErrorNote onRetry={() => void reload()}>{error}</ErrorNote>}
        {groups.map((g) => (
          <section key={g.category} aria-labelledby={`cat-${g.category}`}>
            <h3 id={`cat-${g.category}`} className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {g.category}
              <span className="rounded-full bg-slate-200/70 px-2 text-xs font-medium normal-case tracking-normal text-slate-600">{g.items.length}</span>
            </h3>

            {/* Mobile: cards */}
            <div className="space-y-2 md:hidden">
              {g.items.map((p) => (
                <Card key={p.id} className={`flex items-center gap-3 px-4 py-3 ${p.active ? '' : 'bg-slate-50 opacity-70'}`}>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate font-medium ${p.active ? 'text-slate-900' : 'text-slate-500 line-through decoration-slate-300'}`}>{p.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {sizeLabel(p)}
                      {!p.active && ' · hidden'}
                    </p>
                    <div className="-ml-2 mt-0.5">
                      <PriceCell product={p} onSave={(c) => savePrice(p, c)} />
                    </div>
                  </div>
                  <Toggle
                    checked={p.active}
                    disabled={busyIds.has(p.id)}
                    onChange={(v) => void setActive(p, v)}
                    label={`${p.name} available to customers`}
                  />
                </Card>
              ))}
            </div>

            {/* Desktop: compact table */}
            <Card className="hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Product</th>
                    <th className="px-4 py-2 font-medium">Size / unit</th>
                    <th className="px-4 py-2 font-medium">Other names</th>
                    <th className="px-4 py-2 text-right font-medium">Price</th>
                    <th className="w-28 px-4 py-2 text-right font-medium">Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {g.items.map((p) => (
                    <tr key={p.id} className={p.active ? 'hover:bg-slate-50/60' : 'bg-slate-50/80 text-slate-400'}>
                      <td className={`px-4 py-1.5 font-medium ${p.active ? 'text-slate-900' : 'text-slate-400 line-through decoration-slate-300'}`}>{p.name}</td>
                      <td className="px-4 py-1.5 text-slate-600">{sizeLabel(p)}</td>
                      <td className="max-w-[16rem] truncate px-4 py-1.5 text-xs text-slate-400" title={p.aliases.join(', ')}>
                        {p.aliases.join(', ') || '—'}
                      </td>
                      <td className="px-4 py-1 text-right">
                        <PriceCell product={p} onSave={(c) => savePrice(p, c)} />
                      </td>
                      <td className="px-4 py-1.5">
                        <div className="flex justify-end">
                          <Toggle
                            checked={p.active}
                            disabled={busyIds.has(p.id)}
                            onChange={(v) => void setActive(p, v)}
                            label={`${p.name} available to customers`}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>
        ))}
      </div>
    );

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-4 md:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">Products & prices</h2>
          <p className="text-sm text-slate-500">
            {products
              ? `${activeCount} available · ${products.length - activeCount} hidden · tap a price to change it`
              : 'What customers can order on WhatsApp'}
          </p>
        </div>
        <Button onClick={() => setAdding(true)} className="sm:self-auto">
          <IconPlus className="h-4 w-4" /> Add product
        </Button>
      </div>

      {products && products.length > 0 && (
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products, categories, other names…"
            aria-label="Search products"
            className={`${inputCls} rounded-xl py-2.5 pl-9`}
          />
        </div>
      )}
      {query.trim() && shown > 0 && <p className="-mt-2 px-1 text-xs text-slate-500">{shown} found</p>}

      {body}

      <AddProductDialog open={adding} onClose={() => setAdding(false)} categories={categories} onCreated={replace} />
    </div>
  );
}
