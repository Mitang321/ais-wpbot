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
