import React from 'react';
import {
  ApiError,
  clean,
  postChat,
  shortBlob,
  walruscan,
} from './api';
import type { ChatMsg, ChatSession } from './chat';
import { msgId } from './chat';
import { Alert, Button, IconShield, Spinner, cn } from './ui';
import './ChatView.css';

export interface ChatViewProps {
  userId: string;
  memoryOn: boolean;
  sessions: ChatSession[];
  active: ChatSession | null;
  selectSession: (id: string) => void;
  newSession: () => string;
  pushMsg: (sessionId: string, msg: ChatMsg) => void;
  onMode?: (mode: 'local' | 'mainnet') => void;
}

const MAX_LEN = 500;

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
  const text = msg.text;
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
    return (
      <Alert variant="warn" className="asst-alert">
        <p className="asst-alert-title">
          <IconShield /> Caution
        </p>
        <p className="asst-text">{text}</p>
      </Alert>
    );
  }
  return <p className="asst-text">{text}</p>;
}

export default function ChatView(props: ChatViewProps) {
  const { userId, memoryOn, active } = props;
  const [input, setInput] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastFailed, setLastFailed] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'local' | 'mainnet' | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);

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
      const res = await postChat(userId, text, memoryOn);
      const asst: ChatMsg = {
        id: msgId(),
        role: 'assistant',
        text: res.reply,
        savedBlob: res.savedBlob,
        memoryPersisted: res.memoryPersisted,
        recalled: (res.recalledMeta ?? []).map((m) => ({ text: m.text, blob_id: m.blob_id })),
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
      setError(status === 503
        ? `Server is degraded right now (503): ${msg}. Your message was not answered — nothing was saved for this turn.`
        : `Send failed${status ? ` (${status})` : ''}: ${msg}`);
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
      <div className="chat-list" ref={listRef} role="log" aria-label="Conversation" aria-live="polite">
        {empty ? (
          <div className="greet">
            <h2>What can I remember for you today?</h2>
            <p className="greet-sub">
              Tell me once — medications, allergies, routines — and I will keep it for {userId}.
            </p>
            <div className="chips">
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
                <div className="bubble">{m.text}</div>
              </div>
            ) : (
              <div key={m.id} className="row row-asst">
                <div className="asst-card">
                  <AssistantBody msg={m} mode={mode} />
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
                      ? `Saved · blob ${shortBlob(m.savedBlob) ?? m.savedBlob}`
                      : m.memoryPersisted === false || !memoryOn
                        ? 'Not saved'
                        : 'Not saved'}
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

      {error ? (
        <Alert variant="danger" className="send-error">
          <span>{error}</span>
          {lastFailed ? (
            <Button size="sm" onClick={retry} disabled={pending}>Retry</Button>
          ) : null}
        </Alert>
      ) : null}

      <p className="disclaimer">Confirm with your doctor — this is not medical advice.</p>

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
          placeholder={memoryOn ? 'Message DoseDaughter…' : 'Message DoseDaughter… (memory off)'}
          aria-label="Message"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="composer-side">
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
