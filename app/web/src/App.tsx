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
  IconChat,
  IconMenu,
  IconPlus,
  IconSearch,
  IconTrash,
  IconWallet,
  IconX,
  Input,
  cn,
} from './ui';
import './App.css';

const NAV: Array<{ key: ViewKey; label: string }> = [
  { key: 'memory', label: 'Memory' },
  { key: 'demo', label: 'Demo' },
  { key: 'replay', label: 'Replay' },
  { key: 'compare', label: 'Compare' },
  { key: 'proof', label: 'Guard proof' },
  { key: 'stats', label: 'Stats' },
  { key: 'print', label: 'Print' },
];

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

        <div className="side-sec">
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

        <nav className="side-sec" aria-label="Views">
          <p className="side-h">Views</p>
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

        <div className="side-foot">
          <div className="uid-row">
            <Input
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              aria-label="User ID"
              placeholder="user id"
            />
            <Button size="sm" onClick={applyUser}>Apply</Button>
          </div>
          <div className="foot-row">
            <button
              type="button"
              role="switch"
              aria-checked={memoryOn}
              aria-label="Memory"
              className={cn('switch', memoryOn && 'switch-on')}
              onClick={toggleMemory}
            >
              <span className="knob" />
            </button>
            <span className="foot-label">Memory {memoryOn ? 'on' : 'off'}</span>
            <Badge variant={mode === 'mainnet' ? 'mainnet' : 'local'}>
              {mode ?? 'local?'}
            </Badge>
          </div>
          <div className="foot-row">
            <Button size="sm" onClick={() => void handleWalletButton()}>
              {wallet?.signedIn ? 'Sign out' : 'Sign in'}
            </Button>
            <Badge variant={wallet?.signedIn ? 'ok' : 'default'}>
              {wallet?.signedIn ? `wallet ${wallet.address ?? ''}`.trim() : 'wallet out'}
            </Badge>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <IconMenu />
          </button>
          <span className="top-title">DoseDaughter</span>
          <Badge variant={mode === 'mainnet' ? 'mainnet' : 'local'}>{mode ?? 'local?'}</Badge>
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
    </div>
  );
}
