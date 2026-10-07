import React from 'react';
import {
  ApiError,
  clean,
  getDeviceId,
  getModels,
  loadModel,
  postChat,
  saveModel,
  shortBlob,
  walruscan,
} from './api';
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
  pushMsg: (sessionId: string, msg: ChatMsg) => void;
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
  const [lastFailed, setLastFailed] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'local' | 'mainnet' | null>(null);
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
    setInput('');
  }, [active?.id, userId]);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [msgs.length, pending]);

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
    let sid = active?.id;
    if (!sid) sid = props.newSession();
    const target = sid;
    const userMsg: ChatMsg = { id: msgId(), role: 'user', text: text.slice(0, MAX_LEN), ts: Date.now() };
    props.pushMsg(target, userMsg);
    setInput('');
    setPending(true);
    setError(null);
    try {
      const res = await postChat(userId, text, memoryOn, model || undefined);
      const asst: ChatMsg = {
        id: msgId(),
        role: 'assistant',
        text: res.reply,
        savedBlob: res.savedBlob,
        memoryPersisted: res.memoryPersisted,
        recalled: (res.recalledMeta ?? []).map((m) => ({ text: m.text, blob_id: m.blob_id })),
        thinking: res.thinking ?? [],
        ts: Date.now(),
      };
      props.pushMsg(target, asst);
      setMode(res.mode);
      props.onMode?.(res.mode);
      setLastFailed(null);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg = e instanceof Error ? e.message : 'request failed';
      setLastFailed(text);
      setNeedLogin(e instanceof ApiError && e.status === 429 && (e as ApiError).data?.loginRequired === true ? msg : null);
      const cleanMsg = msg.replace(/[.\u2026\s]+$/, '');
      setError(status === 503
        ? `Server is degraded right now: ${cleanMsg}. Your message was not answered.`
        : `Send failed${status ? ` (${status})` : ''}: ${cleanMsg}`);
    } finally {
      setPending(false);
    }
  }

  function retry() {
    if (lastFailed && !pending) void send(lastFailed);
  }

  const empty = msgs.length === 0;

  return (
    <div className="chat">
      {!memoryOn ? (
        <Alert variant="warn" className="chat-memoff">
          Memory is off — I will answer without saving or recalling. Turn memory on to keep facts for {userId}.
        </Alert>
      ) : null}
      <div className="chat-list" ref={listRef} role="log" aria-label="Conversation" aria-live="polite">
        {empty ? (
          <div className="greet">
            <Badge variant={memoryOn ? 'ok' : 'warn'}>{memoryOn ? 'Memory on' : 'Memory off'} · {userId}</Badge>
            <h2>What can I remember for you today?</h2>
            <p className="greet-sub">
              Tell me once — medications, allergies, routines — and I will keep it for {userId}.
              Ask anything; safety checks run before every answer.
            </p>
            <div className="chips">
              <button type="button" className="chip chip-demo" onClick={() => props.onSwitchUser?.('demo-mom')}>
                Explore the demo — no setup
              </button>
              {SUGGESTIONS.map((s) => (
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
                  <AssistantBody msg={m} mode={mode} />
                  {m.thinking && m.thinking.length > 0 ? (
                    <details className="think">
                      <summary>How I decided ({m.thinking.length} steps)</summary>
                      <ol>
                        {m.thinking.map((t, i) => (
                          <li key={i}>
                            <strong>{t.label}.</strong> <span>{t.detail}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {m.recalled && m.recalled.length > 0 ? (
                    <details className="recalled">
                      <summary>Recalled sources ({m.recalled.length})</summary>
                      <ul>
                        {m.recalled.map((r, i) => (
                          <li key={i}>
                            <span>{clean(r.text)}</span>
                            {r.blob_id ? (
                              <span className="mono cite"> · blob {shortBlob(r.blob_id) ?? r.blob_id}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
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
        {pending ? (
          <div className="row row-asst">
            <div className="asst-card typing"><Spinner /> Thinking…</div>
          </div>
        ) : null}
      </div>

      {needLogin ? (
        <Alert variant="warn" className="send-error" role="alert">
          <span><strong>Demo budget used up.</strong> {needLogin} Or keep exploring the premade demo, no teaching needed.</span>
          <span className="btn-row">
            <Button size="sm" variant="primary" onClick={() => { setNeedLogin(null); if (props.onSignIn) props.onSignIn(); else window.location.hash = '#/wallet'; }}>Sign in</Button>
            <Button size="sm" onClick={() => { setNeedLogin(null); props.onSwitchUser?.('demo-mom'); }}>Explore the demo</Button>
          </span>
        </Alert>
      ) : null}
      {error && !needLogin ? (
        <Alert variant="danger" className="send-error">
          <span>{error} Nothing was saved for this turn — you can retry safely.</span>
          {lastFailed ? (
            <Button size="sm" onClick={retry} disabled={pending}>{pending ? 'Retrying…' : 'Retry'}</Button>
          ) : null}
        </Alert>
      ) : null}

      <p className="disclaimer">Confirm with your doctor — this is not medical advice. Safety checks run before every answer.</p>

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
