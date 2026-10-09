import React from 'react';
import {
  ApiError,
  clean,
  getDeviceId,
  getModels,
  loadModel,
  postChat,
  postChatStream,
  saveModel,
  shortBlob,
  walruscan,
} from './api';
import type { Budget, ChatResponse, RecalledMeta, ThinkStep } from './api';
import type { ChatMsg, ChatSession } from './chat';
import { msgId } from './chat';
import { Alert, Badge, Button, IconShield, Spinner, cn } from './ui';
import './ChatView.css';

export interface ChatViewProps {
  userId: string;
  memoryOn: boolean;
  sessions: ChatSession[];
  active: ChatSession | null;
  selectSession: (id: string) => void;
  newSession: () => string;
  pushMsg: (sessionId: string, msg: ChatMsg, ns: string) => void;
  onSwitchUser?: (userId: string) => void;
  onSignIn?: () => void;
  onMode?: (mode: 'local' | 'mainnet') => void;
}

const MAX_LEN = 500;

// Clean display names for model ids (e.g. google/gemma-4-31b-it:free -> Gemma 4 31B).
export function prettyModel(id: string): string {
  if (id === 'openrouter/free') return 'Auto';
  const base = id.split('/').pop() ?? id;
  const parts = base.replace(/:free$/i, '').split('-').filter((p) => !/^(it|free|preview)$/i.test(p));
  const words = parts.map((p) => {
    const low = p.toLowerCase();
    const alias: Record<string, string> = { gemma: 'Gemma', nemotron: 'Nemotron', ling: 'Ling', apodex: 'Apodex', dots: 'Dots', liquid: 'Liquid', lfm: 'LFM', thinkingmachines: 'Thinking Machines', inkling: 'Inkling', poolside: 'Poolside', laguna: 'Laguna', cohere: 'Cohere', north: 'North', nvidia: 'Nvidia', google: 'Google', qwen: 'Qwen', deepseek: 'DeepSeek', meta: 'Meta', mistral: 'Mistral', xiaomi: 'Xiaomi', minimax: 'MiniMax', tng: 'TNG', arcee: 'Arcee', zhipu: 'Zhipu', glm: 'GLM' };
    if (/^[a-z]*\d[\w.]*$/i.test(p) && /[a-z]/i.test(p)) return p.toUpperCase();
    if (/^[vV]?\d/.test(p)) return p.toUpperCase();
    return alias[low] ?? p.charAt(0).toUpperCase() + p.slice(1);
  });
  return words.join(' ').replace(/\s+/g, ' ').trim() || id;
}

const SUGGESTIONS = [
  'My mom is allergic to penicillin',
  'She takes metformin at 8am every day',
  'What do you remember about her?',
  'Is ibuprofen okay with her medications?',
];

// One-click discovery for the premade demo memory (demo-mom ships seeded, so
// the greeting offers reads, not teaches).
const DEMO_USERS = new Set(['demo-mom', 'demo-day7', 'demo-day1']);
const DEMO_SUGGESTIONS = [
  'What do you remember about her?',
  'What medications does she take?',
  'What is she allergic to?',
  'When are dinner and bedtime?',
];

// "3h 12m" countdown from an ISO resetAt; falls back to whole hours.
export function formatResetIn(resetAt: string | null, resetInHrs?: number | null): string | null {
  if (resetAt) {
    const ms = Date.parse(resetAt) - Date.now();
    if (Number.isFinite(ms) && ms > 0) {
      const totalMin = Math.ceil(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    }
  }
  if (typeof resetInHrs === 'number' && Number.isFinite(resetInHrs) && resetInHrs > 0) {
    return `${Math.ceil(resetInHrs)}h`;
  }
  return null;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

function AssistantBody({ msg, mode }: { msg: ChatMsg; mode: 'local' | 'mainnet' | null }) {
  const text = clean(msg.text);
  if (text.startsWith('STOP')) {
    const blob = msg.savedBlob ?? msg.recalled?.[0]?.blob_id ?? null;
    const short = shortBlob(blob);
    const link = walruscan(blob);
    return (
      <Alert variant="danger" className="asst-alert">
        <p className="asst-alert-title">
          <IconShield /> STOP — possible safety conflict
        </p>
        <p className="asst-text">{text}</p>
        {short ? (
          <p className="cite">
            Source blob <span className="mono">{short}</span>
            {link && mode === 'mainnet' ? (
              <>
                {' · '}<a href={link} target="_blank" rel="noreferrer">walruscan</a>
              </>
            ) : null}
            {' · '}<a href="#/proof">guard proof</a>
          </p>
        ) : (
          <p className="cite"><a href="#/proof">guard proof</a></p>
        )}
      </Alert>
    );
  }
  if (text.startsWith('CAUTION')) {
    const blob = msg.savedBlob ?? msg.recalled?.[0]?.blob_id ?? null;
    const short = shortBlob(blob);
    const link = walruscan(blob);
    return (
      <Alert variant="warn" className="asst-alert">
        <p className="asst-alert-title">
          <IconShield /> Caution — check before acting
        </p>
        <p className="asst-text">{text}</p>
        {short ? (
          <p className="cite">
            Source blob <span className="mono">{short}</span>
            {link && mode === 'mainnet' ? (
              <>
                {' · '}<a href={link} target="_blank" rel="noreferrer">walruscan</a>
              </>
            ) : null}
            {' · '}<a href="#/proof">guard proof</a>
          </p>
        ) : (
          <p className="cite"><a href="#/proof">guard proof</a></p>
        )}
      </Alert>
    );
  }
  return <p className="asst-text">{text}</p>;
}

function guardFired(m: ChatMsg): boolean {
  return m.text.startsWith('STOP') || m.text.startsWith('CAUTION');
}

export default function ChatView(props: ChatViewProps) {
  const { userId, memoryOn, active } = props;
  const [models, setModels] = React.useState<string[]>([]);
  const [model, setModel] = React.useState<string>(() => loadModel() ?? '');
  React.useEffect(() => {
    let live = true;
    void getModels()
      .then((r) => {
        if (!live) return;
        const ids = r.models.map((m) => m.id);
        setModels(ids);
        const saved = loadModel();
        if ((!saved || !ids.includes(saved)) && r.default) {
          setModel(r.default);
          saveModel(r.default);
        }
      })
      .catch(() => {
        if (live) setModels(['google/gemma-4-31b-it:free']);
      });
    return () => {
      live = false;
    };
  }, []);
  const [input, setInput] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [needLogin, setNeedLogin] = React.useState<string | null>(null);
  // Which gate raised the sign-in prompt: 429 = over budget, 401 = personal
  // chat needs a session. The card title differs; the actions are the same.
  const [needLoginStatus, setNeedLoginStatus] = React.useState<number | null>(null);
  const [needRelink, setNeedRelink] = React.useState<string | null>(null);
  // Signed-in but vault not linked (SPEC §4/B): the server 409s without a
  // needsRelink flag (no dead key, just no vault row). Offer vault setup
  // instead of a dead-end error — never a "sign in" nag while signed in.
  const [needVault, setNeedVault] = React.useState<string | null>(null);
  const [lastFailed, setLastFailed] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'local' | 'mainnet' | null>(null);
  // Rolling chat budget from the last reply (subtle note only when low) and
  // the 429 reset countdown (resetAt ISO + whole-hour fallback).
  const [budget, setBudget] = React.useState<Budget | null>(null);
  const [limitReset, setLimitReset] = React.useState<{ resetAt: string | null; resetInHrs: number | null } | null>(null);
  // Live stream state: rendered as a provisional assistant row while pending.
  // The final message is pushed from the `done` payload, so localStorage only
  // ever holds completed turns (key `ddChats:<userId>` untouched otherwise).
  const [streamText, setStreamText] = React.useState('');
  const [streamThinking, setStreamThinking] = React.useState<ThinkStep[]>([]);
  const [streamRecalled, setStreamRecalled] = React.useState<RecalledMeta[]>([]);
  const hasStream = streamText.length > 0 || streamThinking.length > 0;
  const listRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);
  // Guest identity: ensure the persisted device id exists before the first
  // turn (req() sends it as X-Device-Id for the per-browser guest budget).
  React.useEffect(() => {
    try { getDeviceId(); } catch { /* server falls back to 'anon' */ }
  }, []);

  const msgs = active?.msgs ?? [];
  void props.sessions;
  void props.selectSession;

  React.useEffect(() => {
    setError(null);
    setLastFailed(null);
    setBudget(null);
    setLimitReset(null);
    setNeedVault(null);
    setInput('');
  }, [active?.id, userId]);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [msgs.length, pending, streamText, streamThinking.length]);

  const autogrow = React.useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  React.useEffect(autogrow, [input, autogrow]);

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || pending) return;
    // Pin the persistence namespace for this whole send: the user turn and
    // the assistant turn below must land under the same `ddChats:<ns>` key
    // even if the wallet session resolves mid-stream and App's chatUser flips.
    const ns = userId;
    let sid = active?.id;
    if (!sid) sid = props.newSession();
    const target = sid;
    const userMsg: ChatMsg = { id: msgId(), role: 'user', text: text.slice(0, MAX_LEN), ts: Date.now() };
    props.pushMsg(target, userMsg, ns);
    setInput('');
    setPending(true);
    setError(null);
    setStreamText('');
    setStreamThinking([]);
    setStreamRecalled([]);
    // True once at least one live token rendered: a failure after this point
    // is a mid-stream cut (the turn may already be saved server-side), while
    // a failure before it falls back to the non-stream endpoint.
    let gotTokens = false;
    try {
      let res: ChatResponse | null = null;
      try {
        res = await postChatStream(userId, text, memoryOn, model || undefined, (ev) => {
          if (ev.type === 'thinking') {
            setStreamThinking(ev.thinking);
            setStreamRecalled(ev.recalledMeta);
          } else if (ev.type === 'token') {
            gotTokens = true;
            const t = ev.token;
            setStreamText((prev) => prev + t);
          }
        });
      } catch (se) {
        if (gotTokens) throw se;
        res = await postChat(userId, text, memoryOn, model || undefined);
      }
      const finalRes = res as ChatResponse;
      const asst: ChatMsg = {
        id: msgId(),
        role: 'assistant',
        text: finalRes.reply,
        savedBlob: finalRes.savedBlob,
        memoryPersisted: finalRes.memoryPersisted,
        recalled: (finalRes.recalledMeta ?? []).map((m) => ({ text: m.text, blob_id: m.blob_id })),
        thinking: finalRes.thinking ?? [],
        ts: Date.now(),
      };
      props.pushMsg(target, asst, ns);
      setMode(finalRes.mode);
      props.onMode?.(finalRes.mode);
      setBudget(finalRes.budget ?? null);
      setLimitReset(null);
      setNeedLogin(null);
      setNeedVault(null);
      setLastFailed(null);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg = e instanceof Error ? e.message : 'request failed';
      setLastFailed(text);
      const data = e instanceof ApiError ? (e.data as Record<string, unknown>) : {};
      // Both gates carry loginRequired: 429 over-budget and 401 personal-chat
      // without a session (signed-out custom id, expired session). Either way
      // the fix is sign in or use the demo — never a bare Retry loop.
      const loginGate = e instanceof ApiError
        && (e.status === 429 || e.status === 401)
        && data?.loginRequired === true;
      setNeedLogin(loginGate ? msg : null);
      setNeedLoginStatus(loginGate ? status : null);
      setLimitReset(e instanceof ApiError && e.status === 429
        ? {
          resetAt: typeof data?.resetAt === 'string' ? (data.resetAt as string) : null,
          resetInHrs: typeof data?.resetInHrs === 'number' ? (data.resetInHrs as number) : null,
        }
        : null);
      setNeedRelink(e instanceof ApiError && e.status === 409 && (e as ApiError).data?.needsRelink === true ? msg : null);
      setNeedVault(e instanceof ApiError && e.status === 409 && (e as ApiError).data?.needsRelink !== true ? msg : null);
      const cleanMsg = msg.replace(/[.\u2026\s]+$/, '');
      if (gotTokens) {
        // Mid-stream cut: the turn may already be saved server-side, so this
        // message stands alone — it must NOT also claim nothing was saved.
        setError(`The answer stopped mid-stream: ${cleanMsg}. It may have been saved — check Memory before resending.`);
      } else {
        const notSaved = 'Nothing was saved for this turn — you can retry safely.';
        setError(status === 503
          ? `Server is degraded right now: ${cleanMsg}. Your message was not answered. ${notSaved}`
          : `Send failed${status ? ` (${status})` : ''}: ${cleanMsg}. ${notSaved}`);
      }
    } finally {
      setPending(false);
      setStreamText('');
      setStreamThinking([]);
      setStreamRecalled([]);
    }
  }

  function retry() {
    if (lastFailed && !pending) void send(lastFailed);
  }

  const empty = msgs.length === 0;
  const isDemo = DEMO_USERS.has(userId);
  // Provisional streaming message: verdict-first on a guard fire (never bury
  // a STOP), reasoning first otherwise — same order as completed turns.
  const streamMsg: ChatMsg = {
    id: 'streaming',
    role: 'assistant',
    text: streamText,
    thinking: streamThinking,
    recalled: streamRecalled.map((m) => ({ text: m.text, blob_id: m.blob_id })),
    ts: Date.now(),
  };
  const streamGuard = guardFired(streamMsg);  const suggestions = isDemo ? DEMO_SUGGESTIONS : SUGGESTIONS;
  const lowBudget = budget && budget.remaining <= 3 && budget.remaining >= 1 ? budget : null;
  const lowCountdown = lowBudget?.remaining === 1 ? formatResetIn(lowBudget.resetAt) : null;

  return (
    <div className="chat">
      {!memoryOn ? (
        <Alert variant="warn" className="chat-memoff">
          Memory is off — I will answer without saving or recalling. Turn memory on to keep facts for {userId}.
        </Alert>
      ) : null}
      {isDemo ? (
        <p className="demo-strip" role="note">
          Shared demo · read-only — nothing you type here is saved. Your own chats live under Chat.
        </p>
      ) : null}
      <div className="chat-list" ref={listRef} role="log" aria-label="Conversation" aria-live="polite">
        {empty ? (
          <div className="greet">
            <Badge variant={memoryOn ? 'ok' : 'warn'}>{memoryOn ? 'Memory on' : 'Memory off'} · {userId}</Badge>
            <h2>{isDemo ? 'Try a memory that already exists' : 'What can I remember for you today?'}</h2>
            <p className="greet-sub">
              {isDemo ? (
                <>This demo opens on a saved profile — ask what she takes, what she avoids, or when dinner is. One click, no setup.</>
              ) : (
                <>Tell me once — medications, allergies, routines — and I will keep it for {userId}. Ask anything; safety checks run before every answer.</>
              )}
            </p>
            <div className="chips">
              {!isDemo ? (
                <button type="button" className="chip chip-demo" onClick={() => props.onSwitchUser?.('demo-mom')}>
                  Explore the demo — no setup
                </button>
              ) : null}
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="chip"
                  disabled={pending}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            {isDemo ? (
              <div className="demo-feats" aria-label="Demo walkthrough">
                <p className="demo-feats-h">Demo walkthrough — try in order</p>
                <ol>
                  <li>Ask what she is allergic to — the answer cites a saved blob.</li>
                  <li>Ask if ibuprofen is okay — watch it STOP before answering.</li>
                  <li>Open <a href="#/proof">Guard proof</a> — every STOP is verifiable there.</li>
                </ol>
                <p className="demo-feats-note">Shared demo is read-only: your turns are never saved here. Teach in Chat to keep your own memory.</p>
              </div>
            ) : null}
          </div>
        ) : (
          msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="row row-user">
                <div className="bubble">{clean(m.text)}</div>
              </div>
            ) : (
              <div key={m.id} className="row row-asst">
                <div className="asst-card">
                  {/* Claude order: verdict first on a guard fire (never bury a
                      STOP), reasoning first otherwise — thinking before text. */}
                  {guardFired(m) ? <AssistantBody msg={m} mode={mode} /> : null}
                  {m.thinking && m.thinking.length > 0 ? (
                    <details
                      className="think"
                      open={guardFired(m) || undefined}
                    >
                      <summary>How I decided ({m.thinking.length} steps)</summary>
                      <ol>
                        {m.thinking.map((t, i) => (
                          <li key={i} style={{ '--i': i } as React.CSSProperties}>
                            <strong>{t.label}.</strong> <span>{t.detail}</span>
                          </li>
                        ))}
                      </ol>
                      {m.recalled && m.recalled.length > 0 ? (
                        <>
                          <p className="cite">Sources ({m.recalled.length})</p>
                          <ul className="src">
                            {m.recalled.map((r, i) => (
                              <li key={i}>
                                <span>{clean(r.text)}</span>
                                {r.blob_id ? (
                                  <span className="mono cite"> · blob {shortBlob(r.blob_id) ?? r.blob_id}</span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </details>
                  ) : null}
                  {guardFired(m) ? null : <AssistantBody msg={m} mode={mode} />}
                  <p className={cn('saved', m.savedBlob ? 'saved-yes' : 'saved-no')}>
                    {m.savedBlob
                      ? `Saved to memory · blob ${shortBlob(m.savedBlob) ?? m.savedBlob}`
                      : m.memoryPersisted === 'pending'
                        ? 'Saving to memory…'
                        : m.memoryPersisted === false || !memoryOn
                          ? 'Not saved — memory off or nothing new to store'
                          : 'Not saved — nothing new to store'}
                  </p>
                </div>
              </div>
            ),
          )
        )}
        {pending && hasStream ? (
          <div className="row row-asst">
            <div className="asst-card streaming" aria-live="polite">
              {streamGuard ? <AssistantBody msg={streamMsg} mode={mode} /> : null}
              {streamThinking.length > 0 ? (
                <details
                  className="think think-live"
                  open={streamGuard || undefined}
                >
                  <summary>How I decided ({streamThinking.length} steps)</summary>
                  <ol>
                    {streamThinking.map((t, i) => (
                      <li key={i} style={{ '--i': i } as React.CSSProperties}>
                        <strong>{t.label}.</strong> <span>{t.detail}</span>
                      </li>
                    ))}
                  </ol>
                  {streamRecalled.length > 0 ? (
                    <>
                      <p className="cite">Sources ({streamRecalled.length})</p>
                      <ul className="src">
                        {streamRecalled.map((r, i) => (
                          <li key={i}>
                            <span>{clean(r.text)}</span>
                            {r.blob_id ? (
                              <span className="mono cite"> · blob {shortBlob(r.blob_id) ?? r.blob_id}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </details>
              ) : null}
              {streamGuard ? (
                <span className="caret" aria-hidden="true" />
              ) : streamText ? (
                <p className="asst-text">{clean(streamText)}<span className="caret" aria-hidden="true" /></p>
              ) : (
                <p className="asst-text streaming-wait"><Spinner /> Thinking…</p>
              )}
            </div>
          </div>
        ) : pending ? (
          <div className="row row-asst">
            <div className="asst-card typing"><Spinner /> Thinking…</div>
          </div>
        ) : null}
      </div>

      {needLogin ? (
        <Alert variant="warn" className="send-error" role="alert">
          <span><strong>{needLoginStatus === 401 ? 'Sign-in needed.' : 'Message limit reached.'}</strong> {needLogin}{(() => {
            const cd = formatResetIn(limitReset?.resetAt ?? null, limitReset?.resetInHrs ?? null);
            return cd ? ` Resets in ${cd}.` : '';
          })()}</span>
          <span className="btn-row">
            <Button size="sm" variant="primary" onClick={() => { setNeedLogin(null); setNeedLoginStatus(null); setLimitReset(null); if (props.onSignIn) props.onSignIn(); else window.location.hash = '#/wallet'; }}>Sign in</Button>
            <Button size="sm" onClick={() => { setNeedLogin(null); setNeedLoginStatus(null); setLimitReset(null); props.onSwitchUser?.('demo-mom'); }}>Explore the demo</Button>
          </span>
        </Alert>
      ) : null}
      {needRelink ? (
        <Alert variant="warn" className="send-error" role="alert">
          <span><strong>Vault link broken.</strong> {needRelink}</span>
          <span className="btn-row">
            <Button size="sm" variant="primary" onClick={() => { setNeedRelink(null); window.location.hash = '#/wallet'; }}>Re-link wallet</Button>
          </span>
        </Alert>
      ) : null}
      {needVault ? (
        <Alert variant="warn" className="send-error" role="alert">
          <span><strong>Vault setup needed.</strong> {needVault}</span>
          <span className="btn-row">
            <Button size="sm" variant="primary" onClick={() => { setNeedVault(null); window.location.hash = '#/wallet'; }}>Set up vault</Button>
          </span>
        </Alert>
      ) : null}
      {error && !needLogin && !needRelink && !needVault ? (
        <Alert variant="danger" className="send-error">
          <span>{error}</span>
          {lastFailed ? (
            <Button size="sm" onClick={retry} disabled={pending}>{pending ? 'Retrying…' : 'Retry'}</Button>
          ) : null}
        </Alert>
      ) : null}

      <p className="disclaimer">Confirm with your doctor — this is not medical advice. Safety checks run before every answer.</p>
      {lowBudget ? (
        <p className="budget-note" role="status">
          {lowBudget.remaining === 1
            ? `Last message${lowCountdown ? ` — limit resets in ${lowCountdown}` : ''}`
            : `${lowBudget.remaining} messages left`}
        </p>
      ) : null}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={boxRef}
          rows={1}
          maxLength={MAX_LEN}
          value={input}
          disabled={pending}
          placeholder={memoryOn ? 'Message Mediara…' : 'Message Mediara… (memory off)'}
          aria-label="Message"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="composer-bar">
          <label className="model-pick">
            <span className="sr-only">Answer model</span>
            <select
              value={model}
              onChange={(e) => { setModel(e.target.value); saveModel(e.target.value); }}
              aria-label="Answer model"
              title="Answer model"
            >
              {models.length === 0 ? <option value="">Loading…</option> : null}
              {models.map((m) => (
                <option key={m} value={m}>{prettyModel(m)}</option>
              ))}
            </select>
          </label>
          <span className="count" aria-label={`${input.length} of ${MAX_LEN} characters`}>
            {input.length}/{MAX_LEN}
          </span>
          <Button
            type="submit"
            variant="primary"
            size="icon"
            disabled={pending || input.trim().length === 0}
            aria-label="Send"
          >
            {pending ? <Spinner /> : <SendGlyph />}
          </Button>
        </div>
      </form>
    </div>
  );
}

function SendGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
    </svg>
  );
}
