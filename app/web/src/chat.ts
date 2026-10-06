// Chat session model + localStorage persistence + hash routing.
// Sessions are namespaced per user: localStorage key `ddChats:<userId>`.

export interface RecalledRef {
  text: string;
  blob_id: string | null;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  savedBlob?: string | null;
  memoryPersisted?: boolean | null;
  recalled?: RecalledRef[];
  ts: number;
}

export interface ChatSession {
  id: string;
  title: string;
  startedAt: number;
  msgs: ChatMsg[];
}

export type ViewKey =
  | 'chat'
  | 'memory'
  | 'demo'
  | 'replay'
  | 'compare'
  | 'proof'
  | 'stats'
  | 'print'
  | 'wallet';

/** Parsed location hash: a plain view, or the chat view with a session. */
export type Route = ViewKey | { chat: 'chat'; sessionId: string };

const VIEWS: ViewKey[] = [
  'chat',
  'memory',
  'demo',
  'replay',
  'compare',
  'proof',
  'stats',
  'print',
  'wallet',
];

function isView(s: string): s is ViewKey {
  return (VIEWS as string[]).includes(s);
}

export function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0) return 'chat';
  const [head, tail] = parts;
  if (head === 'chat' && tail) return { chat: 'chat', sessionId: decodeURIComponent(tail) };
  if (isView(head)) return head;
  return 'chat';
}

export function navigate(view: ViewKey, sessionId?: string): void {
  if (view === 'chat' && sessionId) {
    window.location.hash = `#/chat/${encodeURIComponent(sessionId)}`;
  } else if (view === 'chat') {
    window.location.hash = '#/chat';
  } else {
    window.location.hash = `#/${view}`;
  }
}

export function routeView(r: Route): ViewKey {
  return typeof r === 'string' ? r : 'chat';
}

export function routeSessionId(r: Route): string | null {
  return typeof r === 'object' && r.chat === 'chat' ? r.sessionId : null;
}

// ------------------------------------------------------- persistence ---

const keyFor = (userId: string) => `ddChats:${userId}`;
const MAX_SESSIONS = 60;

function uid(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function msgId(): string {
  return uid();
}

/** Derive a short title from the first user message. */
export function titleFor(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 44 ? `${t.slice(0, 44).trimEnd()}…` : t;
}

export function newSession(firstMsg?: string): ChatSession {
  return {
    id: uid(),
    title: firstMsg ? titleFor(firstMsg) : 'New chat',
    startedAt: Date.now(),
    msgs: [],
  };
}

export function loadSessions(userId: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.msgs));
  } catch {
    return [];
  }
}

function persist(userId: string, list: ChatSession[]): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage full or unavailable — chat still works in memory */
  }
}

export function saveSession(userId: string, session: ChatSession): ChatSession[] {
  const list = loadSessions(userId);
  const ix = list.findIndex((s) => s.id === session.id);
  const next = ix >= 0
    ? list.map((s) => (s.id === session.id ? session : s))
    : [session, ...list];
  persist(userId, next);
  return next;
}

export function deleteSession(userId: string, id: string): ChatSession[] {
  const next = loadSessions(userId).filter((s) => s.id !== id);
  persist(userId, next);
  return next;
}

export function renameSession(userId: string, id: string, title: string): ChatSession[] {
  const t = title.trim() || 'Untitled';
  const next = loadSessions(userId).map((s) => (s.id === id ? { ...s, title: t } : s));
  persist(userId, next);
  return next;
}
