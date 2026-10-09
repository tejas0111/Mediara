/* Shared chat domain types + small format helpers. */

export interface ThinkStep {
  step: string;
  /** Wire alias: the server emits `label`; the client accepts both. */
  label?: string;
  detail?: string;
  ok?: boolean;
  ms?: number;
}

export interface RecalledItem {
  text: string;
  blobId?: string | null;
  distance?: number;
}

export interface Budget {
  used: number;
  cap: number;
  remaining: number;
  resetAt?: string;
  resetInHrs?: number;
}

export interface GuardCite {
  text: string;
  blobId?: string | null;
}

export type Verdict = 'STOP' | 'CAUTION';

export interface GuardInfo {
  verdict?: string;
  reason?: string;
  cited?: GuardCite[];
  proofId?: string;
}

export interface ChatResponse {
  reply: string;
  recalledMeta?: RecalledItem[];
  thinking?: ThinkStep[];
  savedBlob?: string | null;
  memoryPersisted?: boolean;
  budget?: Budget;
  mode?: string;
  disclaimer?: string;
  guard?: GuardInfo | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  thinking: ThinkStep[];
  recalled: RecalledItem[];
  verdict?: Verdict;
  guardReason?: string;
  cited?: GuardCite[];
  savedBlob?: string | null;
  memoryPersisted?: boolean;
  budget?: Budget;
  streaming?: boolean;
  error?: boolean;
}

/** Truncate a Walrus blob id for display: keep both ends, elide the middle. */
export function shortBlob(blob?: string | null): string {
  if (!blob) return '—';
  if (blob.length <= 14) return blob;
  return `${blob.slice(0, 6)}…${blob.slice(-4)}`;
}

/** "2h 5m" style countdown text for budget resets. */
export function formatResetIn(
  resetAt?: string,
  resetInHrs?: number,
  now: number = Date.now(),
): string {
  let ms = 0;
  if (resetAt) {
    const t = Date.parse(resetAt);
    if (!Number.isNaN(t)) ms = t - now;
  } else if (typeof resetInHrs === 'number' && Number.isFinite(resetInHrs)) {
    ms = resetInHrs * 3_600_000;
  }
  if (ms <= 0) return '0m';
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Map a wire response onto a renderable assistant message. */
export function toAssistantMessage(res: ChatResponse): ChatMessage {
  let verdict: Verdict | undefined;
  const g = res.guard ?? undefined;
  if (g?.verdict === 'STOP' || /^STOP\b/.test(res.reply)) verdict = 'STOP';
  else if (g?.verdict === 'CAUTION' || /^CAUTION\b/.test(res.reply)) verdict = 'CAUTION';
  const text = res.reply.replace(/^(STOP|CAUTION)\s*[—–-]\s*/, '');
  return {
    role: 'assistant',
    text,
    thinking: res.thinking ?? [],
    recalled: res.recalledMeta ?? [],
    verdict,
    guardReason: g?.reason,
    cited: g?.cited ?? [],
    savedBlob: res.savedBlob ?? null,
    memoryPersisted: res.memoryPersisted,
    budget: res.budget,
  };
}
