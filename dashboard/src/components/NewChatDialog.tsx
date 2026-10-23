import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { formatPhone, normalizePhone } from '../lib';
import { DEFAULT_LANGUAGE, DEFAULT_TEMPLATE } from './Composer';
import { Button, ErrorNote, Modal, inputCls } from './ui';

export function NewChatDialog({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (phone: string) => void;
}): JSX.Element {
  const [phoneRaw, setPhoneRaw] = useState('');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phone = normalizePhone(phoneRaw);
  const phoneValid = phone.length >= 8 && phone.length <= 15;

  function close() {
    setError(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!phoneValid || !template.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendTemplate(phone, template.trim(), language.trim() || DEFAULT_LANGUAGE);
      setPhoneRaw('');
      onStarted(phone);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the template.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="New chat">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="nc-phone" className="mb-1 block text-sm font-medium text-slate-700">
            Phone number
          </label>
          <input
            id="nc-phone"
            autoFocus
            inputMode="tel"
            value={phoneRaw}
            onChange={(e) => setPhoneRaw(e.target.value)}
            placeholder="+91 98123 45678"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-slate-500">
            Include the country code. {phone && (phoneValid ? <>Will send to <b>{formatPhone(phone)}</b> ({phone}).</> : 'Needs 8–15 digits.')}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label htmlFor="nc-tpl" className="mb-1 block text-sm font-medium text-slate-700">
              Template
            </label>
            <input id="nc-tpl" value={template} onChange={(e) => setTemplate(e.target.value)} className={inputCls} />
          </div>
          <div className="w-28">
            <label htmlFor="nc-lang" className="mb-1 block text-sm font-medium text-slate-700">
              Language
            </label>
            <input id="nc-lang" value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls} />
          </div>
        </div>
        <p className="text-xs text-slate-500">
          A new conversation must start with an approved template. Free text unlocks once they reply.
        </p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!phoneValid || !template.trim()}>
            Send template
          </Button>
        </div>
      </form>
    </Modal>
  );
}
