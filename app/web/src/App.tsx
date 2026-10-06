import React from 'react';
import ChatView from './ChatView';
import WalletView from './WalletView';
import MemoryView from './views/MemoryView';
import DemoView from './views/DemoView';
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
import { authLogout, checkHealth, getApiBase, setApiBase, walletStatus } from './api';
import type { WalletStatus } from './api';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
import {
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
  { key: 'memory', label: 'Memory' },
  { key: 'proof', label: 'Guard proof' },
  { key: 'print', label: 'Print' },
  { key: 'demo', label: 'Demo' },
  { key: 'replay', label: 'Replay' },
  { key: 'compare', label: 'Compare' },
  { key: 'stats', label: 'Stats' },
];
const VIEW_TITLES: Record<ViewKey, string> = {
  chat: 'Chat',
  memory: 'Memory',
  demo: 'Demo',
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
  const [mainnetUrl, setMainnetUrl] = React.useState(() => getApiBase());
  const [urlTest, setUrlTest] = React.useState<string | null>(null);
  const [urlBusy, setUrlBusy] = React.useState(false);
  // dAppKit wallet connection (client-side) vs server session (signed-in):
  // no wallet = ConnectButton opens the chooser modal directly,
  // wallet-but-no-session = "Sign in" navigates to #/wallet,
  // session = short address opens the Account dialog.
  const suiAccount = useCurrentAccount();

  const view = routeView(route);
  const activeId = routeSessionId(route);
  const active = sessions.find((s) => s.id === activeId) ?? null;

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
    // Initial backend state: same-origin mode decides toggle visibility;
    // active-base health decides the badge. Both run on mount.
    void (async () => {
      try {
        const same = await checkHealth('');
        if (same.ok && same.mode) setSameOriginMode(same.mode);
      } catch {
        /* offline dev — toggle stays hidden until ChatView reports local */
      }
      const active = getApiBase();
      setMainnetUrl(active);
      setEnvChoice(active ? 'mainnet' : 'demo');
      await refreshEffectiveMode(active);
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
    setSessions(loadSessions(userId));
  }, [userId]);

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
    setSessions(saveSession(userId, s));
    navigate('chat', s.id);
    setDrawer(false);
  }

  function handleSelect(id: string) {
    navigate('chat', id);
    setDrawer(false);
  }

  function handleNewSessionProp(): string {
    const s = makeSession();
    setSessions(saveSession(userId, s));
    navigate('chat', s.id);
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
      saveSession(userId, next);
      return [next, ...prev.filter((s) => s.id !== next.id)];
    });
  }

  function handleDelete(id: string) {
    const next = delSess(userId, id);
    setSessions(next);
    if (activeId === id) navigate('chat');
  }

  function handleRename(id: string, current: string) {
    const next = window.prompt('Rename chat', current);
    if (next === null) return;
    setSessions(renSess(userId, id, next));
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
  function switchToDemo() {
    setApiBase('');
    setMainnetUrl('');
    setEnvChoice('demo');
    setEnvError(null);
    setUrlTest(null);
    void refreshEffectiveMode('');
    void refreshWallet();
  }

  async function switchToMainnet() {
    const url = getApiBase().trim();
    if (!url) {
      // No URL configured — open the Account dialog URL section with an
      // honest error. Never silently switch.
      setEnvError('No Mainnet server URL set — paste one below, Test it, then Save.');
      setAcctOpen(true);
      return;
    }
    setEnvError(null);
    const h = await checkHealth(url);
    if (h.ok && h.mode) {
      setEnvChoice('mainnet');
      setMode(h.mode);
      void refreshWallet();
    } else {
      setEnvError(`Mainnet server unreachable (${h.error ?? 'no response'}) — staying on Demo. Open Account to fix the URL.`);
      setAcctOpen(true);
    }
  }

  async function testMainnetUrl() {
    setUrlBusy(true);
    setUrlTest(null);
    try {
      const h = await checkHealth(mainnetUrl.trim());
      setUrlTest(h.ok ? `OK — server mode: ${h.mode}` : `Failed: ${h.error ?? 'no response'}`);
    } finally {
      setUrlBusy(false);
    }
  }

  async function saveMainnetUrl() {
    const v = mainnetUrl.trim();
    if (!v) {
      // Empty URL = back to Demo; instant.
      switchToDemo();
      return;
    }
    setUrlBusy(true);
    try {
      const h = await checkHealth(v);
      if (h.ok && h.mode) {
        setApiBase(v);
        setEnvChoice('mainnet');
        setMode(h.mode);
        setUrlTest(`OK — server mode: ${h.mode}. Saved.`);
        setEnvError(null);
        void refreshWallet();
      } else {
        // Persist ONLY on ok — keep the old base untouched.
        setUrlTest(`Failed: ${h.error ?? 'no response'} — not saved.`);
      }
    } finally {
      setUrlBusy(false);
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
          <span className="brand-mark" aria-hidden="true">D</span>
          <span className="brand-name">DoseDaughter</span>
          <button type="button" className="icon-btn only-mobile" aria-label="Close menu" onClick={() => setDrawer(false)}>
            <IconX />
          </button>
        </div>

        <div className="side-sec">
          <Button variant="primary" onClick={handleNewChat}>
            <IconPlus /> New chat
          </Button>
        </div>

        <nav className="side-sec" aria-label="Features">
          <p className="side-h">Features</p>
          <ul className="nav-list">
            <li>
              <button
                type="button"
                className={cn('nav-it', view === 'chat' && 'nav-active')}
                onClick={() => { navigate('chat'); setDrawer(false); }}
              >
                <IconChat /> <span className="nav-label">Chat</span>
              </button>
            </li>
            {NAV.map((n) => (
              <li key={n.key}>
                <button
                  type="button"
                  className={cn('nav-it', view === n.key && 'nav-active')}
                  onClick={() => { navigate(n.key); setDrawer(false); }}
                >
                  <span className="nav-label">{n.label}</span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={cn('nav-it', view === 'wallet' && 'nav-active')}
                onClick={() => { navigate('wallet'); setDrawer(false); }}
              >
                <IconWallet /> <span className="nav-label">Wallet</span>
              </button>
            </li>
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

        <div className="side-foot">
          <button type="button" className="acct" onClick={() => setAcctOpen(true)} aria-haspopup="dialog">
            <span className="avatar" aria-hidden="true">{userId.slice(0, 1).toUpperCase()}</span>
            <span className="acct-meta">
              <span className="acct-id">{userId}</span>
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
                onClick={() => navigate('wallet')}
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
        <main id="main" className="main" tabIndex={-1}>
          {view === 'chat' ? (
            <ChatView
              userId={userId}
              memoryOn={memoryOn}
              sessions={sessions}
              active={active}
              selectSession={handleSelect}
              newSession={handleNewSessionProp}
              pushMsg={pushMsg}
              onMode={handleMode}
            />
          ) : view === 'wallet' ? (
            <WalletView userId={userId} onAuth={() => void refreshWallet()} />
          ) : view === 'memory' ? (
            <MemoryView userId={userId} />
          ) : view === 'demo' ? (
            <DemoView userId={userId} />
          ) : view === 'replay' ? (
            <ReplayView userId={userId} />
          ) : view === 'compare' ? (
            <CompareView userId={userId} />
          ) : view === 'proof' ? (
            <ProofView userId={userId} />
          ) : view === 'stats' ? (
            <StatsView userId={userId} />
          ) : (
            <PrintView userId={userId} />
          )}
        </main>
      </div>
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
          <FieldHint>Memory namespace: user-{draftId.trim() || userId}. Chats are per browser + user.</FieldHint>
          <Separator />
          <FieldLabel htmlFor="acct-url">Mainnet server URL</FieldLabel>
          <div className="uid-row">
            <Input
              id="acct-url"
              value={mainnetUrl}
              onChange={(e) => { setMainnetUrl(e.target.value); setUrlTest(null); }}
              placeholder="https://… (empty = Demo)"
              inputMode="url"
            />
            <Button size="sm" onClick={() => void testMainnetUrl()} disabled={urlBusy}>
              {urlBusy ? 'Testing…' : 'Test'}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void saveMainnetUrl()} disabled={urlBusy}>
              Save
            </Button>
          </div>
          {urlTest ? <FieldHint>{urlTest}</FieldHint> : null}
          {envError ? <FieldHint>{envError}</FieldHint> : null}
          <Separator />
          <div className="foot-row">
            <Badge variant={wallet?.signedIn ? 'ok' : 'default'}>
              {wallet?.signedIn ? `wallet ${wallet.address ?? ''}`.trim() : 'wallet out'}
            </Badge>
            <Badge variant={suiAccount ? 'mainnet' : 'default'}>
              {suiAccount ? `sui ${suiAccount.address.slice(0, 6)}…${suiAccount.address.slice(-4)}` : 'sui out'}
            </Badge>
            <Button
              size="sm"
              onClick={() => { void handleSignOut(); }}
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
