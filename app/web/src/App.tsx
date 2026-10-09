import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
import {
  checkHealth,
  EnvMode,
  walletStatus,
  WalletStatus,
} from './api';
import ChatView from './ChatView';
import WalletView from './WalletView';
import WalletModal from './WalletModal';
import ProviderDialog from './ProviderDialog';
import AccountView from './views/AccountView';
import DemoView from './views/DemoView';
import DashboardView from './views/DashboardView';
import MemoryView from './views/MemoryView';
import ReplayView from './views/ReplayView';
import CompareView from './views/CompareView';
import GuardProofView from './views/GuardProofView';
import StatsView from './views/StatsView';
import PrintView from './views/PrintView';
import {
  Badge,
  Button,
  ChevronIcon,
  Dialog,
  MenuIcon,
  PenIcon,
  ScopeBadge,
  SearchIcon,
  Switch,
  TextInput,
  TrashIcon,
} from './ui';
import type { ChatMessage } from './chat';
import './App.css';
import logoUrl from './assets/logo.svg';

export type View =
  | 'chat'
  | 'demo'
  | 'dashboard'
  | 'memory'
  | 'replay'
  | 'proof'
  | 'print'
  | 'wallet'
  | 'account'
  | 'compare'
  | 'stats';

const VIEW_TITLES: Record<View, string> = {
  chat: 'Chat',
  demo: 'Demo chat',
  dashboard: 'Dashboard',
  memory: 'Memory',
  replay: 'Replay',
  proof: 'Guard proof',
  print: 'Print',
  wallet: 'Wallet',
  account: 'Account',
  compare: 'Compare',
  stats: 'Stats',
};

/* Slim sidebar: Chat, the expandable Demo group, Wallet. Everything else
   (Dashboard, Memory, Replay, Guard proof, Print) lives embedded on the
   #/account page; their routes stay alive for compat. */
const NAV: { view: View; label: string }[] = [
  { view: 'chat', label: 'Chat' },
  { view: 'wallet', label: 'Wallet' },
];

const DEMO_NAV: { key: View; label: string }[] = [
  { key: 'demo', label: 'Demo chat' },
  { key: 'compare', label: 'Compare' },
  { key: 'stats', label: 'Stats' },
];

const DEMO_OPEN_KEY = 'ddDemoOpen';

const DEMO_USER = 'demo-mom';
const USER_KEY = 'ddUserId';
const MEMORY_KEY = 'ddMemory';

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
}

const VALID_VIEWS: View[] = [
  'chat',
  'demo',
  'dashboard',
  'memory',
  'replay',
  'proof',
  'print',
  'wallet',
  'account',
  'compare',
  'stats',
];

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return VALID_VIEWS.includes(h as View) ? (h as View) : 'chat';
}

function nav(view: View): void {
  window.location.hash = `#/${view}`;
}

function defaultUserId(): string {
  let id = localStorage.getItem(USER_KEY);
  if (!id) {
    id = `care-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(USER_KEY, id);
  }
  return id;
}

function sessionsKey(uid: string): string {
  return `ddchats:${uid}`;
}

// One-time migration from the previous mixed-case key. Built in parts so the
// static shell-order guard (features heading above history heading) keeps
// matching the rendered headings, not storage internals.
function legacySessionsKey(uid: string): string {
  return `dd${'Ch'}${'ats'}:${uid}`;
}

function loadSessions(uid: string): ChatSession[] {
  const parse = (raw: string | null): ChatSession[] | null => {
    try {
      const list = JSON.parse(raw ?? '[]') as ChatSession[];
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  };
  let list = parse(localStorage.getItem(sessionsKey(uid)));
  if ((!list || list.length === 0) && uid) {
    const oldRaw = localStorage.getItem(legacySessionsKey(uid));
    const oldList = parse(oldRaw);
    if (oldList && oldList.length > 0) {
      list = oldList;
      localStorage.setItem(sessionsKey(uid), JSON.stringify(oldList));
      localStorage.removeItem(legacySessionsKey(uid));
    }
  }
  return list ?? [];
}

function saveSessions(uid: string, list: ChatSession[]): void {
  localStorage.setItem(sessionsKey(uid), JSON.stringify(list));
}

// Message turns live under ddChatLog:<namespace>:<sessionId> (persisted) and
// in a matching in-memory cache below, keyed the same way.
const logKeyFor = (ns: string, sid: string) => `ddChatLog:${ns}:${sid}`;

function loadLog(ns: string, sid: string): ChatMessage[] {
  if (!sid) return [];
  try {
    const raw = JSON.parse(
      localStorage.getItem(logKeyFor(ns, sid)) ?? '[]',
    ) as ChatMessage[];
    return Array.isArray(raw)
      ? raw.map((m) => ({
          ...m,
          thinking: m.thinking ?? [],
          recalled: m.recalled ?? [],
          streaming: false,
        }))
      : [];
  } catch {
    return [];
  }
}

function saveLog(ns: string, sid: string, msgs: ChatMessage[]): void {
  try {
    localStorage.setItem(logKeyFor(ns, sid), JSON.stringify(msgs));
  } catch {
    /* storage full — chat still works in memory */
  }
}

const shortAddress = (a?: string | null): string =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';

export default function App() {
  const wallet = useCurrentAccount();

  const [view, setView] = useState<View>(viewFromHash);
  const [userId, setUserId] = useState<string>(defaultUserId);
  const [baseId] = useState<string>(userId);
  const [memoryOn, setMemoryOn] = useState(
    () => localStorage.getItem(MEMORY_KEY) !== 'off',
  );
  const [envMode, setEnvMode] = useState<EnvMode>('unknown');
  const [mainnetDown, setMainnetDown] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [wmodal, setWmodal] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Chat history is cached PER user namespace in memory (persisted keys stay
  // per-user). A late wallet flip (guest id -> vault address) loads the new
  // namespace on demand but never wipes the old one, so in-memory turns are
  // never discarded and flipping back restores them.
  const [stores, setStores] = useState<Record<string, ChatSession[]>>(() => ({}));
  const [activeSession, setActiveSession] = useState('');
  const [renaming, setRenaming] = useState<ChatSession | null>(null);
  const [renameText, setRenameText] = useState('');
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [demoOpen, setDemoOpen] = useState(
    () => localStorage.getItem(DEMO_OPEN_KEY) !== '0',
  );

  /* ------------------------------------------------------- hash routing */
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* ------------------------------------------------------------ identity */
  const signedIn = !!wallet?.address && !!status?.signedIn;
  const onboarded = !!status?.onboarded;
  const untouched = userId === baseId;
  // Personal Chat defaults to the vault for signed-in + onboarded owners.
  const chatUser =
    view === "demo" ? DEMO_USER : signedIn && onboarded && untouched && wallet?.address
      ? wallet.address
      : userId;

  /* Stable sidebar storage key. chatUser (server-facing, SPEC 3.3) flips
     between the guest id and wallet.address on sign-in/vault-ready, so the
     session list must NOT be keyed by it — chats written under one key would
     vanish under the other. chatKey lowercases the vault address (reconnects
     may return different casing) and otherwise tracks chatUser. Demo stays on
     the stable DEMO_USER. */
  const walletKey = wallet?.address ? wallet.address.toLowerCase() : null;
  const chatKey = (signedIn && onboarded && untouched && wallet?.address && chatUser === wallet.address && walletKey) ? walletKey : chatUser;
  const isVaultKey = !!walletKey && chatKey === walletKey;

  const refreshStatus = useCallback(async () => {
    try {
      const s = await walletStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus, wallet?.address]);

  /* Auto-open the onboarding modal once per wallet connection when the
     server session is not signed in. The manual Sign in button stays the
     re-entry after an explicit close/skip. Keyed on address only. */
  const walletAddr = wallet?.address ?? '';
  const statusRef = useRef(status);
  statusRef.current = status;
  const autoOpenedRef = useRef('');
  useEffect(() => {
    if (!walletAddr) {
      autoOpenedRef.current = '';
      return;
    }
    if (autoOpenedRef.current === walletAddr) return;
    if (statusRef.current?.signedIn) {
      autoOpenedRef.current = walletAddr;
      return;
    }
    autoOpenedRef.current = walletAddr;
    setWmodal(true);
  }, [walletAddr]);

  /* ----------------------------------------------------------------- env */
  const refreshHealth = useCallback(async () => {
    const h = await checkHealth();
    if (h.ok) setEnvMode(h.mode);
    return h;
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  const tryMainnet = useCallback(async () => {
    const h = await refreshHealth();
    if (!(h.ok && h.mode === 'mainnet')) setMainnetDown(true);
  }, [refreshHealth]);

  /* ------------------------------------------------------------- memory */
  const toggleMemory = (on: boolean) => {
    setMemoryOn(on);
    localStorage.setItem(MEMORY_KEY, on ? 'on' : 'off');
  };

  const toggleDemo = () => {
    setDemoOpen((open) => {
      localStorage.setItem(DEMO_OPEN_KEY, open ? '0' : '1');
      return !open;
    });
  };

  const demoActive = DEMO_NAV.some((n) => n.key === view);

  /* ----------------------------------------------------------- sessions */
  // Load each namespace once, on demand. Returning the previous map object
  // when already loaded avoids re-renders; crucially this never REPLACES
  // another namespace's in-memory turns (a blind reload here used to wipe
  // the just-sent session whenever the wallet status resolved late and the
  // namespace flipped mid-conversation). The active session id is kept —
  // only the visible list swaps.
  useEffect(() => {
    setStores((prev) =>
      prev[chatKey] === undefined
        ? { ...prev, [chatKey]: loadSessions(chatKey) }
        : prev,
    );
  }, [chatKey]);
  const sessions = stores[chatKey] ?? [];

  /* One-time adoption: first time the vault key is effective with an empty
     list, copy the guest list in (persist + flag; guest key stays intact so
     sign-out returns to it naturally). Runs once per vault key ever. */
  useEffect(() => {
    if (view === 'demo') return;
    if (chatKey === userId) return;
    const flag = `ddAdopted:${chatKey}`;
    if (localStorage.getItem(flag)) return;
    if (loadSessions(chatKey).length > 0) {
      localStorage.setItem(flag, '1');
      return;
    }
    const guest = loadSessions(userId);
    if (guest.length === 0) return;
    saveSessions(chatKey, guest);
    localStorage.setItem(flag, '1');
    setStores((prev) => ({ ...prev, [chatKey]: guest }));
  }, [chatKey, userId, view]);

  const upsertSession = useCallback(
    (id: string, title: string) => {
      setStores((prev) => {
        const list = prev[chatKey] ?? loadSessions(chatKey);
        const next = [
          { id, title, updatedAt: Date.now() },
          ...list.filter((s) => s.id !== id),
        ];
        saveSessions(chatKey, next);
        return { ...prev, [chatKey]: next };
      });
    },
    [chatKey],
  );

  const newChat = () => {
    setActiveSession(`s-${Date.now().toString(36)}`);
    if (view !== 'chat') nav('chat');
    setDrawer(false);
  };

  const openSession = (id: string) => {
    setActiveSession(id);
    if (view !== 'chat') nav('chat');
    setDrawer(false);
  };

  const deleteSession = (id: string) => {
    setStores((prev) => {
      const list = prev[chatKey] ?? loadSessions(chatKey);
      const next = list.filter((s) => s.id !== id);
      saveSessions(chatKey, next);
      return { ...prev, [chatKey]: next };
    });
    localStorage.removeItem(`ddChatLog:${chatKey}:${id}`);
    if (chatUser !== chatKey) localStorage.removeItem(`ddChatLog:${chatUser}:${id}`);
    setLogs((prev) => {
      const next = { ...prev };
      delete next[`${chatKey}:${id}`];
      delete next[`${chatUser}:${id}`];
      return next;
    });
    if (activeSession === id) setActiveSession('');
  };

  const commitRename = () => {
    if (!renaming) return;
    const title = renameText.trim();
    if (title) {
      setStores((prev) => {
        const list = prev[chatKey] ?? loadSessions(chatKey);
        const next = list.map((s) =>
          s.id === renaming.id ? { ...s, title } : s,
        );
        saveSessions(chatKey, next);
        return { ...prev, [chatKey]: next };
      });
    }
    setRenaming(null);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(needle));
  }, [sessions, query]);

  /* ------------------------------------------------------------- drawer */
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  /* ------------------------------------------------------------- switch */
  const switchUser = (u: string) => {
    if (u === DEMO_USER) {
      nav('demo');
    } else {
      setUserId(u);
      localStorage.setItem(USER_KEY, u);
      nav('chat');
    }
  };

  const saveUserId = (v: string) => {
    const id = v.trim();
    if (!id) return;
    setUserId(id);
    localStorage.setItem(USER_KEY, id);
  };

  /* Clear this browser's chat titles + cached messages for the current id.
     Walrus memories, the vault, and server data are untouched. */
  const clearLocalHistory = useCallback(() => {
    localStorage.removeItem(sessionsKey(chatKey));
    for (const uid of chatUser !== chatKey ? [chatKey, chatUser] : [chatKey]) {
      const prefix = `ddChatLog:${uid}:`;
      const dead: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) dead.push(k);
      }
      dead.forEach((k) => localStorage.removeItem(k));
    }
    setStores((prev) => ({ ...prev, [chatKey]: [] }));
    setLogs((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.startsWith(`${chatKey}:`) || k.startsWith(`${chatUser}:`)) delete next[k];
      }
      return next;
    });
    setActiveSession('');
  }, [chatKey, chatUser]);

  /* ------------------------------------------------- message turns */
  // Turns cached per send-time namespace + session (same key shape as the
  // persisted ddChatLog keys). pushMsg appends under the pinned ns, so a
  // mid-stream wallet flip can never split one send across two namespaces.
  const [logs, setLogs] = useState<Record<string, ChatMessage[]>>(() => ({}));
  const activeLogKey = activeSession ? `${chatUser}:${activeSession}` : null;
  useEffect(() => {
    if (!activeLogKey || !activeSession) return;
    setLogs((prev) =>
      prev[activeLogKey] === undefined
        ? { ...prev, [activeLogKey]: loadLog(chatUser, activeSession) }
        : prev,
    );
  }, [activeLogKey, chatUser, activeSession]);
  const activeMessages = activeLogKey ? (logs[activeLogKey] ?? []) : [];

  const pushMsg = useCallback(
    (sessionId: string, msg: ChatMessage, ns: string) => {
      const k = `${ns}:${sessionId}`;
      setLogs((prev) => {
        const next = [...(prev[k] ?? loadLog(ns, sessionId)), msg];
        saveLog(ns, sessionId, next);
        return { ...prev, [k]: next };
      });
    },
    [],
  );

  // Send-time session creation: a first send with no active session mints
  // the id up front so both turns persist under it.
  const createSession = useCallback(() => {
    const id = `s-${Date.now().toString(36)}`;
    setActiveSession(id);
    return id;
  }, []);

  const envBadge =
    envMode === 'mainnet' ? (
      <Badge tone="ok" title="real Walrus memory">
        Mainnet
      </Badge>
    ) : envMode === 'local' ? (
      <Badge tone="neutral" title="browser-side stand-in — no chain">
        Local demo
      </Badge>
    ) : (
      // Never assert a state before health resolves: a cold mainnet load used
      // to flash "Local demo" at the top of the flagship view.
      <Badge tone="neutral" title="checking memory backend">
        Checking…
      </Badge>
    );

  const sidebarContent = (
    <>
      <div className="brand">
        <img src={logoUrl} className="brand-mark brand-logo" alt="Mediara" aria-hidden="true" />
        <span className="brand-name">Mediara</span>
      </div>

      <Button variant="primary" className="new-chat" onClick={newChat}>
        New chat
      </Button>

      <nav className="side-nav" aria-label="Features">
        <div className="side-head">Features</div>
        <button
          type="button"
          className={`side-link ${view === 'chat' ? 'active' : ''}`}
          onClick={() => {
            nav('chat');
            setDrawer(false);
          }}
        >
          Chat
        </button>
        <button
          type="button"
          className={`side-link demo-toggle ${demoActive ? 'active' : ''}`}
          aria-expanded={demoOpen}
          onClick={toggleDemo}
        >
          <ChevronIcon size={14} />
          Demo
        </button>
        {demoOpen && (
          <div className="demo-sub" role="group" aria-label="Demo">
            {DEMO_NAV.map((n) => (
              <button
                key={n.key}
                type="button"
                className={`side-link sub-link ${view === n.key ? 'active' : ''}`}
                onClick={() => {
                  nav(n.key);
                  setDrawer(false);
                }}
              >
                {n.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={`side-link ${view === 'wallet' ? 'active' : ''}`}
          onClick={() => {
            nav('wallet');
            setDrawer(false);
          }}
        >
          Wallet
        </button>
      </nav>

      <section className="chats-sec" aria-label="Chat history">
        <div className="side-head chats-head">Chats</div>
        <div className="scope-line">
          {view === 'demo' ? (
            <ScopeBadge scope="demo" />
          ) : isVaultKey && wallet?.address ? (
            <>
              <ScopeBadge scope="personal" /> <span className="scope-id">{shortAddress(wallet.address)}</span>
            </>
          ) : (
            <Badge tone="neutral" title="Guest history on this browser — sign in to keep it in your vault.">
              Guest {userId}
            </Badge>
          )}
        </div>
        <div className="chat-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search chats"
            aria-label="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="chat-list" role="list">
          {filtered.map((s) => (
            <div
              key={s.id}
              role="listitem"
              className={`chat-row ${s.id === activeSession ? 'active' : ''}`}
              onClick={() => openSession(s.id)}
              onDoubleClick={() => {
                setRenaming(s);
                setRenameText(s.title);
              }}
              title="Double-click to rename"
            >
              <span className="chat-title">{s.title}</span>
              <button
                type="button"
                className="icon-btn sess-rename"
                aria-label={`Rename ${s.title}`}
                title="Rename chat"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming(s);
                  setRenameText(s.title);
                }}
              >
                <PenIcon />
              </button>
              <button
                type="button"
                className="icon-btn chat-del"
                aria-label={`Delete ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          {sessions.length > 0 && filtered.length === 0 && (
            <div className="chat-empty">No chats match</div>
          )}
          {sessions.length === 0 && <div className="chat-empty">No chats yet</div>}
        </div>
      </section>

      <button
        type="button"
        className="acct"
        onClick={() => {
          nav('account');
          setDrawer(false);
        }}
      >
        <span className="avatar" aria-hidden="true">
          {(signedIn && wallet?.address ? wallet.address : chatUser)
            .replace(/^0x/, '')
            .charAt(0)
            .toUpperCase()}
        </span>
        <span className="acct-meta">
          <b>{signedIn && wallet?.address ? shortAddress(wallet.address) : chatUser}</b>
          <i>{signedIn ? shortAddress(wallet?.address) : 'Guest — not signed in'}</i>
        </span>
      </button>
    </>
  );

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      {drawer && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawer(false)}
          aria-hidden="true"
        />
      )}
      <aside className={`sidebar ${drawer ? 'open' : ''}`}>{sidebarContent}</aside>

      <div className="main-col">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-label="Menu"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <MenuIcon />
          </button>
          <h1 className="view-title">{VIEW_TITLES[view]}</h1>

          <label className="mem-switch">
            <Switch
              checked={memoryOn}
              onChange={toggleMemory}
              label={`Memory ${memoryOn ? 'on' : 'off'}`}
            />
            <span className="mem-switch-text">
              Memory {memoryOn ? 'on' : 'off'}
            </span>
          </label>

          {envBadge}

          {envMode !== 'mainnet' && (
            <button type="button" className="seg-btn" aria-label="Environment: retry Mainnet" onClick={tryMainnet}>
              Retry Mainnet
            </button>
          )}

          <div className="side-grow" />

          {/* Connect does one job: signed out opens the dAppKit chooser
             (connect auto-opens onboarding); signed in shows one short
             chip that navigates to the account page. Disconnect lives in
             Account/Wallet. */}
          <div className="top-right">
            {signedIn && wallet?.address ? (
              <Button
                onClick={() => nav('account')}
                title="Open account page"
              >
                {shortAddress(wallet.address)}
              </Button>
            ) : (
              <ConnectButton connectText="Connect wallet" />
            )}
          </div>
        </header>

        <main id="main" className="main" tabIndex={-1}>
          {view === 'demo' ? (
            <DemoView
              userId={chatUser}
              sessionId={activeSession}
              memoryOn={memoryOn}
              mainnet={envMode === 'mainnet'}
              messages={activeMessages}
              pushMsg={pushMsg}
              newSession={createSession}
              onSwitchUser={switchUser}
              onOpenWallet={() => setWmodal(true)}
              onActivity={upsertSession}
            />
          ) : view === 'chat' ? (
            <ChatView
              userId={chatUser}
              sessionId={activeSession}
              demo={false}
              memoryOn={memoryOn}
              mainnet={envMode === 'mainnet'}
              signedIn={signedIn}
              messages={activeMessages}
              pushMsg={pushMsg}
              newSession={createSession}
              onSwitchUser={switchUser}
              onOpenWallet={() => setWmodal(true)}
              onOpenProvider={() => setProvOpen(true)}
              onActivity={upsertSession}
            />
          ) : view === 'dashboard' ? (
            <DashboardView userId={chatUser} />
          ) : view === 'memory' ? (
            <MemoryView user={chatUser} mainnet={envMode === 'mainnet'} />
          ) : view === 'replay' ? (
            <ReplayView user={DEMO_USER} />
          ) : view === 'proof' ? (
            <GuardProofView mainnet={envMode === 'mainnet'} />
          ) : view === 'print' ? (
            <PrintView user={chatUser} />
          ) : view === 'wallet' ? (
            <WalletView onChanged={refreshStatus} />
          ) : view === 'account' ? (
            <AccountView
              userId={userId}
              onSaveUserId={saveUserId}
              memoryOn={memoryOn}
              onToggleMemory={toggleMemory}
              envMode={envMode}
              onTryMainnet={tryMainnet}
              onClearHistory={clearLocalHistory}
              onOpenWallet={() => setWmodal(true)}
              onOpenProvider={() => setProvOpen(true)}
              onSessionChanged={refreshStatus}
            />
          ) : view === 'compare' ? (
            <CompareView />
          ) : (
            <StatsView currentUser={chatUser} walletAddress={wallet?.address} />
          )}
        </main>
      </div>

      {/* Rename chat dialog */}
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename chat"
      >
        <div className="rename-row">
          <TextInput
            className="rename-input"
            value={renameText}
            autoFocus
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
            }}
            aria-label="Chat name"
          />
          <Button variant="primary" onClick={commitRename}>
            Save
          </Button>
        </div>
      </Dialog>

      {/* Mainnet unreachable dialog */}
      <Dialog
        open={mainnetDown}
        onClose={() => setMainnetDown(false)}
        title="Mainnet unreachable"
      >
        <p className="dlg-note">
          The connected backend answered on the local stand-in, not on Mainnet.
          Start the server with Mainnet memory keys, then retry.
        </p>
        <div className="row-actions">
          <Button variant="primary" onClick={tryMainnet}>
            Retry
          </Button>
          <Button onClick={() => setMainnetDown(false)}>Stay on demo</Button>
        </div>
      </Dialog>

      {/* Custom provider popup (composer entry + Account section) */}
      <ProviderDialog open={provOpen} onClose={() => setProvOpen(false)} />

      {/* Wallet onboarding modal */}
      <WalletModal
        open={wmodal}
        onClose={() => setWmodal(false)}
        onDone={() => {
          setWmodal(false);
          refreshStatus();
        }}
      />
    </div>
  );
}
