import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { STORE_NAME } from '../config';
import { errMsg, pickActiveRun, usePolling } from '../lib';
import type { Product, RunSummary, Settings } from '../types';
import { IconChat, IconLogout, IconOrders, IconPacking, IconProducts, IconSettings, IconTruck } from './icons';
import { Inbox } from './Inbox';
import { OrdersTab } from './OrdersTab';
import { PackingTab } from './PackingTab';
import { ProductsTab } from './ProductsTab';
import { RunsTab } from './RunsTab';
import { SettingsDrawer } from './SettingsDrawer';
import { Toaster } from './ui';

export type TabId = 'orders' | 'packing' | 'products' | 'runs' | 'chats';

const TABS: Array<{ id: TabId; label: string; path: string; icon: (p: { className?: string }) => JSX.Element }> = [
  { id: 'orders', label: 'Orders', path: '/orders', icon: IconOrders },
  { id: 'packing', label: 'Packing list', path: '/packing', icon: IconPacking },
  { id: 'products', label: 'Products', path: '/products', icon: IconProducts },
  { id: 'runs', label: 'Deliveries', path: '/runs', icon: IconTruck },
  { id: 'chats', label: 'Chats', path: '/chats', icon: IconChat },
];

function tabFromPath(path: string): TabId {
  if (path.startsWith('/c/') || path.startsWith('/chats')) return 'chats';
  if (path.startsWith('/packing')) return 'packing';
  if (path.startsWith('/products')) return 'products';
  if (path.startsWith('/runs')) return 'runs';
  return 'orders';
}

/** Shared store data handed to the tabs. */
export interface StoreData {
  runs: RunSummary[] | null;
  runsError: string | null;
  reloadRuns: () => Promise<void>;
  products: Product[] | null;
  productsError: string | null;
  reloadProducts: () => Promise<void>;
  setProducts: (fn: (list: Product[] | null) => Product[] | null) => void;
  selectedRunId: number | null;
  setSelectedRunId: (id: number) => void;
  navigate: (path: string) => void;
}

export function Shell({ onLogout }: { onLogout: () => void }): JSX.Element {
  // ---- routing ---------------------------------------------------------------
  const [path, setPath] = useState(() => window.location.pathname);
  const navigate = useCallback((to: string) => {
    if (window.location.pathname !== to) window.history.pushState(null, '', to);
    setPath(to);
    if (!to.startsWith('/c/')) document.getElementById('main-scroll')?.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    if (window.location.pathname === '/') window.history.replaceState(null, '', '/orders');
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const tab = tabFromPath(path);
  const inThread = path.startsWith('/c/');

  // ---- runs & products ---------------------------------------------------------
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const reloadRuns = useCallback(async () => {
    try {
      const list = await api.runs();
      setRuns(list);
      setRunsError(null);
      setSelectedRunId((cur) => (cur != null && list.some((r) => r.id === cur) ? cur : (pickActiveRun(list)?.id ?? list[0]?.id ?? null)));
    } catch (err) {
      setRunsError(errMsg(err, 'Failed to load deliveries.'));
    }
  }, []);
  usePolling(reloadRuns, 20_000);

  const [products, setProductsState] = useState<Product[] | null>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  const reloadProducts = useCallback(async () => {
    try {
      setProductsState(await api.products());
      setProductsError(null);
    } catch (err) {
      setProductsError(errMsg(err, 'Failed to load products.'));
    }
  }, []);
  useEffect(() => {
    void reloadProducts();
  }, [reloadProducts]);

  // ---- settings (shared by the drawer and the Chats header) ----------------------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      setSettings(await api.settings());
    } catch (err) {
      setSettingsError(errMsg(err, 'Failed to load settings.'));
    }
  }, []);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  const updateSettings = useCallback(async (patch: Partial<Settings>): Promise<boolean> => {
    setSettingsBusy(true);
    setSaveError(null);
    try {
      setSettings(await api.updateSettings(patch));
      return true;
    } catch (err) {
      setSaveError(errMsg(err, 'Failed to save settings.'));
      return false;
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  // ---- unread badge for Chats ---------------------------------------------------------
  const [unread, setUnread] = useState(0);
  const loadUnread = useCallback(async () => {
    try {
      const list = await api.conversations();
      setUnread(list.reduce((n, c) => n + c.unread, 0));
    } catch {
      /* the badge is best-effort */
    }
  }, []);
  usePolling(loadUnread, 10_000, tab !== 'chats');

  useEffect(() => {
    document.title = unread > 0 && tab !== 'chats' ? `(${unread}) ${STORE_NAME}` : STORE_NAME;
  }, [unread, tab]);

  const store: StoreData = {
    runs,
    runsError,
    reloadRuns,
    products,
    productsError,
    reloadProducts,
    setProducts: setProductsState,
    selectedRunId,
    setSelectedRunId,
    navigate,
  };

  let content: ReactNode;
  switch (tab) {
    case 'orders':
      content = <OrdersTab store={store} />;
      break;
    case 'packing':
      content = <PackingTab store={store} />;
      break;
    case 'products':
      content = <ProductsTab />;
      break;
    case 'runs':
      content = <RunsTab />;
      break;
    case 'chats':
      content = (
        <Inbox
          path={path}
          navigate={navigate}
          settings={settings}
          settingsBusy={settingsBusy}
          saveError={settingsOpen ? null : saveError}
          updateSettings={updateSettings}
          onUnreadChange={setUnread}
        />
      );
      break;
  }

  return (
    <div className="flex h-full flex-col bg-[#f7f5f2] print:block print:h-auto print:bg-white">
      {/* Header */}
      <header className={`shrink-0 border-b border-slate-200 bg-white print:hidden ${inThread ? 'hidden md:block' : ''}`}>
        <div className="h-1 bg-gradient-to-r from-brand-500 via-amber-300 to-leaf-600" aria-hidden />
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 md:py-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-bold tracking-tight text-white shadow-sm"
          >
            IS
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold leading-tight tracking-tight text-slate-900">{STORE_NAME}</p>
            <p className="truncate text-xs text-slate-500">Orders dashboard</p>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 rounded-full border border-slate-200 py-1 pl-2.5 pr-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            aria-label={`Settings. WhatsApp bot is ${settings?.autoReply ? 'on' : 'off'}`}
            title="Settings"
          >
            <span className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${settings == null ? 'bg-slate-300' : settings.autoReply ? 'bg-leaf-500' : 'bg-slate-400'}`}
                aria-hidden
              />
              <span className="hidden sm:inline">Bot {settings == null ? '…' : settings.autoReply ? 'on' : 'off'}</span>
            </span>
            <IconSettings className="h-5 w-5 text-slate-500" />
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="hidden rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 md:inline-flex"
            aria-label="Log out"
            title="Log out"
          >
            <IconLogout />
          </button>
        </div>
        {/* Desktop tabs */}
        <nav className="mx-auto hidden max-w-6xl gap-1 px-3 md:flex" aria-label="Sections">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <a
                key={t.id}
                href={t.path}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(t.path);
                }}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-2 rounded-t-lg px-3.5 py-2.5 text-sm font-medium transition-colors ${
                  active ? 'text-brand-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                }`}
              >
                <t.icon className="h-[18px] w-[18px]" />
                {t.label}
                {t.id === 'chats' && unread > 0 && (
                  <span className="rounded-full bg-leaf-600 px-1.5 text-[11px] font-semibold text-white">{unread}</span>
                )}
                {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-500" aria-hidden />}
              </a>
            );
          })}
        </nav>
      </header>

      {/* Content */}
      <main
        id="main-scroll"
        className={`min-h-0 flex-1 print:overflow-visible ${tab === 'chats' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
      >
        {content}
      </main>

      {/* Mobile bottom tabs */}
      <nav
        className={`shrink-0 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden print:hidden ${inThread ? 'hidden' : ''}`}
        aria-label="Sections"
      >
        <div className="grid grid-cols-5">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <a
                key={t.id}
                href={t.path}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(t.path);
                }}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-w-0 flex-col items-center gap-0.5 px-1 pb-2 pt-2.5 text-[11px] font-medium ${
                  active ? 'text-brand-700' : 'text-slate-500'
                }`}
              >
                {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-brand-500" aria-hidden />}
                <span className="relative">
                  <t.icon className="h-6 w-6" />
                  {t.id === 'chats' && unread > 0 && (
                    <span className="absolute -right-2 -top-1 min-w-[18px] rounded-full bg-leaf-600 px-1 text-center text-[10px] font-semibold leading-[18px] text-white">
                      {unread}
                    </span>
                  )}
                </span>
                <span className="w-full truncate text-center">{t.id === 'packing' ? 'Packing' : t.label}</span>
              </a>
            );
          })}
        </div>
      </nav>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSaveError(null);
        }}
        settings={settings}
        loadError={settingsError}
        busy={settingsBusy}
        saveError={saveError}
        onUpdate={updateSettings}
        onRetry={() => void loadSettings()}
        onLogout={onLogout}
      />
      <Toaster />
    </div>
  );
}
