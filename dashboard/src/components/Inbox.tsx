import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../lib';
import type { Conversation, Settings } from '../types';
import { ChatThread } from './ChatThread';
import { ConversationList } from './ConversationList';
import { NewChatDialog } from './NewChatDialog';
import { Button, Toggle } from './ui';

const LIST_POLL_MS = 5000;

/** The open conversation lives in the URL (/c/<phone>) so Back works on mobile. */
function phoneFromPath(path: string): string | null {
  const m = path.match(/^\/c\/(\d+)\/?$/);
  return m ? m[1] : null;
}

export function Inbox({
  path,
  navigate,
  settings,
  settingsBusy,
  saveError,
  updateSettings,
  onUnreadChange,
}: {
  path: string;
  navigate: (path: string) => void;
  settings: Settings | null;
  settingsBusy: boolean;
  saveError: string | null;
  updateSettings: (patch: Partial<Settings>) => Promise<boolean>;
  onUnreadChange: (n: number) => void;
}): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const selected = phoneFromPath(path);
  const [search, setSearch] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);

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

  // "allowed" in the list means "the bot may answer": an empty allow-list means everyone (GROCERY-CONTRACT §2).
  const shown = useMemo(
    () =>
      settings && conversations
        ? conversations.map((c) => ({
            ...c,
            allowed: settings.allowedPhones.length === 0 || settings.allowedPhones.includes(c.phone),
          }))
        : conversations,
    [settings, conversations],
  );

  // ---- selection / routing -------------------------------------------------
  const select = useCallback((phone: string | null) => {
    navigate(phone ? `/c/${phone}` : '/chats');
    if (phone) {
      // Opening a thread marks it read on the server; mirror that locally.
      setConversations((list) => list?.map((c) => (c.phone === phone ? { ...c, unread: 0 } : c)) ?? list);
    }
  }, [navigate]);

  const onBack = useCallback(() => select(null), [select]);

  const onActivity = useCallback(() => {
    void loadConversations();
  }, [loadConversations]);

  const selectedConv = conversations?.find((c) => c.phone === selected);
  // GROCERY-CONTRACT §2: the bot replies when auto-reply is on and the allow-list is empty or has the number.
  const botReplies =
    !!selected && !!settings?.autoReply && (settings.allowedPhones.length === 0 || settings.allowedPhones.includes(selected));

  const totalUnread = conversations?.reduce((n, c) => n + c.unread, 0) ?? 0;
  useEffect(() => {
    onUnreadChange(totalUnread);
  }, [totalUnread, onUnreadChange]);

  return (
    <div className="flex min-h-0 flex-1 justify-center md:p-4">
      <div className="flex h-full w-full max-w-6xl overflow-hidden bg-white md:rounded-xl md:border md:border-slate-200 md:shadow-sm">
        {/* Left: conversation list */}
        <aside
          className={`${selected ? 'hidden md:flex' : 'flex'} w-full min-w-0 flex-col border-r border-slate-200 md:w-[340px] md:shrink-0 lg:w-[380px]`}
        >
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
            <h1 className="flex-1 truncate text-base font-semibold tracking-tight">
              WhatsApp chats{totalUnread > 0 && <span className="ml-1.5 text-sm font-medium text-leaf-600">{totalUnread}</span>}
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
          </div>
          {saveError && (
            <p className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700" role="alert">
              {saveError}
            </p>
          )}
          <ConversationList
            conversations={shown}
            error={listError}
            selected={selected}
            search={search}
            onSearch={setSearch}
            onSelect={select}
            onRetry={() => void loadConversations()}
          />
          <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-400">Updates every 5 s</p>
        </aside>

        {/* Right: thread */}
        <section className={`${selected ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {selected ? (
            <ChatThread
              key={selected}
              phone={selected}
              fallback={selectedConv}
              botReplies={botReplies}
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
        </section>
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
    </div>
  );
}
