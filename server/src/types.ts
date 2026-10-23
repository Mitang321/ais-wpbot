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
