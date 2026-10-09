// Guided wallet flow: Connect -> Sign -> Vault -> Chat. One modal, skippable
// at every step, always landing back in chat. The full machinery (manual,
// relink, tx inspection) stays on #/wallet; this is the happy path.
import React from 'react';
import { navigate } from './chat';
import { ConnectButton, useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit';
import { ApiError, authMessage, authVerify, walletStatus } from './api';
import { Alert, Button, Dialog, FieldHint, IconCheck } from './ui';

type Step = 'connect' | 'sign' | 'setup' | 'done';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'connect', label: 'Connect' },
  { key: 'sign', label: 'Sign in' },
  { key: 'setup', label: 'Vault' },
  { key: 'done', label: 'Chat' },
];

function shortAddr(a: string): string {
  return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message || 'Request failed.';
    if (e.status === 401) return `Your session expired — sign in again. (${msg})`;
    if (e.status === 409) return msg;
    if (e.status === 429) return `${msg} — please wait, then try again.`;
    if (e.status === 503) return `${msg} — please retry in a moment.`;
    return `Server error (${e.status}): ${msg}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export default function WalletModal({ onClose, onAuth }: { onClose: () => void; onAuth: () => void }) {
  const account = useCurrentAccount();
  const signPersonalMessage = useSignPersonalMessage();
  const [step, setStep] = React.useState<Step>(account ? 'sign' : 'connect');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (account && step === 'connect') setStep('sign');
    if (!account && (step === 'sign' || step === 'setup')) setStep('connect');
  }, [account, step]);

  async function signIn() {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const { nonce, message } = await authMessage();
      const { signature } = await signPersonalMessage.mutateAsync({
        message: new TextEncoder().encode(message),
      });
      const res = await authVerify(account.address, signature, nonce);
      if (!res.ok) throw new Error('Server did not confirm sign-in.');
      const st = await walletStatus();
      onAuth();
      const ready = !!st.onboarded && !st.needsRelink && !st.pendingPhase;
      setStep(ready ? 'done' : 'setup');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const idx = STEPS.findIndex((s) => s.key === step);

  return (
    <Dialog title="Wallet sign-in" onClose={onClose}>
      <ol className="wsteps" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s.key} className={i < idx ? 'ws-done' : i === idx ? 'ws-now' : ''} aria-current={i === idx ? 'step' : undefined}>
            <span className="ws-dot" aria-hidden="true">{i < idx ? '✓' : i + 1}</span>
            <span className="ws-label">{s.label}</span>
          </li>
        ))}
      </ol>

      {step === 'connect' ? (
        <div className="stack">
          <p className="eyebrow">Step 1 of 4 · Connect</p>
          <p className="modal-copy" style={{ marginTop: 0 }}>
            Connect your wallet to unlock your private memory vault.
            Signing in and vault setup follow right here — skip anytime and
            keep chatting as a guest.
          </p>
          <div className="btn-row">
            <ConnectButton connectText="Connect wallet" />
          </div>
          <FieldHint>No wallet yet? Install a Sui wallet in your browser, then return here to connect.</FieldHint>
          {error ? <Alert variant="danger" role="alert">{error}</Alert> : null}
          <div className="btn-row">
            <Button size="sm" onClick={onClose}>Skip for now</Button>
          </div>
        </div>
      ) : null}

      {step === 'sign' ? (
        <div className="stack">
          <p className="eyebrow">Step 2 of 4 · Sign in</p>
          <p className="modal-copy" style={{ marginTop: 0 }}>
            Signing as <span className="mono">{account ? shortAddr(account.address) : ''}</span> —
            a message that proves ownership. No transaction is submitted.
          </p>
          <div className="btn-row">
            <Button variant="primary" onClick={() => void signIn()} disabled={busy || !account} aria-busy={busy}>
              {busy ? 'Check your wallet…' : 'Sign message'}
            </Button>
            <Button size="sm" onClick={onClose} disabled={busy}>Skip for now</Button>
          </div>
          {busy ? <FieldHint>Approve the signature request in your wallet.</FieldHint> : null}
          {error ? (
            <Alert variant="danger" role="alert">
              <span>{error}</span>
              <span className="btn-row">
                <Button size="sm" onClick={() => void signIn()} disabled={busy || !account}>Try again</Button>
              </span>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {step === 'setup' ? (
        <div className="stack">
          <p className="eyebrow">Step 3 of 4 · Vault</p>
          <p className="modal-copy" style={{ marginTop: 0 }}>
            You&apos;re signed in. Your private vault needs a
            one-time setup — two transactions submitted from your wallet.
          </p>
          <div className="btn-row">
            <Button variant="primary" onClick={() => { onClose(); navigate('wallet'); }}>Set up vault</Button>
            <Button size="sm" onClick={onClose}>Skip for now</Button>
          </div>
          <FieldHint>“Set up vault” continues on the Wallet page with full transaction detail. If setup was interrupted, the Wallet page resumes where you left off.</FieldHint>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="stack">
          <p className="eyebrow">Step 4 of 4 · Chat</p>
          <p className="signed-line"><IconCheck /> Vault ready — your chats now save to your own memory.</p>
          <div className="btn-row">
            <Button variant="primary" onClick={onClose}>Back to chat</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
