// Typed client for the Mediara JSON API. Same-origin; session cookies ride
// along automatically. Every function throws ApiError (with .status) on failure
// so views can render honest error states instead of silent blanks.

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data ?? {};
  }
}

// -------------------------------------------------------- base routing ---
// Demo|Mainnet environment switch. '' = same-origin (local demo server).
// A custom absolute URL (e.g. https://mainnet-host) routes every req() there.
// Persisted in localStorage under `ddApiBase`.
const API_BASE_KEY = 'ddApiBase';

// Guest identity: stable per-browser device id (persisted UUID, created on
// first run). Sent as X-Device-Id on every req(); the server hashes it with
// the caller IP into `guest:<hash12>` for the anonymous day budget — guests
// get personal memory with no wallet and no forced wall.
const DEVICE_KEY = 'ddDeviceId';

export function getDeviceId(): string {
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
      const c = typeof crypto !== 'undefined' ? (crypto as unknown as { randomUUID?: () => string }) : null;
      v = c?.randomUUID
        ? c.randomUUID().replace(/-/g, '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
      localStorage.setItem(DEVICE_KEY, v);
    }
    return v;
  } catch {
    return 'anon';
  }
}

export function getApiBase(): string {
  try {
    return localStorage.getItem(API_BASE_KEY) || '';
  } catch {
    return '';
  }
}

export function setApiBase(base: string): void {
  try {
    const v = String(base ?? '').trim().replace(/\/+$/, '');
    if (!v) localStorage.removeItem(API_BASE_KEY);
    else localStorage.setItem(API_BASE_KEY, v);
  } catch {
    /* storage unavailable — base stays same-origin for this session */
  }
}

export interface HealthResult {
  ok: boolean;
  mode: 'local' | 'mainnet' | null;
  error?: string;
}

/** Probe `<base>/healthz` (base '' = same-origin). Never throws. */
export async function checkHealth(base?: string): Promise<HealthResult> {
  const b = String(base ?? getApiBase()).trim().replace(/\/+$/, '');
  const url = `${b}/healthz`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return { ok: false, mode: null, error: `server responded ${r.status}` };
    const body = (await r.json().catch(() => ({}))) as { mode?: unknown };
    return { ok: true, mode: body.mode === 'mainnet' ? 'mainnet' : 'local' };
  } catch (e) {
    return { ok: false, mode: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}), 'X-Device-Id': getDeviceId() },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, String((body as { error?: unknown }).error || `request failed (${r.status})`), body as Record<string, unknown>);
  return body as T;
}

/** Strip the stored "User <id>:" label prefix for display.
 * Also strips emoji chrome (server strings like the morning brief may carry
 * pictographs such as U+2600/U+26A0/U+2705/U+274C/U+2B50): views render
 * Badge/Icon affordances instead, never raw emoji. Ellipsis, middots and
 * dashes are untouched. */
export const clean = (t: string) =>
  String(t ?? '')
    .replace(/^User\s+\S+:\s*/i, '')
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF\uFE00-\uFE0F\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u200D]/gu, '');

/** Short blob id for receipts: local-ids in full-ish, mainnet truncated. */
export const shortBlob = (id: string | null) => {
  if (!id) return null;
  return id.startsWith('local-') ? id : `${id.slice(0, 10)}…`;
};

export const walruscan = (id: string | null) =>
  id && id.length >= 32 && !id.startsWith('local-')
    ? `https://walruscan.com/mainnet/blob/${id}`
    : null;

// ------------------------------------------------------------ budget ---
// Rolling 24h sliding-window budget (demo + anon channels). resetAt = ISO of
// when the oldest in-window turn expires (null when empty); remaining counts
// down to 0, at which point the server answers 429 with RateLimitBody.
export interface Budget {
  used: number;
  cap: number;
  remaining: number;
  resetAt: string | null;
}
export interface RateLimitBody {
  error: string;
  loginRequired?: boolean;
  demoUser?: string;
  remaining: number;
  resetsAt?: string;
  resetAt: string | null;
  resetInHrs: number | null;
}

// ---------------------------------------------------------------- chat ---
export interface RecalledMeta {
  text: string;
  blob_id: string | null;
  distance: number | null;
}
export interface ThinkStep {
  label: string;
  detail: string;
}
export interface ChatResponse {
  reply: string;
  thinking: ThinkStep[];
  recalled: string[];
  recalledMeta: RecalledMeta[];
  memoryScope: string;
  identity: string;
  savedBlob: string | null;
  memoryPersisted: boolean | 'pending' | null;
  memoryOff: boolean;
  mode: 'local' | 'mainnet';
  disclaimer: string;
  budget?: Budget;
}
export const postChat = (userId: string, message: string, memory: boolean, model?: string) =>
  req<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ userId, message, memory: memory ? true : 'off', ...(model ? { model } : {}) }),
  });

// ------------------------------------------------------- chat stream ---
// Live-token SSE client for POST /api/chat/stream. Same request body as
// /api/chat; the server replies `text/event-stream` with events:
//   event: thinking  data: { thinking: ThinkStep[], recalledMeta: RecalledMeta[] }
//   event: token     data: { t: string }
//   event: done      data: ChatResponse
//   event: error     data: { error: string, ... } (same body /api/chat sends)
// A `data: [DONE]` payload (no event) also terminates the stream.
// onEvent fires for thinking|token|done only; `error` events throw ApiError.
// Resolves with the `done` payload. Throws ApiError when the stream ends
// without a `done` event.
export type ChatStreamEvent =
  | { type: 'thinking'; thinking: ThinkStep[]; recalledMeta: RecalledMeta[] }
  | { type: 'token'; token: string }
  | { type: 'done'; done: ChatResponse };
export type ChatStreamHandler = (ev: ChatStreamEvent) => void;

function parseStreamBlock(block: string): { event: string; data: string } | null {
  let event = '';
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(':')) continue; // comment keep-alive
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    else if (line === '') continue;
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function errorFromStreamText(status: number, text: string): ApiError {
  let message = `request failed (${status})`;
  let data: Record<string, unknown> = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj && typeof obj === 'object') {
        data = obj;
        if (typeof obj.error === 'string' && obj.error) message = obj.error;
      }
    } catch {
      /* keep scanning — malformed JSON never fails the error path */
    }
  }
  return new ApiError(status, message, data);
}

export async function postChatStream(
  userId: string,
  message: string,
  memory: boolean,
  model: string | undefined,
  onEvent: ChatStreamHandler,
): Promise<ChatResponse> {
  const r = await fetch(`${getApiBase()}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceId() },
    body: JSON.stringify({ userId, message, memory: memory ? true : 'off', ...(model ? { model } : {}) }),
  });
  if (!r.ok) {
    throw errorFromStreamText(r.status, await r.text().catch(() => ''));
  }
  if (!r.body) throw new ApiError(r.status || 500, 'stream unavailable', {});
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done: ChatResponse | null = null;
  const handleBlock = (block: string) => {
    if (!block.trim()) return;
    const parsed = parseStreamBlock(block);
    if (!parsed) return;
    if (parsed.data === '[DONE]') {
      // Termination marker with no payload (upstream passthrough).
      if (!done) throw new ApiError(500, 'stream ended before the answer arrived', {});
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(parsed.data) as Record<string, unknown>;
    } catch {
      return; // malformed JSON is skipped, the stream continues
    }
    if (parsed.event === 'thinking') {
      onEvent({
        type: 'thinking',
        thinking: Array.isArray(obj.thinking) ? (obj.thinking as ThinkStep[]) : [],
        recalledMeta: Array.isArray(obj.recalledMeta) ? (obj.recalledMeta as RecalledMeta[]) : [],
      });
    } else if (parsed.event === 'token') {
      const t = typeof obj.t === 'string' ? obj.t
        : typeof obj.text === 'string' ? (obj.text as string)
        : typeof obj.token === 'string' ? (obj.token as string) : '';
      if (t) onEvent({ type: 'token', token: t });
    } else if (parsed.event === 'done') {
      done = obj as unknown as ChatResponse;
      onEvent({ type: 'done', done });
    } else if (parsed.event === 'error') {
      const status = typeof obj.status === 'number' ? (obj.status as number) : 500;
      const msg = typeof obj.error === 'string' && obj.error ? (obj.error as string) : 'stream failed';
      throw new ApiError(status, msg, obj);
    }
  };
  for (;;) {
    const { value, done: rd } = await reader.read();
    if (value?.length) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleBlock(block);
      if (done) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return done;
      }
    }
    if (rd) break;
  }
  buf += decoder.decode();
  if (buf.trim()) {
    for (const block of buf.split(/\n\n/)) {
      handleBlock(block);
      if (done) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return done;
      }
    }
  }
  if (done) return done;
  throw new ApiError(500, 'stream ended before the answer arrived', {});
}
export interface ModelInfo {
  id: string;
}
export interface ModelsResponse {
  models: ModelInfo[];
  default: string;
  live: boolean;
  freeOnly: boolean;
}
export const MODEL_KEY = 'ddModel';
export const getModels = () => req<ModelsResponse>('/api/models');
export const loadModel = (): string | null => {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
};
export const saveModel = (id: string) => {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {
    /* ignore */
  }
};

// -------------------------------------------------------------- summary ---
export interface SummaryResponse {
  user: string;
  mode: string;
  generatedAt: string;
  medications: string[];
  allergies: string[];
  stopped: string[];
  superseded: string[];
  routine: string[];
  familyAndCare: string[];
  unclassified: string[];
  blobCount: number;
  stale: boolean;
  allergiesKnown: boolean;
  medicationsKnown: boolean;
  disclaimer: string;
}
export const getSummary = (userId: string) =>
  req<SummaryResponse>(`/api/summary?user=${encodeURIComponent(userId)}`);

// --------------------------------------------------------------- export ---
export interface ExportFact {
  text: string;
  blob_id: string | null;
}
export interface ExportResponse {
  user: string;
  mode: string;
  agentId: string | null;
  blobCount: number;
  facts: ExportFact[];
}
export const getExport = (userId: string) =>
  req<ExportResponse>(`/api/export?user=${encodeURIComponent(userId)}`);

// ---------------------------------------------------------- seed-status ---
export interface SeedStatus {
  user: string;
  mode: string;
  agentId: string | null;
  recalledCount: number;
  blobCount: number | null;
  namespaceCount: number | null;
  censusAvailable: boolean;
  meetsMinimum: boolean;
  stale: boolean;
}
export const getSeedStatus = (userId: string) =>
  req<SeedStatus>(`/api/seed-status?user=${encodeURIComponent(userId)}`);

// ---------------------------------------------------------- guard-proof ---
export interface GuardEntry {
  n: number;
  at: string;
  userId: string;
  kind: 'conflict' | 'interaction';
  substance: string;
  withSubstance?: string | null;
  severity: string;
  reason: string;
  fact: string;
  blobId: string | null;
  message: string;
  prev: string;
  hash: string;
}
export interface GuardProofResponse {
  count: number;
  verify: { ok: boolean; brokenAt: number | null };
  entries: GuardEntry[];
}
export const getGuardProof = () => req<GuardProofResponse>('/api/guard-proof');

// ------------------------------------------------------------ proactive ---
export interface InteractionWarning {
  substance: string;
  withSubstance: string;
  severity: string;
  reason: string;
  fact: string;
  blob_id: string | null;
  factB?: string;
  blobIdB?: string | null;
}
export interface ProactiveResponse {
  user: string;
  mode: string;
  degraded: boolean;
  morning: string | null;
  interactionWarnings: InteractionWarning[];
}
export const getProactive = (userId: string) =>
  req<ProactiveResponse>(`/api/proactive?user=${encodeURIComponent(userId)}`);

// ---------------------------------------------------------------- usage ---
export interface UsageBlob {
  blobId: string;
  text: string;
  link: string | null;
}
export interface UsageUser {
  userId: string;
  memories: number;
  turns: number;
  firstSeen: string | null;
  meetsMinimum: boolean;
  blobs: UsageBlob[];
}
export interface UsageResponse {
  generatedAt: string;
  mode: string;
  requirement: { distinctUsers: number; memoriesPerUser: number };
  qualifyingUsers: number;
  meetsRequirement: boolean;
  users: UsageUser[];
  markdown?: string;
}
export const getUsage = () => req<UsageResponse>('/api/usage');

// ---------------------------------------------------------------- wallet ---
export interface WalletStatus {
  signedIn: boolean;
  staleSession?: boolean;
  onboarded?: boolean;
  pendingPhase?: string | null;
  needsRelink?: boolean;
  address?: string;
  accountId?: string;
}
export const walletStatus = () => req<WalletStatus>('/api/wallet/status');
export const authMessage = () =>
  req<{ nonce: string; message: string }>('/api/auth/message');
export const authVerify = (address: string, signature: string, nonce: string) =>
  req<{ ok: boolean; address: string }>('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address, signature, nonce }),
  });
export const authLogout = () =>
  req<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' });
export const onboardCreate = () =>
  req<{ txBytes: string } & Record<string, unknown>>(
    '/api/wallet/onboard/create',
    { method: 'POST', body: '{}' },
  );
export const onboardLink = () =>
  req<{ txBytes: string } & Record<string, unknown>>(
    '/api/wallet/onboard/link',
    { method: 'POST', body: '{}' },
  );
export const onboardComplete = (signature: string) =>
  req<{ ok: boolean } & Record<string, unknown>>(
    '/api/wallet/onboard/complete',
    { method: 'POST', body: JSON.stringify({ signature }) },
  );
export const relink = () =>
  req<{ ok: boolean } & Record<string, unknown>>('/api/wallet/relink', {
    method: 'POST',
    body: '{}',
  });
export const resetVault = () =>
  req<{ ok: boolean } & Record<string, unknown>>('/api/wallet/reset', {
    method: 'POST',
    body: '{}',
  });

// ------------------------------------------------------------ dashboard ---
export interface DashboardDemo {
  userId: string;
  ready: boolean;
  blobCount: number;
}
export interface DashboardBudget {
  used: number;
  cap: number;
  remaining: number;
  reset: string | null;
  resetAt: string | null;
  resetInHrs: number | null;
}
export interface DashboardPersonal {
  memories: number;
  turns: number;
  budget: DashboardBudget;
  guardHits: number;
  stale: boolean;
}
export interface DashboardVault {
  signedIn: boolean;
  onboarded: boolean;
}
export interface DashboardResponse {
  user: string;
  mode: string;
  demo: DashboardDemo;
  personal: DashboardPersonal;
  vault: DashboardVault;
}
export const getDashboard = (userId: string) =>
  req<DashboardResponse>(`/api/dashboard?user=${encodeURIComponent(userId)}`);
