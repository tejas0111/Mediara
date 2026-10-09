/* JSON/SSE client for the Mediara backend. Same-origin by default; the base
   can be overridden (persisted) but no backend URL is ever hardcoded here. */

import type {
  Budget,
  ChatResponse,
  RecalledItem,
  ThinkStep,
} from './chat';

/* ---------------------------------------------------------------- errors */

export class ApiError extends Error {
  status: number;
  data: unknown;
  loginRequired: boolean;
  demoUser?: string;
  needsRelink: boolean;
  retiredDeployment: boolean;
  resetAt?: string;
  resetInHrs?: number;

  constructor(status: number, data: unknown, fallback?: string) {
    const d = (data ?? {}) as Record<string, unknown>;
    super(
      (typeof d.error === 'string' && d.error) ||
        (typeof d.message === 'string' && d.message) ||
        fallback ||
        `Request failed (${status})`,
    );
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    // 429/409 metadata survives on the error object so the UI can react.
    this.loginRequired = d.loginRequired === true;
    this.demoUser = typeof d.demoUser === 'string' ? d.demoUser : undefined;
    this.needsRelink = d.needsRelink === true;
    this.retiredDeployment = d.retiredDeployment === true;
    this.resetAt =
      (typeof d.resetAt === 'string' && d.resetAt) ||
      (typeof d.resetsAt === 'string' && d.resetsAt) ||
      undefined;
    this.resetInHrs =
      typeof d.resetInHrs === 'number' ? d.resetInHrs : undefined;
  }
}

/* -------------------------------------------------------------- identity */

const DEVICE_KEY = 'ddDeviceId';

export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = { 'X-Device-Id': deviceId() };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/* ------------------------------------------------------------ env routing */

const BASE_KEY = 'ddApiBase';
let apiBase = (localStorage.getItem(BASE_KEY) ?? '').replace(/\/+$/, '');

export function getApiBase(): string {
  return apiBase;
}

export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, '');
  if (apiBase) localStorage.setItem(BASE_KEY, apiBase);
  else localStorage.removeItem(BASE_KEY);
}

export type EnvMode = 'local' | 'mainnet' | 'unknown';

export interface Health {
  ok: boolean;
  mode: EnvMode;
}

/** Reachability + memory-backend mode of the current API base. */
export async function checkHealth(): Promise<Health> {
  try {
    const r = await fetch(`${apiBase}/api/seed-status?user=demo-mom`, {
      headers: headers(false),
      credentials: 'include',
    });
    if (!r.ok) return { ok: false, mode: 'unknown' };
    const d = (await r.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const mode: EnvMode = d?.mode === 'mainnet' ? 'mainnet' : 'local';
    return { ok: true, mode };
  } catch {
    return { ok: false, mode: 'unknown' };
  }
}

/* ----------------------------------------------------------------- core */

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${apiBase}${path}`, {
    credentials: 'include',
    ...init,
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || r.statusText };
  }
  if (!r.ok) throw new ApiError(r.status, data);
  return data as T;
}

const q = (user: string) => `?user=${encodeURIComponent(user)}`;

/* ------------------------------------------------------------------ chat */

export interface ChatOpts {
  model?: string;
  memory?: boolean;
  signal?: AbortSignal;
}

function chatBody(userId: string, message: string, opts: ChatOpts): string {
  const provider = getProvider();
  return JSON.stringify({
    userId,
    message,
    deviceId: deviceId(),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.memory === false ? { memory: false } : {}),
    ...(provider ? { provider } : {}),
  });
}

export function chat(
  userId: string,
  message: string,
  opts: ChatOpts = {},
): Promise<ChatResponse> {
  return req<ChatResponse>('/api/chat', {
    method: 'POST',
    headers: headers(),
    body: chatBody(userId, message, opts),
    signal: opts.signal,
  });
}

export interface StreamHandlers {
  onThinking?: (thinking: ThinkStep[], recalledMeta: RecalledItem[]) => void;
  onToken?: (t: string) => void;
  onDone?: (full: ChatResponse) => void;
}

/**
 * POST /api/chat/stream — SSE. Server emits
 *   event: thinking  data: {thinking: ThinkStep[], recalledMeta}
 *   event: token     data: {t}
 *   event: done      data: full ChatResponse
 *   event: error     data: same JSON body as the REST error
 * and terminates with data: [DONE].
 *
 * The stream bypasses the Netlify 200-proxy (which buffers the whole body
 * and would defeat word-by-word delivery): on the hosted UI origin it goes
 * direct to the API host with credentials, same as a user override.
 */
const streamBase = (): string =>
  apiBase ||
  (typeof location !== 'undefined' && location.hostname.endsWith('.netlify.app')
    ? 'https://mediara-production.up.railway.app'
    : '');
export async function chatStream(
  userId: string,
  message: string,
  opts: ChatOpts,
  handlers: StreamHandlers,
): Promise<ChatResponse> {
  const r = await fetch(`${streamBase()}/api/chat/stream`, {
    method: 'POST',
    headers: headers(),
    credentials: 'include',
    body: chatBody(userId, message, opts),
    signal: opts.signal,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    throw new ApiError(r.status, data);
  }
  if (!r.body) throw new ApiError(0, { error: 'stream-unavailable' });

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ev = '';
  let dataLines: string[] = [];
  let final: ChatResponse | null = null;

  const flush = (): void => {
    const raw = dataLines.join('\n');
    dataLines = [];
    const kind = ev;
    ev = '';
    if (!raw) return;
    if (raw === '[DONE]') return;
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (kind === 'thinking') {
      handlers.onThinking?.(
        (json.thinking as ThinkStep[]) ?? [],
        (json.recalledMeta as RecalledItem[]) ?? [],
      );
    } else if (kind === 'token') {
      handlers.onToken?.(typeof json.t === 'string' ? json.t : '');
    } else if (kind === 'done') {
      final = json as unknown as ChatResponse;
      handlers.onDone?.(final);
    } else if (kind === 'error') {
      // error event carries the same JSON body as the REST error
      const status = typeof json.status === 'number' ? json.status : 500;
      throw new ApiError(status, json);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line === '') flush();
      else if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
  if (!final) throw new ApiError(0, { error: 'stream-incomplete' });
  return final;
}

/* ----------------------------------------------------------------- reads */

export interface SummarySection {
  label: string;
  items: { text: string; blobId?: string | null }[];
}

export interface Summary {
  user: string;
  medications?: { text: string; blobId?: string | null }[];
  allergies?: { text: string; blobId?: string | null }[];
  routine?: { text: string; blobId?: string | null }[];
  contacts?: { text: string; blobId?: string | null }[];
  sections?: SummarySection[];
}

export const summary = (user: string) =>
  req<Summary>(`/api/summary${q(user)}`, { headers: headers(false) });

export interface ExportFact {
  text: string;
  blobId?: string | null;
  createdAt?: string;
}

export interface ExportData {
  user: string;
  facts?: ExportFact[];
  memories?: ExportFact[];
}

export const exportMemory = (user: string) =>
  req<ExportData>(`/api/export${q(user)}`, { headers: headers(false) });

export interface SeedStatus {
  user: string;
  seeded?: boolean;
  count?: number;
  mode?: string;
  days?: { day: number; facts: ExportFact[] }[];
}

export const seedStatus = (user: string) =>
  req<SeedStatus>(`/api/seed-status${q(user)}`, { headers: headers(false) });

export interface GuardProofEntry {
  id?: string;
  ts?: string;
  verdict?: string;
  reason?: string;
  factText?: string;
  text?: string;
  blobId?: string | null;
  hash?: string;
  prevHash?: string;
  prev?: string;
  user?: string;
}

export interface GuardProof {
  ok?: boolean;
  entries?: GuardProofEntry[];
  ledger?: GuardProofEntry[];
  verify?: { ok?: boolean; checked?: number };
}

export const guardProof = () =>
  req<GuardProof>('/api/guard-proof', { headers: headers(false) });

export const proactive = (user: string) =>
  req<Record<string, unknown>>(`/api/proactive${q(user)}`, {
    headers: headers(false),
  });

export interface UsageUser {
  id?: string;
  user?: string;
  namespace?: string;
  memories?: number;
  turns?: number;
  guards?: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface Usage {
  users?: UsageUser[];
  totals?: { users?: number; memories?: number; turns?: number };
}

export const usage = () => req<Usage>('/api/usage', { headers: headers(false) });

export interface DashboardData {
  personal?: {
    turns?: number;
    memories?: number;
    guardStops?: number;
    memoriesCapped?: boolean;
    guardStale?: boolean;
    budget?: Budget;
  };
  demo?: { used?: number; cap?: number; remaining?: number; resetAt?: string };
  vault?: {
    signedIn?: boolean;
    onboarded?: boolean;
    needsRelink?: boolean;
    pendingPhase?: string | null;
  };
}

export const dashboard = (user: string) =>
  req<DashboardData>(`/api/dashboard${q(user)}`, { headers: headers(false) });

/* ----------------------------------------------------------------- auth */

export interface AuthChallenge {
  nonce: string;
  message: string;
}

export const authMessage = () =>
  req<AuthChallenge>('/api/auth/message', { headers: headers(false) });

export const authVerify = (address: string, signature: string, nonce: string) =>
  req<{ ok?: boolean; address?: string }>('/api/auth/verify', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ address, signature, nonce }),
  });

export const authLogout = () =>
  req<{ ok?: boolean }>('/api/auth/logout', {
    method: 'POST',
    headers: headers(),
    body: '{}',
  });

/* ---------------------------------------------------------------- wallet */

export interface WalletStatus {
  signedIn?: boolean;
  address?: string;
  onboarded?: boolean;
  needsRelink?: boolean;
  retiredDeployment?: boolean;
  pendingPhase?: string | null;
}

export const walletStatus = () =>
  req<WalletStatus>('/api/wallet/status', { headers: headers(false) });

const walletPost = (path: string) =>
  req<Record<string, unknown>>(path, {
    method: 'POST',
    headers: headers(),
    body: '{}',
  });

export const walletOnboardCreate = () => walletPost('/api/wallet/onboard/create');
export const walletOnboardLink = () => walletPost('/api/wallet/onboard/link');
export const walletOnboardComplete = () =>
  walletPost('/api/wallet/onboard/complete');
/** Step 2 with a wallet signature: submits the signed tx bytes server-side. */
export const walletOnboardCompleteSig = (signature: string) =>
  req<Record<string, unknown>>('/api/wallet/onboard/complete', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ signature }),
  });
export const walletRelink = () => walletPost('/api/wallet/relink');
export const walletReset = () => walletPost('/api/wallet/reset');

/* ---------------------------------------------------------------- models */

export interface ModelInfo {
  id: string;
  name?: string;
}

/** Registry is free-only on the server; we just render what it returns. */
export async function models(): Promise<ModelInfo[]> {
  const d = await req<unknown>('/api/models', { headers: headers(false) });
  const list = Array.isArray(d)
    ? d
    : ((d as Record<string, unknown>)?.models as unknown[]) ?? [];
  return list
    .map((m): ModelInfo | null => {
      if (typeof m === 'string') return { id: m };
      if (m && typeof m === 'object') {
        const o = m as Record<string, unknown>;
        if (typeof o.id === 'string')
          return { id: o.id, name: typeof o.name === 'string' ? o.name : undefined };
      }
      return null;
    })
    .filter((m): m is ModelInfo => m !== null);
}

const MODEL_KEY = 'ddModel';

export const getSavedModel = (): string => localStorage.getItem(MODEL_KEY) ?? '';
export const saveModel = (id: string): void => {
  if (id) localStorage.setItem(MODEL_KEY, id);
  else localStorage.removeItem(MODEL_KEY);
};

/* ------------------------------------------------------ custom provider */

/** Bring-your-own model endpoint. Stored only in this browser; attached to
    chat request bodies verbatim and never logged anywhere. */
export interface CustomProvider {
  kind: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
}

const PROVIDER_KEY = 'ddProvider';

export function getProvider(): CustomProvider | null {
  try {
    const raw = localStorage.getItem(PROVIDER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CustomProvider>;
    if (
      (p.kind === 'openai' || p.kind === 'anthropic') &&
      typeof p.baseUrl === 'string' &&
      p.baseUrl.length > 0 &&
      typeof p.apiKey === 'string' &&
      p.apiKey.length > 0 &&
      typeof p.model === 'string' &&
      p.model.length > 0
    ) {
      return { kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveProvider(p: CustomProvider | null): void {
  if (p) localStorage.setItem(PROVIDER_KEY, JSON.stringify(p));
  else localStorage.removeItem(PROVIDER_KEY);
  window.dispatchEvent(new Event('ddprovider'));
}

/** "openrouter/google/gemini-2.5-flash:free" -> "Gemini 2.5 Flash" */
export function prettyModel(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const clean = tail.replace(/:.*$/, '');
  const parts = clean.split(/[-_.]+/).filter(Boolean);
  if (!parts.length) return id;
  return parts
    .map((p) =>
      /^\d+(\.\d+)*[a-z]?$/i.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1),
    )
    .join(' ');
}
