/** Tiny fetch wrapper: base URL, bearer token, JSON, typed errors, global 401 handling. */
import type { Conversation, Message, Settings } from './types';

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/+$/, '');

const SESSION_KEY = 'wa-dashboard.session';

interface StoredSession {
  token: string;
  expiresAt: number;
}

function loadToken(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (!s.token || (s.expiresAt && s.expiresAt < Date.now())) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s.token;
  } catch {
    return null;
  }
}

function saveSession(s: StoredSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session lives in memory only */
  }
}

let token: string | null = loadToken();
let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export function hasToken(): boolean {
  return token !== null;
}

export function logout(): void {
  token = null;
  saveSession(null);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', `Can't reach the server at ${API_URL}.`);
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  const obj = (data ?? {}) as { ok?: boolean; error?: string; message?: string };

  if (!res.ok || obj.ok === false) {
    if (res.status === 401 && auth) {
      logout();
      onUnauthorized();
    }
    throw new ApiError(
      res.status,
      obj.error || `http_${res.status}`,
      obj.message || obj.error || `Request failed (${res.status} ${res.statusText})`,
    );
  }
  return data as T;
}

export async function login(password: string): Promise<void> {
  const r = await request<{ token: string; expiresAt: number }>('POST', '/api/login', { password }, false);
  token = r.token;
  saveSession({ token: r.token, expiresAt: r.expiresAt });
}

export const api = {
  conversations: () =>
    request<{ conversations: Conversation[] }>('GET', '/api/conversations').then((r) => r.conversations),
  thread: (phone: string, before?: number) =>
    request<{ contact: Conversation; messages: Message[] }>(
      'GET',
      `/api/conversations/${encodeURIComponent(phone)}${before ? `?before=${before}` : ''}`,
    ),
  send: (to: string, text: string) =>
    request<{ message: Message }>('POST', '/api/send', { to, text }).then((r) => r.message),
  sendTemplate: (to: string, template: string, language = 'en_US') =>
    request<{ message: Message }>('POST', '/api/send-template', { to, template, language }).then((r) => r.message),
  settings: () => request<{ settings: Settings }>('GET', '/api/settings').then((r) => r.settings),
  updateSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings }>('PUT', '/api/settings', patch).then((r) => r.settings),
};
