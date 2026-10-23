import { useState, type FormEvent } from 'react';
import { formatPhone, normalizePhone } from '../lib';
import type { Settings } from '../types';
import { Button, Drawer, ErrorNote, Spinner, Toggle, inputCls } from './ui';

export function SettingsDrawer({
  open,
  onClose,
  settings,
  loadError,
  busy,
  saveError,
  onUpdate,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
  loadError: string | null;
  busy: boolean;
  saveError: string | null;
  onUpdate: (patch: Partial<Settings>) => Promise<boolean>;
  onRetry: () => void;
}): JSX.Element {
  const [newPhone, setNewPhone] = useState('');
  const digits = normalizePhone(newPhone);
  const valid = digits.length >= 8 && digits.length <= 15;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!settings || !valid) return;
    if (settings.allowedPhones.includes(digits)) {
      setNewPhone('');
      return;
    }
    if (await onUpdate({ allowedPhones: [...settings.allowedPhones, digits] })) setNewPhone('');
  }

  return (
    <Drawer open={open} onClose={onClose} title="Settings" subtitle="Auto-reply bot">
      {!settings && !loadError && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}
      {loadError && <ErrorNote onRetry={onRetry}>{loadError}</ErrorNote>}
      {settings && (
        <div className="space-y-6">
          {saveError && <ErrorNote>{saveError}</ErrorNote>}
          <section className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Auto-reply</h3>
              <p className="mt-0.5 text-sm text-slate-500">
                Answer catalog searches automatically. Only replies to the allowed numbers below.
              </p>
            </div>
            <Toggle
              label="Auto-reply"
              checked={settings.autoReply}
              disabled={busy}
              onChange={(v) => void onUpdate({ autoReply: v })}
            />
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-900">Allowed numbers</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              The bot only auto-replies to these. Everyone else still shows up in the inbox.
            </p>
            <form onSubmit={add} className="mt-3 flex gap-2">
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                inputMode="tel"
                placeholder="+91 98123 45678"
                aria-label="Phone number to allow"
                className={inputCls}
              />
              <Button type="submit" disabled={!valid || busy}>
                Add
              </Button>
            </form>
            {newPhone && !valid && <p className="mt-1 text-xs text-slate-500">Digits with country code, 8–15 long.</p>}
            <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {settings.allowedPhones.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-slate-500">No numbers yet: the bot replies to nobody.</li>
              )}
              {settings.allowedPhones.map((p) => (
                <li key={p} className="flex items-center justify-between px-3 py-2">
                  <span className="text-sm text-slate-800">
                    {formatPhone(p)} <span className="text-xs text-slate-400">({p})</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void onUpdate({ allowedPhones: settings.allowedPhones.filter((x) => x !== p) })}
                    aria-label={`Remove ${p}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Drawer>
  );
}
