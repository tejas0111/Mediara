// Typed client for the DoseDaughter JSON API. Same-origin; session cookies ride
// along automatically. Every function throws ApiError (with .status) on failure
// so views can render honest error states instead of silent blanks.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, String((body as { error?: unknown }).error || `request failed (${r.status})`));
  return body as T;
}

/** Strip the stored "User <id>:" label prefix for display. */
export const clean = (t: string) =>
  String(t ?? '').replace(/^User\s+\S+:\s*/i, '');

/** Short blob id for receipts: local-ids in full-ish, mainnet truncated. */
export const shortBlob = (id: string | null) => {
  if (!id) return null;
  return id.startsWith('local-') ? id : `${id.slice(0, 10)}…`;
};

export const walruscan = (id: string | null) =>
  id && id.length >= 32 && !id.startsWith('local-')
    ? `https://walruscan.com/mainnet/blob/${id}`
    : null;

// ---------------------------------------------------------------- chat ---
export interface RecalledMeta {
  text: string;
  blob_id: string | null;
  distance: number | null;
}
export interface ChatResponse {
  reply: string;
  recalled: string[];
  recalledMeta: RecalledMeta[];
  memoryScope: string;
  identity: string;
  savedBlob: string | null;
  memoryPersisted: boolean | null;
  memoryOff: boolean;
  mode: 'local' | 'mainnet';
  disclaimer: string;
}
export const postChat = (userId: string, message: string, memory: boolean) =>
  req<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ userId, message, memory: memory ? true : 'off' }),
  });

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
