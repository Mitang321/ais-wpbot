import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, ErrorNote, inputCls } from './ui';

export const DEFAULT_TEMPLATE = 'hello_world';
export const DEFAULT_LANGUAGE = 'en_US';

/**
 * Bottom bar of a thread. When the 24h window is open: free-text textarea.
 * When closed: disabled textarea + template sender.
 */
export function Composer({
  windowOpen,
  error,
  onDismissError,
  onSend,
  onSendTemplate,
}: {
  windowOpen: boolean;
  error: string | null;
  onDismissError: () => void;
  onSend: (text: string) => Promise<boolean>;
  onSendTemplate: (template: string, language: string) => Promise<boolean>;
}): JSX.Element {
  const [text, setText] = useState('');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [sendingTpl, setSendingTpl] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to ~6 lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 144)}px`;
    ta.style.overflowY = ta.scrollHeight > 144 ? 'auto' : 'hidden';
  }, [text]);

  async function send() {
    const t = text.trim();
    if (!t || !windowOpen) return;
    setText('');
    const ok = await onSend(t);
    if (!ok) setText((cur) => cur || t); // give the text back if nothing was accepted
    taRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  async function sendTemplate() {
    if (!template.trim()) return;
    setSendingTpl(true);
    try {
      await onSendTemplate(template.trim(), language.trim() || DEFAULT_LANGUAGE);
    } finally {
      setSendingTpl(false);
    }
  }

  return (
    <div className="border-t border-slate-200 bg-white px-3 py-2">
      {error && (
        <div className="mb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ErrorNote>{error}</ErrorNote>
          </div>
          <button type="button" onClick={onDismissError} className="p-1 text-slate-400 hover:text-slate-600" aria-label="Dismiss error">
            ✕
          </button>
        </div>
      )}

      {!windowOpen && (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-sm font-medium text-amber-900">24h window closed — send a template</p>
          <p className="mb-2 text-xs text-amber-800">
            Free text is only allowed within 24 hours of the contact's last message.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              aria-label="Template name"
              placeholder="template name"
              className={`${inputCls} !w-auto min-w-0 flex-1 basis-full py-1.5 sm:basis-0`}
            />
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label="Template language"
              placeholder="en_US"
              className={`${inputCls} !w-24 py-1.5`}
            />
            <Button onClick={sendTemplate} loading={sendingTpl} disabled={!template.trim()}>
              Send template
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={!windowOpen}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={windowOpen ? 'Type a message  (Enter to send, Shift+Enter for a new line)' : 'Window closed'}
          aria-label="Message"
          className={`${inputCls} resize-none`}
        />
        <Button onClick={() => void send()} disabled={!windowOpen || !text.trim()} className="h-[38px]">
          Send
        </Button>
      </div>
    </div>
  );
}
