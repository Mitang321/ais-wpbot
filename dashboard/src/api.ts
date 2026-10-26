/** Tiny fetch wrapper: base URL, bearer token, JSON, typed errors, global 401 handling. */
import type {
  BroadcastResult,
  Conversation,
  ItemInput,
  Message,
  Order,
  OrderInput,
  OrderStatus,
  Product,
  ProductInput,
  Run,
  RunInput,
  RunStatus,
  RunSummary,
  Settings,
} from './types';

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


  // ---- grocery store (GROCERY-CONTRACT.md §1) ----
  products: () => request<{ products: Product[] }>('GET', '/api/products').then((r) => r.products),
  createProduct: (input: ProductInput) =>
    request<{ product: Product }>('POST', '/api/products', input).then((r) => r.product),
  updateProduct: (id: string, patch: Partial<ProductInput> & { active?: boolean }) =>
    request<{ product: Product }>('PUT', `/api/products/${encodeURIComponent(id)}`, patch).then((r) => r.product),

  runs: () => request<{ runs: RunSummary[] }>('GET', '/api/runs').then((r) => r.runs),
  createRun: (input: RunInput) => request<{ run: Run }>('POST', '/api/runs', input).then((r) => r.run),
  updateRun: (id: number, patch: Partial<RunInput> & { status?: RunStatus }) =>
    request<{ run: Run }>('PUT', `/api/runs/${id}`, patch).then((r) => r.run),
  runOrders: (id: number) => request<{ run: Run; orders: Order[] }>('GET', `/api/runs/${id}/orders`),
  broadcast: (id: number, text: string) =>
    request<BroadcastResult>('POST', `/api/runs/${id}/broadcast`, { text }).then((r) => ({
      sent: r.sent ?? 0,
      skipped: r.skipped ?? 0,
      failed: r.failed ?? 0,
    })),

  createOrder: (input: OrderInput) => request<{ order: Order }>('POST', '/api/orders', input).then((r) => r.order),
  updateOrder: (id: number, patch: { status?: OrderStatus; paid?: boolean; note?: string; items?: ItemInput[] }) =>
    request<{ order: Order }>('PUT', `/api/orders/${id}`, patch).then((r) => r.order),
};
