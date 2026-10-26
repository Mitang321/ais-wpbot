/** Shapes from CONTRACT.md §1 — keep in sync with the dashboard. */

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

export type Direction = 'in' | 'out';
export type MessageType = 'text' | 'template' | 'interactive' | 'image' | 'other';
export type MessageStatus = 'received' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  phone: string;
  direction: Direction;
  type: MessageType;
  text: string;
  status: MessageStatus;
  error?: string;
  auto: boolean;
  ts: number;
}

export interface Settings {
  autoReply: boolean;
  allowedPhones: string[];
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------- Grocery store (GROCERY-CONTRACT.md) ----------

export type ProductUnit = 'kg' | 'pack' | 'pc' | 'bunch';

export interface Product {
  id: string;                 // slug, e.g. "okra", "kaju-katli-250g"
  name: string;               // "Okra (Bhindi)"
  category: string;           // "Vegetables" | "Sweets" | "Rice & Atta" | "Dal & Pulses" | "Spices" | "Snacks" | "Dairy" | ...
  unit: ProductUnit;          // what qty counts: kg, or packs/pieces/bunches
  packLabel: string | null;   // "20 kg bag", "250 g box" (for pack/pc units)
  packGrams: number | null;   // grams per pack, so "500g kaju katli" -> 2 packs
  priceCents: number;         // EUR cents per unit (per kg, or per pack/pc/bunch)
  aliases: string[];          // lowercase alternative words: ["bhindi", "lady finger"]
  active: boolean;
  sort: number;
}

export type RunStatus = 'open' | 'closed' | 'delivered';

export interface Run {
  id: number;
  town: string;               // "Manosque"
  deliveryDate: string;       // "2026-11-06" (Europe/Paris calendar date)
  deliveryTime: string;       // "evening, around 6pm"
  pickupSpot: string;         // "School parking"
  cutoffAt: number;           // ms; general order cutoff
  vegCutoffAt: number | null; // ms; earlier cutoff for category "Vegetables"
  status: RunStatus;
  createdAt: number;
}

export interface RunSummary extends Run {
  orderCount: number;         // non-cancelled orders
  totalCents: number;
  paidCents: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  category: string;
  qty: number;                // in product unit (kg may be fractional, e.g. 0.5)
  unit: ProductUnit;
  packLabel: string | null;
  unitPriceCents: number;
  lineTotalCents: number;     // round(qty * unitPriceCents)
}

export type OrderStatus = 'confirmed' | 'packed' | 'collected' | 'cancelled';

export interface Order {
  id: number;
  runId: number;
  phone: string;              // digits only; "" for manual orders without a phone
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
