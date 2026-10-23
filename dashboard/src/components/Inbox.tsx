import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { normalizePhone, usePolling } from '../lib';
import type { Conversation, Settings } from '../types';
import { ChatThread } from './ChatThread';
import { ConversationList } from './ConversationList';
import { NewChatDialog } from './NewChatDialog';
import { SettingsDrawer } from './SettingsDrawer';
import { Button, Toggle } from './ui';

const LIST_POLL_MS = 5000;

/** The open conversation lives in the URL (/c/<phone>) so Back works on mobile. */
function phoneFromUrl(): string | null {
  const m = window.location.pathname.match(/^\/c\/(\d+)\/?$/);
  return m ? m[1] : null;
}

export function Inbox({ onLogout }: { onLogout: () => void }): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(phoneFromUrl);
  const [search, setSearch] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- conversations -------------------------------------------------------
  const loadConversations = useCallback(async () => {
    try {
      const list = await api.conversations();
      setConversations(list);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load conversations.');
    }
  }, []);
  usePolling(loadConversations, LIST_POLL_MS);

  // ---- settings ------------------------------------------------------------
  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      setSettings(await api.settings());
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to load settings.');
    }
  }, []);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>): Promise<boolean> => {
      setSettingsBusy(true);
      setSaveError(null);
      try {
        const next = await api.updateSettings(patch);
        setSettings(next);
        // Reflect the new allow-list in the list right away; the next poll confirms it.
        setConversations((list) => list?.map((c) => ({ ...c, allowed: next.allowedPhones.includes(c.phone) })) ?? list);
        return true;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save settings.');
        return false;
      } finally {
        setSettingsBusy(false);
      }
    },
    [],
  );

  // ---- selection / routing -------------------------------------------------
  useEffect(() => {
    const onPop = () => setSelected(phoneFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = useCallback((phone: string | null) => {
    const path = phone ? `/c/${phone}` : '/';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setSelected(phone);
    if (phone) {
      // Opening a thread marks it read on the server; mirror that locally.
      setConversations((list) => list?.map((c) => (c.phone === phone ? { ...c, unread: 0 } : c)) ?? list);
    }
  }, []);

  const onBack = useCallback(() => select(null), [select]);

  const onActivity = useCallback(() => {
    void loadConversations();
  }, [loadConversations]);

  const selectedConv = conversations?.find((c) => c.phone === selected);
  const isAllowed = selected
    ? settings
      ? settings.allowedPhones.includes(selected)
      : (selectedConv?.allowed ?? false)
    : false;

  async function toggleAllowed() {
    if (!selected) return;
    const current = settings ?? (await api.settings().catch(() => null));
    if (!current) {
      setSaveError('Settings not loaded yet.');
      return;
    }
    const allowedPhones = current.allowedPhones.includes(selected)
      ? current.allowedPhones.filter((p) => p !== selected)
      : [...current.allowedPhones, normalizePhone(selected)];
    await updateSettings({ allowedPhones });
  }

  const totalUnread = conversations?.reduce((n, c) => n + c.unread, 0) ?? 0;
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) WhatsApp Inbox` : 'WhatsApp Inbox';
    return () => {
      document.title = 'WhatsApp Inbox';
    };
  }, [totalUnread]);

  return (
    <div className="flex h-full justify-center md:p-4">
      <div className="flex h-full w-full max-w-[1400px] overflow-hidden bg-white md:rounded-xl md:border md:border-slate-200 md:shadow-sm">
        {/* Left: conversation list */}
        <aside
          className={`${selected ? 'hidden md:flex' : 'flex'} w-full min-w-0 flex-col border-r border-slate-200 md:w-[340px] md:shrink-0 lg:w-[380px]`}
        >
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
            <h1 className="flex-1 truncate text-base font-semibold tracking-tight">
              Inbox{totalUnread > 0 && <span className="ml-1.5 text-sm font-medium text-emerald-600">{totalUnread}</span>}
            </h1>
            <label className="flex items-center gap-1.5 text-xs text-slate-600" title="Auto-reply bot">
              Bot
              <Toggle
                label="Auto-reply"
                checked={settings?.autoReply ?? false}
                disabled={!settings || settingsBusy}
                onChange={(v) => void updateSettings({ autoReply: v })}
              />
            </label>
            <Button size="sm" onClick={() => setNewChatOpen(true)}>
              + New
            </Button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200"
              aria-label="Settings"
              title="Settings"
            >
              ⚙
            </button>
          </div>
          {saveError && !settingsOpen && (
            <p className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700" role="alert">
              {saveError}
            </p>
          )}
          <ConversationList
            conversations={conversations}
            error={listError}
            selected={selected}
            search={search}
            onSearch={setSearch}
            onSelect={select}
            onRetry={() => void loadConversations()}
          />
          <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-xs text-slate-400">
            <span>Updates every 5s</span>
            <button type="button" onClick={onLogout} className="font-medium text-slate-500 hover:text-slate-800">
              Log out
            </button>
          </div>
        </aside>

        {/* Right: thread */}
        <main className={`${selected ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {selected ? (
            <ChatThread
              key={selected}
              phone={selected}
              fallback={selectedConv}
              allowed={isAllowed}
              allowBusy={settingsBusy}
              onToggleAllowed={() => void toggleAllowed()}
              onBack={onBack}
              onActivity={onActivity}
            />
          ) : (
            <div className="chat-bg flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <span className="text-4xl">💬</span>
              <p className="text-base font-medium text-slate-700">Select a conversation</p>
              <p className="max-w-xs text-sm text-slate-500">
                Pick a chat on the left, or start a new one with a template message.
              </p>
              <Button variant="secondary" onClick={() => setNewChatOpen(true)}>
                + New chat
              </Button>
            </div>
          )}
        </main>
      </div>

      <NewChatDialog
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onStarted={(phone) => {
          setNewChatOpen(false);
          select(phone);
          void loadConversations();
        }}
      />
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
      />
    </div>
  );
}
