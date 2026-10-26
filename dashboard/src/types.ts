// Mirrors CONTRACT.md section 1. Keep in sync with the server.

export interface Conversation {
  phone: string;
  name: string | null;
  lastMessageAt: number;
  lastMessagePreview: string;
  lastInboundAt: number | null;
  windowOpen: boolean;
  unread: number;
  allowed: boolean;
}

export interface Message {
  id: string;
  phone: string;
  direction: 'in' | 'out';
  type: 'text' | 'template' | 'interactive' | 'image' | 'other';
  text: string;
  status: 'received' | 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  auto: boolean;
  ts: number;
}

export interface Settings {
  autoReply: boolean;
  allowedPhones: string[];
}

/** Client-only extension for optimistic messages not yet confirmed by the server. */
export interface UiMessage extends Message {
  pending?: boolean;
  local?: boolean;
}

// ---------- Grocery store (GROCERY-CONTRACT.md). Mirrors server/src/types.ts. ----------

export type ProductUnit = 'kg' | 'pack' | 'pc' | 'bunch';

export interface Product {
  id: string;
  name: string;
  category: string;
  unit: ProductUnit;
  packLabel: string | null;
  packGrams: number | null;
  /** EUR cents per unit (per kg, or per pack/pc/bunch). */
  priceCents: number;
  aliases: string[];
  active: boolean;
  sort: number;
}

export type RunStatus = 'open' | 'closed' | 'delivered';

export interface Run {
  id: number;
  town: string;
  /** "2026-11-06", a Europe/Paris calendar date. */
  deliveryDate: string;
  deliveryTime: string;
  pickupSpot: string;
  cutoffAt: number;
  vegCutoffAt: number | null;
  status: RunStatus;
  createdAt: number;
}

export interface RunSummary extends Run {
  orderCount: number;
  totalCents: number;
  paidCents: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  category: string;
  qty: number;
  unit: ProductUnit;
  packLabel: string | null;
  unitPriceCents: number;
  lineTotalCents: number;
}

export type OrderStatus = 'confirmed' | 'packed' | 'collected' | 'cancelled';

export interface Order {
  id: number;
  runId: number;
  phone: string;
  customerName: string;
  items: OrderItem[];
  totalCents: number;
  status: OrderStatus;
  paid: boolean;
  note: string;
  source: 'bot' | 'manual';
  createdAt: number;
  updatedAt: number;
}

export interface ProductInput {
  name: string;
  category: string;
  unit: ProductUnit;
  packLabel?: string | null;
  packGrams?: number | null;
  priceCents: number;
  aliases?: string[];
}

export interface RunInput {
  town: string;
  deliveryDate: string;
  deliveryTime: string;
  pickupSpot: string;
  cutoffAt: number;
  vegCutoffAt?: number | null;
}

export interface ItemInput {
  productId: string;
  qty: number;
}

export interface OrderInput {
  runId: number;
  customerName: string;
  phone?: string;
  items: ItemInput[];
  note?: string;
}

export interface BroadcastResult {
  sent: number;
  skipped: number;
  failed: number;
}
