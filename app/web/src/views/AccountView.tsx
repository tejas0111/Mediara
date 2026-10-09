import { useEffect, useState } from 'react';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
import {
  authLogout,
  EnvMode,
  getProvider,
  walletStatus,
  WalletStatus,
} from '../api';
import { Badge, Button, ScopeBadge, Switch, TextInput, isDemoNamespace } from '../ui';
import MemoryView from './MemoryView';
import ReplayView from './ReplayView';
import GuardProofView from './GuardProofView';
import PrintView from './PrintView';
import DashboardView from './DashboardView';
import './AccountView.css';

export interface AccountViewProps {
  userId: string;
  onSaveUserId: (id: string) => void;
  memoryOn: boolean;
  onToggleMemory: (on: boolean) => void;
  envMode: EnvMode;
  onTryMainnet: () => void;
  onClearHistory: () => void;
  onOpenWallet: () => void;
  onOpenProvider: () => void;
  onSessionChanged: () => void;
}

const shortAddress = (a?: string | null): string =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';

/* Same four-step story as the Wallet view, summarized in one line here —
   the full stepper and its actions live on the Wallet view. */
const WSTEPS = ['Connect wallet', 'Sign message', 'Vault setup', 'Done'];

function go(view: string): void {
  window.location.hash = `#/${view}`;
}

/**
 * Full account page: profile, wallet, memory facts, chat history, safety
 * record, emergency card, personal activity, custom model, environment,
 * local data, and sign out. The data sections embed the same view
 * components their `#/...` routes render, against the same user id — the
 * routes stay alive for deep links while the sidebar stays slim. Demo
 * content (Compare, Stats, demo readiness) lives only in the sidebar Demo
 * group and its `#/...` routes — never embedded here.
 */
export default function AccountView({
  userId,
  onSaveUserId,
  memoryOn,
  onToggleMemory,
  envMode,
  onTryMainnet,
  onClearHistory,
  onOpenWallet,
  onOpenProvider,
  onSessionChanged,
}: AccountViewProps) {
  const account = useCurrentAccount();
  const [editId, setEditId] = useState(userId);
  const [idNote, setIdNote] = useState('');
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [signBusy, setSignBusy] = useState(false);
  const [clearedNote, setClearedNote] = useState('');

  const [provSummary, setProvSummary] = useState('');
  const [provHas, setProvHas] = useState(false);

  useEffect(() => {
    setEditId(userId);
  }, [userId]);

  useEffect(() => {
    const sync = () => {
      const p = getProvider();
      setProvHas(!!p);
      setProvSummary(p ? p.model : '');
    };
    sync();
    window.addEventListener('ddprovider', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('ddprovider', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const refreshStatus = async () => {
    try {
      setStatus(await walletStatus());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    refreshStatus();
  }, [account?.address]);

  const saveUser = () => {
    const v = editId.trim();
    if (!v) {
      setIdNote('Enter a non-empty id — nothing was changed.');
      return;
    }
    onSaveUserId(v);
    setIdNote(`Saved — chatting as ${v}.`);
  };

  const signOut = async () => {
    setSignBusy(true);
    try {
      await authLogout().catch(() => null);
      await refreshStatus();
      onSessionChanged();
    } finally {
      setSignBusy(false);
    }
  };

  const clearChats = () => {
    onClearHistory();
    setClearedNote('Cleared — chat titles and cached messages in this browser are gone.');
  };

  const signedIn = !!account?.address && !!status?.signedIn;
  const pendingPhase = status?.pendingPhase ?? null;
  const ready =
    signedIn &&
    !!status?.onboarded &&
    !status?.needsRelink &&
    !status?.retiredDeployment &&
    !pendingPhase;
  const stepIdx = !account?.address ? 0 : !signedIn ? 1 : ready ? 3 : 2;
  const needsRepair =
    signedIn &&
    (!!status?.needsRelink || !!status?.retiredDeployment || !!pendingPhase);

  const walletLine = !account?.address
    ? 'No wallet connected'
    : !signedIn
      ? 'Wallet connected — not signed in'
      : status?.needsRelink
        ? 'Vault link broken — sign-in works but saving is paused'
        : status?.retiredDeployment
          ? "This vault can't be reused — start a fresh one from the Wallet view"
          : pendingPhase
            ? 'Vault setup paused — continue from the Wallet view'
            : !status?.onboarded
              ? 'No vault yet'
              : 'Vault ready — memories save here';

  const mainnet = envMode === 'mainnet';

  return (
    <div className="acct-wrap">
      <p className="view-note">
        Everything this browser knows about you, in one place. Each section
        below acts on the same settings the rest of the app uses.
      </p>

      <section className="card ap-sec" aria-label="Profile">
        <div className="card-head">
          <h2 className="card-title">Profile</h2>
        </div>
        <div className="card-body">
          <div className="ap-row">
            <TextInput
              value={editId}
              onChange={(e) => setEditId(e.target.value)}
              aria-label="User id"
            />
            <Button variant="primary" onClick={saveUser}>
              Save
            </Button>
          </div>
          <p className="ap-note">
            This id labels your personal shelf of taught memories — answers in
            Chat are checked against what was taught under this name. When you
            sign in with a wallet and set up a vault, personal chat uses your
            wallet address instead.
          </p>
          {idNote && (
            <p className="ap-note" role="status">
              {idNote}
            </p>
          )}
        </div>
      </section>

      <section className="card ap-sec" aria-label="Wallet">
        <div className="card-head">
          <h2 className="card-title">Wallet</h2>
        </div>
        <div className="card-body">
          <p className="ap-status" role="status">
            {walletLine}
          </p>
          <p className="ap-note" role="status">
            {ready && (status?.address ?? account?.address)
              ? `Active vault: ${shortAddress(status?.address ?? account?.address)} — personal memories save here.`
              : 'no vault — guest/demo data only'}
          </p>
          <p className="ap-note">
            Step {stepIdx + 1} of 4 · {WSTEPS[stepIdx]}
            {signedIn && account?.address
              ? ` — signed in as ${shortAddress(status?.address ?? account.address)}`
              : ''}
          </p>
          <div className="ap-row ap-wrap">
            {!account?.address ? (
              <ConnectButton connectText="Connect wallet" />
            ) : (
              !signedIn && (
                <Button variant="primary" onClick={onOpenWallet}>
                  Sign in
                </Button>
              )
            )}
            <Button onClick={() => go('wallet')}>Wallet details</Button>
            {needsRepair && (
              <Button onClick={() => go('wallet')}>Repair vault</Button>
            )}
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Memory">
        <div className="card-head">
          <h2 className="card-title">Memory</h2>
          <ScopeBadge user={userId} />
        </div>
        <div className="card-body">
          <p className="ap-note">
            {isDemoNamespace(userId)
              ? 'Premade shared profile — nothing here is yours.'
              : 'Only your own care record is shown here.'}
          </p>
          <label className="ap-row">
            <Switch
              checked={memoryOn}
              onChange={onToggleMemory}
              label={`Memory ${memoryOn ? 'on' : 'off'}`}
            />
            <span className="ap-note">Memory {memoryOn ? 'on' : 'off'}</span>
          </label>
          <p className="ap-note">
            {memoryOn
              ? 'Teaching in Chat is remembered and checked on every answer.'
              : 'Memory is off — chat still answers, but nothing is remembered or checked.'}
          </p>
          <div className="ap-embed">
            <MemoryView user={userId} mainnet={mainnet} />
          </div>
          <div className="ap-row">
            <Button variant="quiet" onClick={() => go('memory')}>
              Open Memory view
            </Button>
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Chat history">
        <div className="card-head">
          <h2 className="card-title">Chat history</h2>
          <ScopeBadge user={userId} />
        </div>
        <div className="card-body">
          <p className="ap-note">
            {isDemoNamespace(userId)
              ? 'Premade shared profile — nothing here is yours.'
              : 'Only your own care record is shown here.'}
          </p>
          <div className="ap-embed">
            <ReplayView user={userId} />
          </div>
          <div className="ap-row">
            <Button variant="quiet" onClick={() => go('replay')}>
              Open Replay view
            </Button>
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Safety record">
        <div className="card-head">
          <h2 className="card-title">Safety record</h2>
          <ScopeBadge scope="public" />
        </div>
        <div className="card-body">
          <p className="ap-note">
            Global public record — same for everyone, not tied to your vault.
          </p>
          <div className="ap-embed">
            <GuardProofView mainnet={mainnet} />
          </div>
          <div className="ap-row">
            <Button variant="quiet" onClick={() => go('proof')}>
              Open Guard proof view
            </Button>
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Emergency card">
        <div className="card-head">
          <h2 className="card-title">Emergency card</h2>
          <ScopeBadge user={userId} />
        </div>
        <div className="card-body">
          <p className="ap-note">
            {isDemoNamespace(userId)
              ? 'Premade shared profile — nothing here is yours.'
              : 'Only your own care record is shown here.'}
          </p>
          <div className="ap-embed">
            <PrintView user={userId} />
          </div>
          <div className="ap-row">
            <Button variant="quiet" onClick={() => go('print')}>
              Open Print view
            </Button>
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="My activity">
        <div className="card-head">
          <h2 className="card-title">My activity</h2>
          <ScopeBadge user={userId} />
        </div>
        <div className="card-body ap-stack">
          <p className="ap-note">
            Only your own care record is shown here.
          </p>
          <div className="ap-embed">
            <DashboardView userId={userId} personalOnly />
          </div>
          <div className="ap-row ap-wrap">
            <Button variant="quiet" onClick={() => go('dashboard')}>
              Open Dashboard view
            </Button>
            <Button variant="quiet" onClick={() => go('compare')}>
              Open full view: Compare
            </Button>
            <Button variant="quiet" onClick={() => go('stats')}>
              Open full view: Stats
            </Button>
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Custom model">
        <div className="card-head">
          <h2 className="card-title">Custom model</h2>
        </div>
        <div className="card-body">
          <p className="ap-note" role="status">
            {provHas
              ? `Custom model active: ${provSummary || getProvider()?.model || 'saved'} — it appears first in the composer picker.`
              : 'No custom model — chats use the default.'}
          </p>
          <div className="ap-row">
            <Button variant="primary" onClick={onOpenProvider}>
              Custom model settings
            </Button>
          </div>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Environment">
        <div className="card-head">
          <h2 className="card-title">Environment</h2>
        </div>
        <div className="card-body">
          <div className="ap-row">
            {envMode === 'mainnet' ? (
              <Badge tone="ok" title="real Walrus memory">
                Mainnet
              </Badge>
            ) : (
              <div className="seg" role="group" aria-label="Environment">
                <button type="button" className="seg-btn on">
                  Demo
                </button>
                <button type="button" className="seg-btn" onClick={onTryMainnet}>
                  Mainnet
                </button>
              </div>
            )}
          </div>
          <p className="ap-note">
            Demo runs on the local stand-in — answers work, nothing touches the
            chain. Mainnet reads and writes real Walrus memory under your
            vault. If Mainnet is unreachable you get an honest dialog with a
            retry, never a dead end.
          </p>
        </div>
      </section>

      <section className="card ap-sec" aria-label="Data">
        <div className="card-head">
          <h2 className="card-title">Data</h2>
        </div>
        <div className="card-body">
          <div className="ap-row">
            <Button variant="danger" onClick={clearChats}>
              Clear local chats
            </Button>
          </div>
          <p className="ap-note">
            Removes chat titles and cached messages stored in this browser
            only. Walrus memories, your vault, and anything on the server are
            untouched.
          </p>
          {clearedNote && (
            <p className="ap-note" role="status">
              {clearedNote}
            </p>
          )}
        </div>
      </section>

      <section className="card ap-sec" aria-label="Sign out">
        <div className="card-head">
          <h2 className="card-title">Sign out</h2>
        </div>
        <div className="card-body">
          {signedIn ? (
            <div className="ap-row">
              <Button onClick={signOut} disabled={signBusy}>
                {signBusy ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          ) : (
            <p className="ap-note">
              You are not signed in — there is nothing to sign out of. Your
              guest id and local chats stay in this browser.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
