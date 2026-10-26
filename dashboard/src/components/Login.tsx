import { useState, type FormEvent } from 'react';
import { ApiError, API_URL, login } from '../api';
import { STORE_NAME } from '../config';
import { Button, ErrorNote, inputCls } from './ui';

export function Login({ onSuccess, notice }: { onSuccess: () => void; notice?: string }): JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Wrong password.'
          : err instanceof Error
            ? err.message
            : 'Login failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <form onSubmit={submit} className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 pt-7 shadow-sm relative">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-500 via-amber-300 to-leaf-600" aria-hidden />
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-bold text-white shadow-sm">IS</span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{STORE_NAME}</h1>
            <p className="text-sm text-slate-500">Orders dashboard</p>
          </div>
        </div>
        {notice && <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}
        <label htmlFor="pw" className="mb-1 block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="pw"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
        />
        {error && (
          <div className="mt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <Button type="submit" loading={busy} disabled={!password} className="mt-4 w-full">
          Sign in
        </Button>
        <p className="mt-4 truncate text-center text-xs text-slate-400" title={API_URL}>
          API: {API_URL}
        </p>
      </form>
    </div>
  );
}
