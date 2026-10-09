import { useCallback, useEffect, useState } from 'react';
import {
  ConnectButton,
  useCurrentAccount,
  useSignPersonalMessage,
  useSignTransaction,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import {
  ApiError,
  authLogout,
  authMessage,
  authVerify,
  walletOnboardCompleteSig,
  walletOnboardCreate,
  walletOnboardLink,
  walletReset,
  walletStatus,
  WalletStatus,
} from './api';
import { Button, Dialog } from './ui';
import './WalletView.css';

/* First-run guide, state-aware.

   The old modal was a fixed 4-step tour (connect → sign → vault → done) that
   ran for every wallet, so a returning vault owner saw "Create my vault"
   (which the server can only answer with a 409) and a "Vault link broken"
   step they never asked for. The vault state is only knowable AFTER the
   session exists — /api/wallet/status is keyed on the session cookie — so
   this modal asks the server what THIS wallet needs before it shows a step,
   and then renders exactly one primary action:

     needOf(status):
       signedIn=false                       → "Sign in" (one message signature)
       onboarded, nothing pending           → Done — the modal closes itself
       needsRelink && !retired              → "Connect your existing vault" (one
                                               transaction signature; zero when
                                               the delegate is already onchain)
       retired                              → "Start a fresh vault" (reset →
                                               create → link, two signatures)
       pendingPhase                         → resume that step
       no account yet                       → create → link (two signatures)

   Nothing is ever presented as "vault setup" before the server has said which
   step is real. */
type Need = 'sign' | 'ready' | 'link' | 'create' | 'fresh' | 'resume';

const needOf = (st: WalletStatus | null): Need => {
  if (!st?.signedIn) return 'sign';
  if (st.retiredDeployment) return 'fresh';
  if (st.pendingPhase) return 'resume';
  if (st.needsRelink) return 'link';
  if (!st.onboarded) return 'create';
  return 'ready';
};

/** Progress strip: only the steps THIS wallet can actually need. */
const stepsFor = (need: Need): string[] => {
  if (need === 'link') return ['Sign in', 'Connect vault', 'Ready'];
  if (need === 'resume') return ['Sign in', 'Finish setup', 'Ready'];
  if (need === 'create' || need === 'fresh')
    return ['Sign in', 'Create vault', 'Connect vault', 'Ready'];
  return ['Sign in', 'Ready'];
};

const HELP: Record<Need, string> = {
  sign: 'One signature proves the wallet is yours — nothing is spent, and then we check what your vault needs.',
  ready: 'Everything is ready — teach a memory in chat and every answer is checked against it.',
  link: 'Your vault already exists onchain — one signature reconnects this browser to it. Nothing is created and nothing is spent.',
  create: 'One press creates your private vault (first signature) and connects it (second signature). Your wallet pays the two transactions.',
  fresh: 'This wallet has a vault from an older setup that can no longer be opened — start a fresh one for this wallet. Two signatures: create, then connect.',
  resume: 'Your vault setup stopped halfway — one press finishes the step that is still pending.',
};

const TITLE: Record<Need, string> = {
  sign: 'Sign in',
  ready: "You're set",
  link: 'Connect your existing vault',
  create: 'Create your private vault',
  fresh: 'Start a fresh vault',
  resume: 'Finish vault setup',
};

const LABEL: Record<Need, string> = {
  sign: 'Sign the message',
  ready: 'Back to chat',
  link: 'Connect my vault',
  create: 'Create my vault',
  fresh: 'Start a fresh vault',
  resume: 'Continue setup',
};

interface ErrAction {
  text: string;
  action?: { label: string; run: () => void };
}

export default function WalletModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const [st, setSt] = useState<WalletStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<ErrAction | null>(null);
  /* How far this visit got — drives the progress strip, never the server. */
  const [advanced, setAdvanced] = useState(0);

  const isWalletCancel = (e: unknown): boolean =>
    /reject|denied|cancel|closed|dismiss|popup/i.test(
      String((e as { message?: unknown })?.message ?? e),
    );

  const flagFrom = (e: ApiError, key: string): boolean => {
    const d = e.data as Record<string, unknown> | null | undefined;
    return !!d && typeof d === 'object' && d[key] === true;
  };

  /* The wallet that signs must be the wallet the session belongs to. */
  const walletAddr = account?.address ?? null;
  const sessionAddr = st?.address ?? null;
  const addrMismatch =
    !!sessionAddr &&
    !!walletAddr &&
    sessionAddr.toLowerCase() !== walletAddr.toLowerCase();

  /* Read the server's view of this wallet. The status route is read-only and
     answers signedIn:false without a session, so this never fails closed on a
     first-run wallet — it simply routes to the sign step. */
  const check = useCallback(async (): Promise<WalletStatus | null> => {
    setChecking(true);
    try {
      const s = await walletStatus();
      setSt(s);
      setChecked(true);
      return s;
    } catch {
      setChecked(true);
      setErr({
        text: "Couldn't check your vault just now — the server didn't answer.",
        action: { label: 'Check again', run: () => void check() },
      });
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      // Every open re-reads the server: the vault state can change while the
      // modal is closed (the Wallet view can finish it), and a stale answer
      // here would show the wrong single step.
      setChecked(false);
      setErr(null);
      setAdvanced(0);
      return;
    }
    if (checking || checked) return;
    void check();
  }, [open, checked, checking, check]);

  const need = needOf(st);
  const steps = stepsFor(need);
  const stepIdx = Math.min(
    need === 'ready' ? steps.length - 1 : advanced,
    steps.length - 1,
  );

  const fail = (e: unknown, fallback: string): void => {
    if (e instanceof ApiError) {
      if (e.status === 401) {
        setErr({
          text: 'Your sign-in expired — sign in again to continue.',
          action: { label: 'Sign in', run: () => void signIn() },
        });
        return;
      }
      if (e.status === 409) {
        if (e.needsRelink) {
          setErr({
            text: 'Your vault needs one more signature to reconnect — press "Connect my vault" to continue.',
            action: { label: 'Connect my vault', run: () => void linkVault() },
          });
          return;
        }
        if (flagFrom(e, 'alreadyLinked')) {
          setErr({
            text: 'This wallet already has a working vault — nothing left to set up.',
          });
          void check();
          return;
        }
        if (e.retiredDeployment) {
          setErr({
            text: 'This vault was created under an older setup and can no longer be opened — press "Start a fresh vault".',
            action: { label: 'Start a fresh vault', run: () => void freshVault() },
          });
          return;
        }
        setErr({ text: e.message });
        return;
      }
      if (e.status === 429) {
        setErr({ text: 'Too many tries — wait a little, then press the step again.' });
        return;
      }
      if (e.status === 503 || e.status === 0) {
        setErr({
          text: "The server didn't answer — nothing was saved.",
          action: { label: 'Try again', run: () => void check() },
        });
        return;
      }
    }
    setErr({ text: e instanceof ApiError ? e.message : fallback });
  };

  /* Landing: re-read status so the next render (or the close) is honest. If
     the vault is usable, close the modal — the owner never sees a leftover
     step. */
  const finish = async (): Promise<void> => {
    const s = await check();
    if (!s) return; // check() already set an honest, retryable error
    if (needOf(s) === 'ready') {
      setAdvanced(stepsFor('ready').length - 1);
      onDone();
      return;
    }
    setErr({
      text: 'One step is still left on your vault — press Check again, then the step below.',
      action: { label: 'Check again', run: () => void check() },
    });
  };

  /* -------------------------------------------------------------- sign in */
  const signIn = async (): Promise<void> => {
    if (!account?.address) return;
    setErr(null);
    setBusy('sign');
    try {
      const { nonce, message } = await authMessage();
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(message),
      });
      await authVerify(account.address, signature, nonce);
      setAdvanced(1);
      // The session exists now, so the vault state is finally knowable: this
      // one status read decides whether anything else is needed at all.
      const s = await check();
      if (s && needOf(s) === 'ready') {
        setAdvanced(stepsFor('ready').length - 1);
        onDone();
      }
    } catch (e) {
      if (isWalletCancel(e)) {
        setErr({
          text: 'Signature cancelled in your wallet — press again to retry',
          action: { label: 'Sign the message', run: () => void signIn() },
        });
      } else {
        fail(e, 'The signature was not completed in the wallet.');
      }
    } finally {
      setBusy('');
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy('signout');
    try {
      await authLogout();
      setSt(null);
      setChecked(false);
      setAdvanced(0);
      await check();
    } catch {
      setErr({
        text: 'Could not sign out just now — try again.',
        action: { label: 'Try again', run: () => void signOut() },
      });
    } finally {
      setBusy('');
    }
  };

  /* ------------------------------------------------ prepare → sign → submit */
  const signAndSubmit = async (txBytesBase64: string): Promise<void> => {
    setBusy('approve');
    const out = await signTransaction({
      transaction: Transaction.from(txBytesBase64),
    });
    await walletOnboardCompleteSig(out.signature);
  };

  /* Existing vault, this server is missing the delegate: ONE signature, and
     zero when the delegate is already registered onchain (the server answers
     alreadyLinked without ever prompting the wallet). */
  const linkVault = async (): Promise<void> => {
    if (!account?.address) return;
    if (addrMismatch) {
      setErr({
        text: 'The connected wallet is not the one you signed in with — switch wallet account, or sign out and sign back in.',
        action: { label: 'Sign out', run: () => void signOut() },
      });
      return;
    }
    setErr(null);
    setBusy('link');
    try {
      const prep = await walletOnboardLink();
      const p = prep as Record<string, unknown>;
      if (p.alreadyLinked === true) {
        await finish();
        return;
      }
      const txBytes = String(p.txBytesBase64 ?? p.txBytes ?? '');
      if (!txBytes) throw new Error('empty transaction');
      await signAndSubmit(txBytes);
      setAdvanced(2);
      await finish();
    } catch (e) {
      if (isWalletCancel(e)) {
        setErr({
          text: 'Signature cancelled in your wallet — press again to retry',
          action: { label: 'Connect my vault', run: () => void linkVault() },
        });
      } else if (e instanceof ApiError && e.retiredDeployment) {
        setErr({
          text: 'This vault was created under an older setup and can no longer be opened — press "Start a fresh vault".',
          action: { label: 'Start a fresh vault', run: () => void freshVault() },
        });
      } else {
        fail(e, 'Vault setup did not finish — nothing was saved.');
      }
    } finally {
      setBusy('');
    }
  };

  /* Fresh wallet: create, then link in the same chain — the wallet approves
     each transaction on its own. A create that discovers an existing vault
     (discovery can miss it) routes to the link step instead of failing. */
  const createVault = async (): Promise<void> => {
    if (!account?.address) return;
    if (addrMismatch) {
      setErr({
        text: 'The connected wallet is not the one you signed in with — switch wallet account, or sign out and sign back in.',
        action: { label: 'Sign out', run: () => void signOut() },
      });
      return;
    }
    setErr(null);
    setBusy('vault');
    try {
      let prep: Record<string, unknown> = {};
      try {
        prep = (await walletOnboardCreate()) as Record<string, unknown>;
      } catch (e) {
        if (e instanceof ApiError && (e.needsRelink || flagFrom(e, 'alreadyLinked'))) {
          // The vault already exists onchain — one link signature connects it.
          const s = await check();
          if (s && needOf(s) === 'ready') {
            onDone();
            return;
          }
          setAdvanced(1);
          await linkVault();
          return;
        }
        throw e;
      }
      if (prep.alreadyLinked === true) {
        await finish();
        return;
      }
      const txBytes = String(prep.txBytesBase64 ?? prep.txBytes ?? '');
      if (!txBytes) throw new Error('empty transaction');
      await signAndSubmit(txBytes);
      setAdvanced(2);
      // The vault needs its second step before saving switches on.
      const s = await check();
      if (s && (s.needsRelink || s.pendingPhase)) {
        await linkVault();
        return;
      }
      await finish();
    } catch (e) {
      if (isWalletCancel(e)) {
        setErr({
          text: 'Signature cancelled in your wallet — press again to retry',
          action: { label: 'Create my vault', run: () => void createVault() },
        });
      } else if (e instanceof ApiError && e.retiredDeployment) {
        setErr({
          text: 'This vault was created under an older setup and can no longer be opened — press "Start a fresh vault".',
          action: { label: 'Start a fresh vault', run: () => void freshVault() },
        });
      } else {
        fail(e, 'Vault setup did not finish — nothing was saved.');
      }
    } finally {
      setBusy('');
    }
  };

  /* Retired deployment: abandon the dead row, then create + link fresh. */
  const freshVault = async (): Promise<void> => {
    if (!account?.address) return;
    if (addrMismatch) {
      setErr({
        text: 'The connected wallet is not the one you signed in with — switch wallet account, or sign out and sign back in.',
        action: { label: 'Sign out', run: () => void signOut() },
      });
      return;
    }
    setErr(null);
    setBusy('reset');
    try {
      await walletReset();
      const s = await check();
      if (s && needOf(s) === 'ready') {
        onDone();
        return;
      }
      await createVault();
    } catch (e) {
      fail(e, 'The repair did not finish — nothing was saved.');
    }
  };

  /* A pending step that can no longer resume gets regenerated. */
  const resumeVault = async (): Promise<void> => {
    if (st?.pendingPhase === 'create') await createVault();
    else await linkVault();
  };

  const run = (): void => {
    if (need === 'sign') void signIn();
    else if (need === 'link') void linkVault();
    else if (need === 'create') void createVault();
    else if (need === 'fresh') void freshVault();
    else if (need === 'resume') void resumeVault();
    else onDone();
  };

  /* ------------------------------------------------------------------ view */
  const busyLabel = (): string => {
    if (busy === 'sign' || busy === 'approve') return 'Check your wallet';
    if (busy === 'vault') return 'Creating…';
    if (busy === 'link') return 'Connecting…';
    if (busy === 'reset') return 'Repairing…';
    if (busy === 'signout') return 'Signing out…';
    if (checking) return 'Checking your vault…';
    return LABEL[need];
  };

  const bodyCopy = (): string => HELP[need];

  return (
    <Dialog open={open} onClose={onClose} title={TITLE[need]} wide>
      {checked && steps.length > 2 && (
        <ol className="stepper" aria-label="Setup progress">
          {steps.map((label, i) => (
            <li
              key={label}
              className={i < stepIdx ? 'done' : i === stepIdx ? 'current' : 'todo'}
              aria-current={i === stepIdx ? 'step' : undefined}
            >
              <span className="step-n" aria-hidden="true">
                {i < stepIdx ? '✓' : i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
      )}

      <p className="step-help">
        {checking && !checked
          ? 'Checking what this wallet needs before anything else…'
          : bodyCopy()}
      </p>

      {err && (
        <p className="wallet-err" role="alert">
          {err.text}
          {err.action && (
            <Button
              variant="primary"
              onClick={err.action.run}
              disabled={!!busy}
            >
              {err.action.label}
            </Button>
          )}
        </p>
      )}

      {!account?.address && (
        <div className="wm-body">
          <p>Connect a Sui wallet to unlock a private vault for this family.</p>
          <ConnectButton connectText="Connect wallet" />
        </div>
      )}

      {account?.address && (
        <div className="wm-body">
          {need === 'sign' && (
            <p>
              One signature, no transaction, nothing spent — it proves this
              wallet is yours in this browser.
            </p>
          )}
          <Button
            variant="primary"
            onClick={run}
            disabled={!!busy || checking}
          >
            {busyLabel()}
          </Button>
        </div>
      )}

      <div className="wm-foot">
        <Button variant="quiet" onClick={onClose}>
          Skip for now
        </Button>
      </div>
    </Dialog>
  );
}
