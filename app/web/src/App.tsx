import React from 'react';
import ChatView from './ChatView';
import WalletView from './WalletView';
import WalletModal from './WalletModal';
import MemoryView from './views/MemoryView';
import DashboardView from './views/DashboardView';
import ReplayView from './views/ReplayView';
import CompareView from './views/CompareView';
import ProofView from './views/ProofView';
import StatsView from './views/StatsView';
import PrintView from './views/PrintView';
import {
  deleteSession as delSess,
  loadSessions,
  navigate,
  newSession as makeSession,
  parseHash,
  renameSession as renSess,
  routeSessionId,
  routeView,
  saveSession,
  titleFor,
} from './chat';
import type { ChatMsg, ChatSession, Route, ViewKey } from './chat';
import { authLogout, checkHealth, getApiBase, getDashboard, getDeviceId, setApiBase, walletStatus } from './api';
import type { WalletStatus } from './api';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  FieldHint,
  FieldLabel,
  IconChat,
  IconMenu,
  IconPlus,
  IconSearch,
  IconTrash,
  IconWallet,
  IconX,
  Input,
  Separator,
  cn,
} from './ui';
import './App.css';

const NAV: Array<{ key: ViewKey; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'demo', label: 'Demo chat' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'memory', label: 'Memory' },
  { key: 'replay', label: 'Replay' },
  { key: 'proof', label: 'Guard proof' },
  { key: 'print', label: 'Print' },
  { key: 'wallet', label: 'Wallet' },
];
const VIEW_TITLES: Record<ViewKey, string> = {
  chat: 'Chat',
  demo: 'Demo chat',
  dashboard: 'Dashboard',
  memory: 'Memory',
  replay: 'Replay',
  compare: 'Compare',
  proof: 'Guard proof',
  stats: 'Stats',
  print: 'Print',
  wallet: 'Wallet',
};

const MEM_KEY = 'ddMemoryOn';

function loadMemoryOn(): boolean {
  try {
    return localStorage.getItem(MEM_KEY) !== 'off';
  } catch {
    return true;
  }
}

// Shared-demo strip under the topbar. The guest cap is read live from the
// dashboard budget; when the endpoint is missing the strip says so honestly
// instead of quoting a stale hardcoded number.
function DemoBanner() {
  const [label, setLabel] = React.useState('Shared demo · guests get personal budgets');
  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const d = await getDashboard('demo-mom');
        const b = d?.personal?.budget;
        const cap = typeof b?.cap === 'number' && b.cap > 0 ? b.cap : null;
        const used = typeof b?.used === 'number' && b.used >= 0 ? b.used : null;
        if (!live) return;
        setLabel(
          cap !== null && used !== null
            ? `Shared demo · ${used}/${cap} guest chats used today · read-only`
            : 'Shared demo · guests get personal budgets',
        );
      } catch {
        if (live) setLabel('Shared demo · guests get personal budgets');
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return (
    <p className="demo-banner" role="note">
      {label}
    </p>
  );
}

export default function App() {
  const [userId, setUserId] = React.useState('demo-mom');
  const [draftId, setDraftId] = React.useState('demo-mom');
  const [memoryOn, setMemoryOn] = React.useState(loadMemoryOn);
  const [route, setRoute] = React.useState<Route>('chat');
  const [sessions, setSessions] = React.useState<ChatSession[]>(() => loadSessions('demo-mom'));
  const [filter, setFilter] = React.useState('');
  const [drawer, setDrawer] = React.useState(false);
  const [mode, setMode] = React.useState<'local' | 'mainnet' | null>(null);
  const [acctOpen, setAcctOpen] = React.useState(false);
  const [wallet, setWallet] = React.useState<WalletStatus | null>(null);
  // Demo|Mainnet environment switch (local same-origin server only).
  // sameOriginMode = what the serving backend reports; the Demo|Mainnet toggle
  // is visible only when it is 'local'. `mode` = effective backend mode for
  // the ACTIVE base (same-origin or custom URL), refreshed via checkHealth.
  const [sameOriginMode, setSameOriginMode] = React.useState<'local' | 'mainnet' | null>(null);
  const [envChoice, setEnvChoice] = React.useState<'demo' | 'mainnet'>(() => (getApiBase() ? 'mainnet' : 'demo'));
  const [envError, setEnvError] = React.useState<string | null>(null);
  // Mainnet has no prefilled URL anywhere in the UI: the probe tries the
  // saved base first, then same-origin health. Unreachable means an honest
  // error with Retry — never a URL prompt, never a silent dead end.
  const [mainnetLive, setMainnetLive] = React.useState(false);
  const [comingOpen, setComingOpen] = React.useState(false);
  const [wmodal, setWmodal] = React.useState(false);
  const [renameTarget, setRenameTarget] = React.useState<{ id: string; value: string } | null>(null);
  const [comingNote, setComingNote] = React.useState<string | null>(null);
  // dAppKit wallet connection (client-side) vs server session (signed-in):
  // no wallet = ConnectButton opens the chooser modal directly,
  // wallet-but-no-session = "Sign in" navigates to #/wallet,
  // session = short address opens the Account dialog.
  const suiAccount = useCurrentAccount();

  const view = routeView(route);
  const activeId = routeSessionId(route);
  const active = sessions.find((s) => s.id === activeId) ?? null;
  // Demo chat is locked to the shared demo namespace: the sidebar user
  // editor is ignored while on it, so guests always read premade memory.
  const DEMO_USER = 'demo-mom';
  // SPEC §3.3: personal Chat defaults to the vault for signed-in owners.
  // An untouched default id + a signed-in session => send the session address
  // (the server resolves the vault from the session; an unlinked vault 409s
  // with a re-link action). When the vault state is unknown client-side we
  // still default on signed-in and let the server 409 — never silently use
  // demo scope (demo budget + "sign in" nag) for a signed-in user.
  const DEFAULT_USER = 'demo-mom';
  const personalUserId =
    userId === DEFAULT_USER && wallet?.signedIn && wallet.address ? wallet.address : userId;
  // Dashboard/memory/replay/print follow the vault only when it is usable
  // (onboarded): otherwise they keep the requested id, so a signed-in user
  // with no vault still sees demo readiness (matrix B) instead of a 409 wall.
  const vaultUserId =
    userId === DEFAULT_USER && wallet?.onboarded && wallet.address ? wallet.address : userId;
  const chatUser = view === 'demo' ? DEMO_USER : personalUserId;

  const refreshWallet = React.useCallback(async () => {
    try {
      setWallet(await walletStatus());
    } catch {
      setWallet(null);
    }
  }, []);

  const refreshEffectiveMode = React.useCallback(async (base: string) => {
    try {
      const h = await checkHealth(base);
      if (h.ok && h.mode) setMode(h.mode);
    } catch {
      /* keep last known mode — badge never lies about an unknown backend */
    }
  }, []);

  React.useEffect(() => {
    void refreshWallet();
    // Guest identity first: creates the persisted device id so the very first
    // chat turn already carries X-Device-Id (per-browser guest budget).
    try { getDeviceId(); } catch { /* keyless guests still chat — server falls back to 'anon' */ }
    // Initial backend state: same-origin mode decides toggle visibility;
    // active-base health decides the badge. A saved base is re-verified;
    // with no saved base Mainnet is simply unreachable until one is set.
    void (async () => {
      try {
        const same = await checkHealth('');
        if (same.ok && same.mode) setSameOriginMode(same.mode);
      } catch {
        /* offline dev — toggle stays hidden until ChatView reports local */
      }
      const active = getApiBase();
      setEnvChoice(active ? 'mainnet' : 'demo');
      if (active) {
        const h = await checkHealth(active);
        setMainnetLive(h.ok);
        if (!h.ok) setApiBase('');
      } else {
        setMainnetLive(false);
      }
      await refreshEffectiveMode(getApiBase());
    })();
  }, [refreshWallet, refreshEffectiveMode]);

  React.useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setDrawer(false);
    };
    window.addEventListener('hashchange', onHash);
    setRoute(parseHash());
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  React.useEffect(() => {
    setSessions(loadSessions(chatUser));
  }, [chatUser]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function applyUser() {
    const v = draftId.trim() || 'demo-mom';
    setDraftId(v);
    setUserId(v);
    setAcctOpen(false);
    navigate('chat');
  }

  function toggleMemory() {
    setMemoryOn((m) => {
      try {
        localStorage.setItem(MEM_KEY, m ? 'off' : 'on');
      } catch {
        /* ignore */
      }
      return !m;
    });
  }

  function handleNewChat() {
    const s = makeSession();
    setSessions(saveSession(chatUser, s));
    navigate(view === 'demo' ? 'demo' : 'chat', s.id);
    setDrawer(false);
  }

  function handleSelect(id: string) {
    navigate(view === 'demo' ? 'demo' : 'chat', id);
    setDrawer(false);
  }

  function handleNewSessionProp(): string {
    const s = makeSession();
    setSessions(saveSession(chatUser, s));
    navigate(view === 'demo' ? 'demo' : 'chat', s.id);
    return s.id;
  }

  function pushMsg(sessionId: string, msg: ChatMsg) {
    setSessions((prev) => {
      const found = prev.find((s) => s.id === sessionId);
      const base = found ?? { ...makeSession(), id: sessionId };
      const firstUser = base.msgs.length === 0 && msg.role === 'user';
      const next: ChatSession = {
        ...base,
        title: firstUser ? titleFor(msg.text) : base.title,
        msgs: [...base.msgs, msg],
      };
      saveSession(chatUser, next);
      return [next, ...prev.filter((s) => s.id !== next.id)];
    });
  }

  function handleDelete(id: string) {
    const next = delSess(chatUser, id);
    setSessions(next);
    if (activeId === id) navigate(view === 'demo' ? 'demo' : 'chat');
  }

  function handleRename(id: string, current: string) {
    setRenameTarget({ id, value: current });
  }

  function commitRename() {
    if (!renameTarget) return;
    setSessions(renSess(chatUser, renameTarget.id, renameTarget.value));
    setRenameTarget(null);
  }

  function handleMode(m: 'local' | 'mainnet') {
    setMode(m);
    // Chat traffic uses the active base; when on same-origin (Demo) the
    // reported mode IS the same-origin mode, so the toggle can appear even
    // if the mount-time /healthz probe failed.
    if (!getApiBase()) setSameOriginMode(m);
  }

  async function handleSignOut() {
    try {
      await authLogout();
    } catch {
      /* show wallet view for the honest error */
    }
    await refreshWallet();
    setAcctOpen(false);
    navigate('wallet');
  }

  // --- Demo|Mainnet environment switch (same-origin local server only) ---
  // Mainnet is attempted only against the saved base. When it does not
  // answer, the honest unreachable panel opens — never a URL prompt.
  function switchToDemo() {
    setApiBase('');
    setEnvChoice('demo');
    setEnvError(null);
    setComingOpen(false);
    void refreshEffectiveMode('');
    void refreshWallet();
  }

  async function switchToMainnet() {
    setEnvError(null);
    const saved = getApiBase().trim();
    const h = await checkHealth(saved);
    if (saved && h.ok && h.mode) {
      setApiBase(saved);
      setMainnetLive(true);
      setComingOpen(false);
      setEnvChoice('mainnet');
      setMode(h.mode);
      void refreshWallet();
    } else {
      setMainnetLive(false);
      setComingNote('The Mainnet backend is unreachable right now — staying on Demo.');
      setComingOpen(true);
    }
  }

  const q = filter.trim().toLowerCase();
  const visible = q
    ? sessions.filter((s) => s.title.toLowerCase().includes(q))
    : sessions;

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>

      <div
        className={cn('backdrop', drawer && 'backdrop-on')}
        onClick={() => setDrawer(false)}
        aria-hidden="true"
      />

      <aside className={cn('sidebar', drawer && 'open')} aria-label="Sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span className="brand-name">Mediara</span>
          <button type="button" className="icon-btn only-mobile" aria-label="Close menu" onClick={() => setDrawer(false)}>
            <IconX />
          </button>
        </div>

        <div className="side-sec">
          <Button variant="primary" onClick={handleNewChat}>
            <IconPlus /> New chat
          </Button>
        </div>

        <div className="side-scroll">
        <nav className="side-sec" aria-label="Features">
          <p className="side-h">Features</p>
          <ul className="nav-list">
            {NAV.map((n) => (
              <li key={n.key}>
                <button
                  type="button"
                  className={cn('nav-it', view === n.key && 'nav-active')}
                  aria-current={view === n.key ? 'page' : undefined}
                  onClick={() => { navigate(n.key); setDrawer(false); }}
                >
                  {n.key === 'chat' ? <IconChat /> : null}
                  {n.key === 'wallet' ? <IconWallet /> : null}
                  <span className="nav-label">{n.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="side-sec side-grow">
          <p className="side-h">Chats</p>
          <div className="search-wrap">
            <span className="search-ic" aria-hidden="true"><IconSearch /></span>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
            />
          </div>
          <ul className="sess-list" aria-label="Chat history">
            {visible.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={cn('sess', s.id === activeId && 'sess-active')}
                  onClick={() => handleSelect(s.id)}
                  onDoubleClick={() => handleRename(s.id, s.title)}
                  title="Open chat (double-click to rename)"
                >
                  <span className="sess-ic" aria-hidden="true"><IconChat /></span>
                  <span className="sess-title">{s.title}</span>
                </button>
                <button
                  type="button"
                  className="icon-btn sess-del"
                  aria-label={`Delete ${s.title}`}
                  onClick={() => handleDelete(s.id)}
                >
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
          {visible.length === 0 ? (
            <p className="side-note">
              {q ? `No chats match “${filter.trim()}”.` : 'No chats yet — start one above.'}
            </p>
          ) : null}
        </div>

        </div>
        <div className="side-foot">
          <button type="button" className="acct" onClick={() => setAcctOpen(true)} aria-haspopup="dialog">
            <span className="avatar" aria-hidden="true">{personalUserId.slice(0, 1).toUpperCase()}</span>
            <span className="acct-meta">
              <span className="acct-id">{personalUserId}</span>
              <span className="acct-sub">
                {wallet?.signedIn
                  ? `Wallet ${wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'connected'}`
                  : 'Guest — not signed in'}
              </span>
            </span>
          </button>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button type="button" className="icon-btn only-mobile" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <IconMenu />
          </button>
          <span className="top-title">{VIEW_TITLES[view]}</span>
          <div className="top-right">
            <button
              type="button"
              role="switch"
              aria-checked={memoryOn}
              aria-label="Memory"
              title={`Memory ${memoryOn ? 'on' : 'off'} — toggle to compare with and without memory`}
              className={cn('switch', memoryOn && 'switch-on')}
              onClick={toggleMemory}
            >
              <span className="knob" />
            </button>
            <span className="mem-label">Memory {memoryOn ? 'on' : 'off'}</span>
            <Badge
              variant={mode === 'mainnet' ? 'mainnet' : 'local'}
              title={mode === 'mainnet' ? 'Mainnet = real Walrus memory' : 'Local demo = browser-side stand-in, no chain'}
            >
              {mode === 'mainnet' ? 'Mainnet' : 'Local demo'}
            </Badge>
            {sameOriginMode === 'local' ? (
              <div className="env-seg" role="group" aria-label="Environment">
                <button
                  type="button"
                  className={cn('env-opt', envChoice === 'demo' && 'env-active')}
                  aria-pressed={envChoice === 'demo'}
                  onClick={switchToDemo}
                >
                  Demo
                </button>
                <button
                  type="button"
                  className={cn('env-opt', envChoice === 'mainnet' && 'env-active')}
                  aria-pressed={envChoice === 'mainnet'}
                  onClick={() => void switchToMainnet()}
                >
                  Mainnet
                </button>
              </div>
            ) : null}
            {wallet?.signedIn ? (
              <Button
                size="sm"
                className="wallet-btn"
                aria-label={wallet.address ? `Wallet ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)} — account` : 'Wallet connected — account'}
                onClick={() => setAcctOpen(true)}
              >
                <IconWallet />
                <span className="wallet-label">
                  {wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'Sign out'}
                </span>
              </Button>
            ) : suiAccount ? (
              <Button
                size="sm"
                className="wallet-btn"
                aria-label={`Sui wallet ${suiAccount.address.slice(0, 6)}…${suiAccount.address.slice(-4)} connected — sign in`}
                onClick={() => setWmodal(true)}
              >
                <IconWallet />
                <span className="wallet-label">Sign in</span>
              </Button>
            ) : (
              <span className="top-connect">
                <ConnectButton
                  connectText="Connect wallet"
                  className="btn btn-sm wallet-btn"
                  aria-label="Connect wallet"
                />
              </span>
            )}
          </div>
        </header>
        {view === 'demo' ? <DemoBanner /> : null}
        <main id="main" className="main" tabIndex={-1}>
          {view === 'chat' ? (
            <ChatView
              userId={chatUser}
              memoryOn={memoryOn}
              sessions={sessions}
              active={active}
              selectSession={handleSelect}
              newSession={handleNewSessionProp}
              pushMsg={pushMsg}
              onMode={handleMode}
              onSwitchUser={(id) => {
                if (id === 'demo-mom') { navigate('demo'); return; }
                setDraftId(id); setUserId(id); navigate('chat');
              }}
              onSignIn={() => setWmodal(true)}
            />
          ) : view === 'demo' ? (
            <ChatView
              userId={DEMO_USER}
              memoryOn={memoryOn}
              sessions={sessions}
              active={active}
              selectSession={handleSelect}
              newSession={handleNewSessionProp}
              pushMsg={pushMsg}
              onMode={handleMode}
              onSwitchUser={(id) => {
                if (id === 'demo-mom') { navigate('demo'); return; }
                setDraftId(id); setUserId(id); navigate('chat');
              }}
              onSignIn={() => setWmodal(true)}
            />
          ) : view === 'dashboard' ? (
            <DashboardView userId={vaultUserId} />
          ) : view === 'wallet' ? (
            <WalletView userId={vaultUserId} onAuth={() => void refreshWallet()} />
          ) : view === 'memory' ? (
            <MemoryView userId={vaultUserId} />
          ) : view === 'replay' ? (
            <ReplayView userId={vaultUserId} />
          ) : view === 'compare' ? (
            // Compare has no vault branch server-side (anonymous isolation
            // proof): it keeps the typed id, defaulting to the demo pair.
            <CompareView userId={userId} />
          ) : view === 'proof' ? (
            <ProofView userId={vaultUserId} />
          ) : view === 'stats' ? (
            <StatsView userId={vaultUserId} />
          ) : (
            <PrintView userId={vaultUserId} />
          )}
        </main>
      </div>
      {comingOpen ? (
        <Dialog title="Mainnet unreachable" onClose={() => setComingOpen(false)}>
          <div className="stack">
            <p className="soon-copy">
              The Mainnet backend did not answer just now — staying on Demo,
              nothing was switched. Check your connection or try again.
            </p>
            {comingNote ? <Alert variant="warn">{comingNote}</Alert> : null}
            <div className="btn-row">
              <Button variant="primary" onClick={() => void switchToMainnet()}>
                Retry
              </Button>
              <Button onClick={switchToDemo}>
                Back to Demo
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {wmodal ? (
        <WalletModal onClose={() => setWmodal(false)} onAuth={() => void refreshWallet()} />
      ) : null}
      {renameTarget ? (
        <Dialog title="Rename chat" onClose={() => setRenameTarget(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commitRename();
            }}
          >
            <FieldLabel htmlFor="rename-input">Chat name</FieldLabel>
            <div className="uid-row">
              <Input
                id="rename-input"
                value={renameTarget.value}
                onChange={(e) => setRenameTarget({ id: renameTarget.id, value: e.target.value })}
                placeholder="Chat name"
                maxLength={80}
              />
              <Button size="sm" variant="primary" type="submit">Save</Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {acctOpen ? (
        <Dialog title="Account" onClose={() => setAcctOpen(false)}>
          <FieldLabel htmlFor="acct-uid">User ID</FieldLabel>
          <div className="uid-row">
            <Input
              id="acct-uid"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder="user id"
            />
            <Button size="sm" variant="primary" onClick={applyUser}>Apply</Button>
          </div>
          <FieldHint>Your memories are private to this ID. Chats are per browser + user.</FieldHint>
          <Separator />
          <FieldLabel>Environment</FieldLabel>
          <div className="foot-row">
            <Badge variant={envChoice === 'demo' ? 'local' : 'mainnet'}>
              {envChoice === 'demo' ? 'Demo (this server)' : 'Mainnet'}
            </Badge>
            {envChoice === 'demo' ? (
              mainnetLive ? (
                <Button size="sm" onClick={() => { setAcctOpen(false); void switchToMainnet(); }}>
                  Switch to Mainnet
                </Button>
              ) : (
                <Button size="sm" onClick={() => { setAcctOpen(false); setComingNote(null); setComingOpen(true); }}>
                  About Mainnet
                </Button>
              )
            ) : (
              <Button size="sm" onClick={switchToDemo}>
                Back to Demo
              </Button>
            )}
          </div>
          {envError ? <FieldHint>{envError}</FieldHint> : null}
          <Separator />
          <div className="foot-row">
            <Badge variant={wallet?.signedIn ? 'ok' : 'default'}>
              {wallet?.signedIn ? `wallet ${wallet.address ?? ''}`.trim() : 'Not connected'}
            </Badge>
            <Badge variant={suiAccount ? 'mainnet' : 'default'}>
              {suiAccount ? `sui ${suiAccount.address.slice(0, 6)}…${suiAccount.address.slice(-4)}` : 'Not connected'}
            </Badge>
            <Button
              size="sm"
              onClick={() => { if (wallet?.signedIn) { void handleSignOut(); } else { setAcctOpen(false); setWmodal(true); } }}
            >
              {wallet?.signedIn ? 'Sign out' : 'Sign in'}
            </Button>
            <Button size="sm" onClick={() => { setAcctOpen(false); navigate('wallet'); setDrawer(false); }}>
              Wallet details
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
