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
import { authLogout, walletStatus } from './api';
import type { WalletStatus } from './api';
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

  React.useEffect(() => {
    void refreshWallet();
  }, [refreshWallet]);

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

  async function handleWalletButton() {
    if (wallet?.signedIn) {
      try {
        await authLogout();
      } catch {
        /* show wallet view for the honest error */
      }
      await refreshWallet();
      navigate('wallet');
    } else {
      navigate('wallet');
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
                <IconChat /> Chat
              </button>
            </li>
            {NAV.map((n) => (
              <li key={n.key}>
                <button
                  type="button"
                  className={cn('nav-it', view === n.key && 'nav-active')}
                  onClick={() => { navigate(n.key); setDrawer(false); }}
                >
                  {n.label}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={cn('nav-it', view === 'wallet' && 'nav-active')}
                onClick={() => { navigate('wallet'); setDrawer(false); }}
              >
                <IconWallet /> Wallet
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
          {visible.length === 0 ? <p className="side-note">No chats yet.</p> : null}
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
            <Badge variant={mode === 'mainnet' ? 'mainnet' : 'local'}>{mode ?? 'local?'}</Badge>
            <Button size="sm" onClick={() => void handleWalletButton()}>
              <IconWallet />
              {wallet?.signedIn
                ? (wallet.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'Sign out')
                : 'Connect wallet'}
            </Button>
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
              onMode={setMode}
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
          <div className="foot-row">
            <Badge variant={wallet?.signedIn ? 'ok' : 'default'}>
              {wallet?.signedIn ? `wallet ${wallet.address ?? ''}`.trim() : 'wallet out'}
            </Badge>
            <Button
              size="sm"
              onClick={() => { setAcctOpen(false); void handleWalletButton(); }}
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
