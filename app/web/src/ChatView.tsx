import {
  CSSProperties,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ApiError,
  chat,
  chatStream,
  getProvider,
  getSavedModel,
  ModelInfo,
  models,
  prettyModel,
  saveModel,
} from './api';
import {
  ChatMessage,
  RecalledItem,
  ThinkStep,
  formatResetIn,
  shortBlob,
  toAssistantMessage,
} from './chat';
import { Button, CheckIcon, ExternalIcon, PenIcon, ScopeBadge, SearchIcon, SendIcon, ShieldIcon, SparkIcon, WarnIcon } from './ui';
import './ChatView.css';

export interface ChatViewProps {
  userId: string;
  sessionId?: string;
  demo?: boolean;
  memoryOn: boolean;
  mainnet: boolean;
  signedIn?: boolean;
  // Rendered turns, owned by App per send-time namespace (never split by a
  // mid-stream wallet flip). The provisional streaming row stays local.
  messages: ChatMessage[];
  pushMsg: (sessionId: string, msg: ChatMessage, ns: string) => void;
  newSession: () => string;
  onSwitchUser?: (user: string) => void;
  onOpenWallet?: () => void;
  onOpenProvider?: () => void;
  onActivity?: (sessionId: string, title: string) => void;
}

const TEACH_CHIPS = [
  'Mom takes Metformin 500mg at 8pm after food',
  'Mom is allergic to ibuprofen',
  'She walks every morning at 7am before breakfast',
  'Her cardiologist is Dr. Rao — 555-0134',
];

const DEMO_WALKTHROUGH = [
  'What is she allergic to?',
  'Can she take ibuprofen for her headache?',
  'What medications does she take?',
  'What does her evening routine look like?',
];

/* Judge-grade thinking timeline: one slim row per server thinking step.
   Visible prose comes ONLY from server-sent thinking[].detail strings
   (m.thinking) — raw words, never "Step N" labels or step counts. Memory
   operations are unmissable: recall rows lead with the recalled-fact count
   (from m.recalled) and carry the Sources beneath; saved-write rows lead
   green with the blob chip; skipped writes stay faint with the server's
   own not-saved reason. Blob ids inside prose become mono chips with a
   walruscan link on mainnet. Content is strictly server-derived. */
type TraceKind = 'recall' | 'guard' | 'research' | 'write' | 'answer';

function traceKind(label: string): TraceKind {
  const l = label.toLowerCase();
  if (l.includes('recall')) return 'recall';
  if (l.includes('research') || l.includes('web')) return 'research';
  if (
    l.includes('guard') ||
    l.includes('allergy') ||
    l.includes('interaction')
  ) {
    return 'guard';
  }
  if (l.includes('memory') || l.includes('write') || l.includes('stor')) {
    return 'write';
  }
  return 'answer';
}

const BLOB_RE = /blob\s+([A-Za-z0-9][A-Za-z0-9_-]{4,})/g;

function blobIdsIn(text: string): string[] {
  const out: string[] = [];
  BLOB_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOB_RE.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/* Raw server detail with blob ids upgraded to chips — every word stays. */
function RichDetail({ detail, mainnet }: { detail: string; mainnet: boolean }) {
  const parts = useMemo(() => {
    const segs: { text?: string; blob?: string }[] = [];
    let last = 0;
    BLOB_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BLOB_RE.exec(detail))) {
      if (m.index > last) segs.push({ text: detail.slice(last, m.index) });
      segs.push({ blob: m[1] });
      last = m.index + m[0].length;
    }
    if (last < detail.length) segs.push({ text: detail.slice(last) });
    return segs;
  }, [detail]);
  return (
    <>
      {parts.map((p, i) =>
        p.blob ? (
          <span className="trace-chip" key={i}>
            blob <code className="blob" title={p.blob}>{shortBlob(p.blob)}</code>
            {mainnet && (
              <>
                {' · '}
                <a
                  href={`https://walruscan.com/blob/${p.blob}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  walruscan <ExternalIcon />
                </a>
              </>
            )}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function ThinkTrace({ m, mainnet }: { m: ChatMessage; mainnet: boolean }) {
  const n = m.recalled.length;
  const hasRecall = m.thinking.some((s) =>
    traceKind((s.label ?? s.step ?? '').trim()) === 'recall',
  );
  return (
    <>
      <ol className="trace">
        {m.thinking.map((s, i) => {
          const label = (s.label ?? s.step ?? '').trim() || 'Note';
          const detail = (s.detail ?? '').trim();
          const kind = traceKind(label);
          const saved = kind === 'write' && /saved to walrus/i.test(detail);
          const skipped = /^\s*skipped/i.test(detail);
          const chipId =
            blobIdsIn(detail)[0] ??
            (kind === 'write' ? (m.savedBlob ?? undefined) : undefined);
          return (
            <li
              key={i}
              className={`trace-row trace-${kind}${saved ? ' trace-saved' : ''}${skipped ? ' trace-skipped' : ''} step-in`}
              style={{ '--i': i } as CSSProperties}
            >
              <span className="trace-icon" aria-hidden="true">
                {kind === 'recall' ? (
                  <SearchIcon size={12} />
                ) : kind === 'research' ? (
                  <SparkIcon size={12} />
                ) : kind === 'guard' ? (
                  <ShieldIcon size={12} />
                ) : kind === 'write' ? (
                  saved ? (
                    <CheckIcon size={12} />
                  ) : (
                    <PenIcon size={12} />
                  )
                ) : (
                  <span className="trace-dot" />
                )}
              </span>
              <div className="trace-main">
                {kind === 'recall' && (
                  <div className="trace-lead">
                    Recalled {n} {n === 1 ? 'fact' : 'facts'} from Walrus memory
                  </div>
                )}
                {kind === 'write' && saved && chipId && (
                  <div className="trace-lead trace-lead-ok">
                    Stored to memory · blob{' '}
                    <code className="blob" title={chipId}>{shortBlob(chipId)}</code>
                    {mainnet && (
                      <>
                        {' · '}
                        <a
                          href={`https://walruscan.com/blob/${chipId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          walruscan <ExternalIcon />
                        </a>
                      </>
                    )}
                  </div>
                )}
                {detail && (
                  <p className="trace-text">
                    <RichDetail detail={detail} mainnet={mainnet} />
                  </p>
                )}
                {kind === 'recall' && <SourcesBlock m={m} />}
              </div>
            </li>
          );
        })}
      </ol>
      {!hasRecall && <SourcesBlock m={m} />}
    </>
  );
}

function SourcesBlock({ m }: { m: ChatMessage }) {
  if (m.recalled.length === 0) return null;
  return (
    <div className="sources">
      <div className="src-head">Sources ({m.recalled.length})</div>
      <ul>
        {m.recalled.map((r, ri) => (
          <li key={ri}>
            <span>{r.text}</span>
            {r.blobId && (
              <code className="blob">{shortBlob(r.blobId)}</code>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Message turns are owned by App (per send-time namespace); this view keeps
   only the provisional streaming row + transient error cards local. */

export default function ChatView(props: ChatViewProps) {
  const {
    userId,
    sessionId = '',
    demo = false,
    memoryOn,
    mainnet,
    signedIn = true,
    messages,
    onSwitchUser,
    onOpenWallet,
    onOpenProvider,
    onActivity,
  } = props;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<{
    text: string;
    thinking: ThinkStep[];
    recalled: RecalledItem[];
  } | null>(null);
  const [errorCard, setErrorCard] = useState<ChatMessage | null>(null);
  const [limitErr, setLimitErr] = useState<ApiError | null>(null);
  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const [modelsErr, setModelsErr] = useState(false);
  const [model, setModel] = useState(
    () => getSavedModel() || getProvider()?.model || '',
  );
  const [provTick, setProvTick] = useState(0);
  const userPicked = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastSent = useRef('');
  const titledFor = useRef('');

  /* ------------------------------------------------- reset on swap */
  /* The rendered turns come from props (App's per-namespace store), so a
     wallet flip mid-stream only swaps which stored turns show — the
     in-flight send below keeps writing under its pinned namespace. */
  useEffect(() => {
    titledFor.current = '';
    setLimitErr(null);
    setErrorCard(null);
    setStream(null);
  }, [sessionId, userId]);

  /* ------------------------------------------------------------- models */
  useEffect(() => {
    let live = true;
    models()
      .then((list) => {
        if (live) setModelList(list);
      })
      .catch(() => {
        if (live) setModelsErr(true);
      });
    return () => {
      live = false;
    };
  }, []);

  /* Custom provider (Account dialog): re-read on save/clear, prepend the
     custom model to the picker and select it unless explicitly picked. */
  useEffect(() => {
    const bump = () => setProvTick((t) => t + 1);
    window.addEventListener('ddprovider', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('ddprovider', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);

  const provider = useMemo(() => getProvider(), [provTick]);

  const displayList = useMemo<ModelInfo[]>(() => {
    if (!provider) return modelList;
    const rest = modelList.filter((m) => m.id !== provider.model);
    return [
      { id: provider.model, name: `${prettyModel(provider.model)} · custom` },
      ...rest,
    ];
  }, [modelList, provider]);

  useEffect(() => {
    if (provider && !userPicked.current && model !== provider.model) {
      setModel(provider.model);
    }
  }, [provider, model]);

  useEffect(() => {
    if (
      !provider &&
      model &&
      modelList.length > 0 &&
      !modelList.some((m) => m.id === model)
    ) {
      setModel('');
      saveModel('');
    }
  }, [provider, model, modelList]);

  /* ------------------------------------------------------ 429 countdown */
  useEffect(() => {
    if (!limitErr) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [limitErr]);

  /* --------------------------------------- autoscroll (pinned, instant) */
  /* The inner .chat-scroll column is the only scroller: while the user is
     pinned to the bottom, every streamed event snaps it down instantly
     (no smooth scrolling mid-stream). Scrolling up unpins; sending re-pins. */
  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, limitErr, stream]);

  /* --------------------------------------------------------- autogrow */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  /* -------------------------------------------------------------- send */
  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;
      lastSent.current = text;
      setLimitErr(null);
      setErrorCard(null);
      setInput('');
      setBusy(true);
      pinned.current = true;

      // Pin the persistence namespace for this whole send: the user turn and
      // the assistant turn below must land under the same key even if the
      // wallet session resolves mid-stream and App's chatUser flips.
      const ns = userId;
      let target = sessionId;
      if (!target) target = props.newSession();
      const userMsg: ChatMessage = {
        role: 'user',
        text,
        thinking: [],
        recalled: [],
      };
      props.pushMsg(target, userMsg, ns);
      setStream({ text: '', thinking: [], recalled: [] });

      const patchStream = (
        fn: (s: { text: string; thinking: ThinkStep[]; recalled: RecalledItem[] }) => {
          text: string;
          thinking: ThinkStep[];
          recalled: RecalledItem[];
        },
      ) => setStream((prev) => (prev ? fn(prev) : prev));

      const finish = (res: Parameters<typeof toAssistantMessage>[0]) => {
        const asst = toAssistantMessage(res);
        props.pushMsg(target, asst, ns);
        setStream(null);
        if (titledFor.current !== target) {
          titledFor.current = target;
          onActivity?.(target, text.slice(0, 42));
        }
      };

      try {
        const res = await chatStream(
          userId,
          text,
          { model: model || undefined, memory: memoryOn },
          {
            onThinking: (thinking, recalledMeta) =>
              patchStream((s) => ({ ...s, thinking, recalled: recalledMeta })),
            onToken: (t) => {
              patchStream((s) => ({ ...s, text: s.text + t }));
            },
          },
        );
        finish(res);
      } catch (e) {
        // A NETWORK-level failure (fetch itself threw: DNS, blocked host,
        // rejected preflight, offline) carries no HTTP status — there is no
        // server verdict to show and no charge to protect. Retry the SAME
        // turn once through the same-origin proxy (/api/* → Railway), which
        // carries the session cookie and cannot be blocked cross-origin.
        // A REAL status (429 budget, 401 session) IS a server verdict: the
        // direct path reached the API, so a proxy retry would charge the turn
        // twice. Show it instead.
        const networkLevel = !(e instanceof ApiError) || e.status === 0 || e.status === 404;
        if (networkLevel) {
          try {
            const res = await chatStream(userId, text, {
              model: model || undefined,
              memory: memoryOn,
            }, {
              onThinking: (thinking, recalledMeta) =>
                patchStream((s) => ({ ...s, thinking, recalled: recalledMeta })),
              onToken: (t) => {
                patchStream((s) => ({ ...s, text: s.text + t }));
              },
            }, '');
            finish(res);
            setBusy(false);
            return;
          } catch (e2) {
            handleError(e2, text);
          }
        } else {
          handleError(e, text);
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, input, userId, model, memoryOn, sessionId, onActivity],
  );

  const handleError = (e: unknown, text: string) => {
    // The user turn stays in the log (it was already pushed under the
    // send-time namespace); only the provisional row is dropped and the
    // actionable error card renders beneath it.
    setStream(null);
    if (e instanceof ApiError) {
      if (e.status === 429) {
        setLimitErr(e);
        return;
      }
      setErrorCard(wireError(e, text));
    } else {
      setErrorCard({
        role: 'assistant',
        text: 'The connection dropped before I could answer. Nothing was saved.',
        thinking: [],
        recalled: [],
        error: true,
      });
    }
  };

  const wireError = (err: ApiError, retryText: string): ChatMessage => {
    if (err.status === 401) {
      return {
        role: 'assistant',
        text: 'Your session expired — sign in again to keep going.',
        thinking: [],
        recalled: [],
        error: true,
        guardReason: 'auth',
      };
    }
    if (err.status === 409) {
      return {
        role: 'assistant',
        text: err.needsRelink
          ? 'Your vault link needs repair before private memory can be used.'
          : 'Set up your vault before chatting with private memory.',
        thinking: [],
        recalled: [],
        error: true,
        guardReason: err.needsRelink ? 'relink' : 'setup',
      };
    }
    if (err.status === 503) {
      return {
        role: 'assistant',
        text: `Memory is temporarily unreachable — your message was not answered. ${retryText ? 'Retry when ready.' : ''}`,
        thinking: [],
        recalled: [],
        error: true,
        guardReason: 'retry',
      };
    }
    return {
      role: 'assistant',
      text: err.message || 'Something went wrong — nothing was saved.',
      thinking: [],
      recalled: [],
      error: true,
      guardReason: 'retry',
    };
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  /* --------------------------------------------------------- budget UI */
  const lastBudget = [...messages].reverse().find((m) => m.budget)?.budget;
  const showBudgetNote =
    !demo && lastBudget && lastBudget.remaining <= 3 && lastBudget.remaining > 0;

  /* Signed-out gate: personal chat shows ONLY this card — no message
     list, no composer, no model picker. Demo stays fully open. */
  if (!demo && !signedIn) {
    return (
      <div className="chat-wrap gate-wrap">
        <div className="gate-card" role="region" aria-label="Sign in to chat">
          <h2 className="greet-title">Sign in to start chatting</h2>
          <p className="greet-sub">
            Your personal chat is private to your wallet. Sign in to teach
            memories and get answers checked against them — or look around
            first with the shared demo.
          </p>
          <div className="gate-actions">
            <Button variant="primary" onClick={onOpenWallet}>
              Sign in
            </Button>
            <Button
              onClick={() => {
                window.location.hash = '#/demo';
              }}
            >
              Try demo
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={demo ? 'demo-wrap chat-wrap' : 'chat-wrap'}>
      {demo && (
        <div className="demo-strip" role="note">
          <ScopeBadge scope="demo" /> Shared demo · read-only — nothing you type here is saved.
        </div>
      )}

      {!memoryOn && (
        <div className="memoff-banner" role="note">
          Memory is off — I can still answer, but nothing from this chat is
          remembered or checked against stored facts.
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
        {messages.length === 0 && !busy && (
          <div className="greet">
            {demo ? (
              <>
                <h2 className="greet-title">Try a memory that already exists</h2>
                <p className="greet-sub">
                  Every answer below comes from the shared household memory —
                  ask questions; teaching lives in your personal chat.
                </p>
                <div className="demo-feats">
                  <div className="demo-feats-head">Demo walkthrough — try in order</div>
                  {DEMO_WALKTHROUGH.map((c, i) => (
                    <button
                      key={c}
                      type="button"
                      className="chip"
                      onClick={() => send(c)}
                    >
                      <span className="chip-n">{i + 1}</span>
                      {c}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 className="greet-title">What can I remember for you today?</h2>
                <p className="greet-sub">
                  Medications, allergies, routines — tell me once. Every future
                  answer is checked against what you have taught me.
                </p>
                <button
                  type="button"
                  className="chip chip-accent"
                  onClick={() => onSwitchUser?.('demo-mom')}
                >
                  Explore the demo — no setup
                </button>
                <div className="teach-chips">
                  {TEACH_CHIPS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="chip"
                      onClick={() => send(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg-user">
              <div className="bubble">{m.text}</div>
            </div>
          ) : (
            <div key={i} className={`msg-bot ${m.error ? 'msg-err' : ''}`}>
              {m.verdict === 'STOP' && (
                <div className="verdict verdict-stop" role="alert">
                  <ShieldIcon />
                  <span>STOP — possible safety conflict</span>
                </div>
              )}
              {m.verdict === 'CAUTION' && (
                <div className="verdict verdict-caution" role="alert">
                  <WarnIcon />
                  <span>CAUTION — double-check this one</span>
                </div>
              )}

              {m.guardReason && (
                <p className="err-text">{m.text}</p>
              )}
              {m.guardReason === 'auth' && onOpenWallet && (
                <div className="err-actions">
                  <Button variant="primary" onClick={onOpenWallet}>
                    Sign in
                  </Button>
                </div>
              )}
              {m.guardReason === 'relink' && (
                <div className="err-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      window.location.hash = '#/wallet';
                    }}
                  >
                    Re-link wallet
                  </Button>
                </div>
              )}
              {m.guardReason === 'setup' && (
                <div className="err-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      window.location.hash = '#/wallet';
                    }}
                  >
                    Set up vault
                  </Button>
                </div>
              )}
              {m.guardReason === 'retry' && (
                <div className="err-actions">
                  <Button onClick={() => send(lastSent.current)}>Retry</Button>
                </div>
              )}

              {/* Thinking timeline: one slim row per server thinking step
                  (m.thinking), raw server prose only — memory operations
                  unmissable via recall/write leads + blob chips. Settled
                  turns collapse to a quiet "thoughts" toggle. 'How I
                  decided' survives as aria-label plus a visually-hidden
                  span for tests/AT — never visible. The live stream renders
                  in its own provisional row below. */}
              {!m.error && m.thinking.length > 0 && (
                <div className="think-live">
                  <details className="why" open={!!m.verdict}>
                    <summary aria-label="How I decided">
                      <span className="vh">How I decided</span>
                      <span aria-hidden="true" className="thoughts-toggle">
                        thoughts
                      </span>
                    </summary>
                    <div className="thought-body">
                      <ThinkTrace m={m} mainnet={mainnet} />
                    </div>
                  </details>
                </div>
              )}

              {!m.error && <p className="msg-text">{m.text}</p>}

              {m.cited && m.cited.length > 0 && (
                <div className="cites">
                  {m.cited.map((c, ci) => (
                    <blockquote className="cite" key={ci}>
                      <p>“{c.text}”</p>
                      <footer>
                        Source blob {shortBlob(c.blobId)}
                        {mainnet && c.blobId && (
                          <>
                            {' · '}
                            <a
                              href={`https://walruscan.com/blob/${c.blobId}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              walruscan <ExternalIcon />
                            </a>
                          </>
                        )}
                        {' · '}
                        <a href="#/proof">guard proof</a>
                      </footer>
                    </blockquote>
                  ))}
                </div>
              )}

              {!m.error && m.savedBlob && (
                <div className="saved saved-ok">
                  <CheckIcon size={13} /> Saved to memory · blob{' '}
                  {shortBlob(m.savedBlob)}
                </div>
              )}
              {!m.error &&
                !m.savedBlob &&
                m.memoryPersisted === false && (
                  <div className="saved saved-no">
                    Not saved — nothing new worth keeping
                  </div>
                )}

              {!m.error && (
                <div className="disc">
                  Confirm with your doctor — this is not medical advice.
                </div>
              )}
            </div>
          ),
        )}

        {/* Provisional streaming row: per-word tokens render here while the
            send is in flight. The completed turn is pushed from the `done`
            payload, so the owned log only ever holds completed turns. */}
        {stream && (
          <div className="msg-bot">
            <div className="think-live">
              <div className="thinking-head" role="status">
                <span className="pulse-dot" aria-hidden="true" />
                Thinking…
              </div>
              {stream.thinking.length > 0 && (
                <ThinkTrace
                  m={{
                    role: 'assistant',
                    text: stream.text,
                    thinking: stream.thinking,
                    recalled: stream.recalled,
                  }}
                  mainnet={mainnet}
                />
              )}
            </div>
            {stream.text ? (
              <p className="msg-text">
                {stream.text}
                <span className="caret" aria-hidden="true" />
              </p>
            ) : null}
          </div>
        )}
        {!stream && busy && (
          <div className="msg-bot typing" role="status">
            Thinking…
          </div>
        )}

        {errorCard && (
          <div className="msg-bot msg-err">
            <p className="err-text">{errorCard.text}</p>
            {errorCard.guardReason === 'auth' && onOpenWallet && (
              <div className="err-actions">
                <Button variant="primary" onClick={onOpenWallet}>
                  Sign in
                </Button>
              </div>
            )}
            {errorCard.guardReason === 'relink' && (
              <div className="err-actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    window.location.hash = '#/wallet';
                  }}
                >
                  Re-link wallet
                </Button>
              </div>
            )}
            {errorCard.guardReason === 'setup' && (
              <div className="err-actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    window.location.hash = '#/wallet';
                  }}
                >
                  Set up vault
                </Button>
              </div>
            )}
            {errorCard.guardReason === 'retry' && (
              <div className="err-actions">
                <Button onClick={() => send(lastSent.current)}>Retry</Button>
              </div>
            )}
          </div>
        )}

        {limitErr && (
          <div className="limit-card" role="alert">
            <div className="limit-title">Message limit reached.</div>
            <div className="limit-sub">
              Resets in {formatResetIn(limitErr.resetAt, limitErr.resetInHrs, now)}
            </div>
            <div className="limit-actions">
              {limitErr.loginRequired && onOpenWallet && (
                <Button variant="primary" onClick={onOpenWallet}>
                  Sign in
                </Button>
              )}
              <Button onClick={() => onSwitchUser?.('demo-mom')}>
                Explore the demo
              </Button>
            </div>
          </div>
        )}

      </div>

      {showBudgetNote && (
        <div className="budget-note" role="status">
          {lastBudget.remaining === 1
            ? 'Last message'
            : `${lastBudget.remaining} messages left`}
        </div>
      )}

      <div className="composer-bar">
        <div className="composer-box">
          <textarea
            ref={taRef}
            className="composer"
            rows={1}
            maxLength={500}
            placeholder={
              demo ? 'Ask about the shared memory…' : 'Tell me something to remember…'
            }
            aria-label="Message"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
          />
          <div className="composer-row">
            <select
              className="model-pick"
              aria-label="Model"
              title={
                modelsErr && displayList.length === 0
                  ? 'Model list unavailable — sending with the default'
                  : 'Choose the model for this chat'
              }
              value={model}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  e.target.blur();
                  onOpenProvider?.();
                  return;
                }
                userPicked.current = true;
                setModel(e.target.value);
                saveModel(e.target.value);
              }}
            >
              {displayList.length === 0 && (
                <option value="">
                  {modelsErr ? 'Default model (list unavailable)' : 'Default model'}
                </option>
              )}
              {displayList.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? prettyModel(m.id)}
                </option>
              ))}
              <option value="__custom__">Custom provider…</option>
            </select>
            <span className="char-count" aria-hidden="true">
              {input.length}/500
            </span>
            <button
              type="button"
              className="send-btn"
              aria-label="Send"
              disabled={!input.trim() || busy}
              onClick={() => send()}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
