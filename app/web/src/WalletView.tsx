import { useCallback, useEffect, useRef, useState } from 'react';
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
  walletRelink,
  walletReset,
  walletStatus,
  WalletStatus,
} from './api';
import { Button, Card, CardContent, CardHeader, CardTitle } from './ui';
import './WalletView.css';

const shortAddress = (a?: string | null): string =>
  a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';

/* One linear story: exactly one primary action is visible at a time. The
   stepper names the four states; the sentence below it says what THIS step
   does and what comes next. */
const STEPS = ['Connect wallet', 'Sign message', 'Vault setup', 'Done'];

const STEP_HELP = [
  'Connect a Sui wallet — it becomes the key to your private vault. Next, you sign one message.',
  'Sign one message to prove the wallet is yours — nothing is spent. Next, your vault is created.',
  'Create your vault — private memories save here from now on. Next, you are done and can chat.',
  'Everything is ready — teach a memory in chat and every answer is checked against it.',
];

/** Server vault-setup phases mapped to their position in the story. */
const phaseStep = (phase: string | null): number =>
  phase === 'create' ? 1 : phase === 'link' ? 2 : phase === 'complete' ? 3 : 2;

interface StepAction {
  label: string;
  run: () => void;
}

export default function WalletView({ onChanged }: { onChanged?: () => void }) {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [pending, setPending] = useState('');
  const [err, setErr] = useState<{ text: string; action?: StepAction } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      setStatus(await walletStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, account?.address]);

  /* Stale-page self-correction: a backgrounded page reloads fresh status
     when visible again instead of acting on old state. Skips while a
     wallet action is running so it can never loop or interrupt. */
  const pendingRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending !== '';
  }, [pending]);
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (pendingRef.current) return;
      void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged?.();
  };

  /* The wallet that signs must be the one the session belongs to. */
  const sessionAddr = status?.address ?? null;
  const walletAddr = account?.address ?? null;
  const addrMatch =
    !!sessionAddr &&
    !!walletAddr &&
    sessionAddr.toLowerCase() === walletAddr.toLowerCase();

  const guardSameWallet = (retry: StepAction): boolean => {
    if (addrMatch) return true;
    setErr({
      text: 'The connected wallet is not the one you signed in with — switch wallet account, or sign out and sign back in.',
      action: retry,
    });
    return false;
  };

  const isWalletCancel = (e: unknown): boolean =>
    /reject|denied|cancel|closed|dismiss|popup/i.test(
      String((e as { message?: unknown })?.message ?? e),
    );

  const cancelled = (retry: StepAction): void => {
    setErr({
      text: 'Signature cancelled in your wallet — press again to retry',
      action: retry,
    });
  };

  /* ---------------------------------------------------------- sign in */
  const signIn = async () => {
    if (!account?.address) return;
    setErr(null);
    setPending('sign');
    const retry: StepAction = {
      label: 'Sign in',
      run: () => void signIn(),
    };
    try {
      const { nonce, message } = await authMessage();
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(message),
      });
      await authVerify(account.address, signature, nonce);
      await refresh();
    } catch (e) {
      if (isWalletCancel(e)) cancelled(retry);
      else
        fail(e, 'The signature was not completed in the wallet.', retry);
    } finally {
      setPending('');
    }
  };

  const signOut = async () => {
    setPending('signout');
    try {
      await authLogout();
      await refresh();
    } finally {
      setPending('');
    }
  };

  /* One vault-setup step: the server prepares a transaction, the wallet
     signs it, and the server submits it. Nothing is signed or spent
     without the wallet's approval popup. */
  const signAndComplete = async (
    kind: 'create' | 'link',
    retry: StepAction,
  ): Promise<boolean> => {
    let txBytes = '';
    try {
      const prep =
        kind === 'create' ? await walletOnboardCreate() : await walletOnboardLink();
      const p = prep as Record<string, unknown>;
      if (p.alreadyLinked === true) {
        // Server self-heal: the link already landed earlier — nothing to sign.
        await refresh();
        return true;
      }
      txBytes = String(p.txBytesBase64 ?? p.txBytes ?? '');
      if (!txBytes) throw new Error('empty transaction');
    } catch (e) {
      if (e instanceof ApiError && e.retiredDeployment) {
        setStatus((s) => (s ? { ...s, retiredDeployment: true } : s));
        setErr(null);
      } else if (e instanceof ApiError && e.needsRelink && kind === 'create') {
        // The vault already exists onchain (discovery missed it): skip
        // straight to the link step instead of failing the setup.
        setErr(null);
        return signAndComplete('link', retry);
      } else {
        fail(e, 'Vault setup did not finish — nothing was saved.', retry);
      }
      return false;
    }
    setPending('approve');
    let signature = '';
    try {
      const out = await signTransaction({
        transaction: Transaction.from(txBytes),
      });
      signature = out.signature;
    } catch (e) {
      if (isWalletCancel(e)) cancelled(retry);
      else fail(e, 'The signature was not completed in the wallet.', retry);
      return false;
    }
    try {
      await walletOnboardCompleteSig(signature);
      await refresh();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.retiredDeployment) {
        setStatus((s) => (s ? { ...s, retiredDeployment: true } : s));
        setErr(null);
      } else {
        fail(e, 'Vault setup did not finish — nothing was saved.', retry);
      }
      return false;
    }
  };

  /* One smart setup action: reads fresh status first, then runs only the
     step that is still needed — so it can never fire the create chain when
     a usable vault already exists. */
  const setupVault = async () => {
    const retry: StepAction = {
      label: 'Try again',
      run: () => void setupVault(),
    };
    setErr(null);
    if (!guardSameWallet(retry)) return;
    setPending('vault');
    try {
      // Fresh status first: this page may hold pre-heal state while the
      // server already has a usable vault.
      const fresh = await walletStatus();
      setStatus(fresh);
      if (
        fresh?.onboarded &&
        !fresh?.needsRelink &&
        !fresh?.pendingPhase &&
        !fresh?.retiredDeployment
      ) {
        // Already usable — nothing to sign, just land on Done.
        await refresh();
        return;
      }
      if (fresh?.retiredDeployment) {
        // Needs the fresh-start card instead — refresh so it appears.
        await refresh();
        return;
      }
      if (fresh?.needsRelink || fresh?.pendingPhase) {
        const linkRetry: StepAction = {
          label: 'Continue',
          run: () => void setupVault(),
        };
        if (!guardSameWallet(linkRetry)) return;
        await signAndComplete('link', linkRetry);
        return;
      }
      const created = await signAndComplete('create', retry);
      if (!created) return;
      // The vault needs its second step before saving switches on — run it
      // in the same chain instead of landing back on an unfinished card.
      const st = await walletStatus();
      setStatus(st);
      if (!st?.onboarded || st?.needsRelink || st?.pendingPhase) {
        const linkRetry: StepAction = {
          label: 'Continue',
          run: () => void setupVault(),
        };
        if (!guardSameWallet(linkRetry)) return;
        await signAndComplete('link', linkRetry);
      } else {
        onChanged?.();
      }
    } catch (e) {
      // Self-correcting stale page: the server says a usable vault already
      // exists (e.g. healed/adopted since this page loaded) — refresh instead
      // of dead-ending; the stepper flips to Done on its own.
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        /already has a linked memory vault/i.test(e.message)
      ) {
        await refresh();
        return;
      }
      fail(e, 'Vault setup did not finish — nothing was saved.', retry);
    } finally {
      setPending('');
    }
  };

  /** Dead-link recovery: repair, then finish the link in the same chain so
      the card never loops back onto itself. */
  const linkRepair = async () => {
    const retry: StepAction = {
      label: 'Re-link vault',
      run: () => void linkRepair(),
    };
    setErr(null);
    if (!guardSameWallet(retry)) return;
    setPending('relink');
    try {
      const out = (await walletRelink()) as Record<string, unknown> | null;
      const st = await walletStatus();
      setStatus(st);
      onChanged?.();
      const stillBroken =
        out?.needsDelegateLink === true ||
        !!st?.needsRelink ||
        !!st?.pendingPhase;
      if (!stillBroken) {
        await refresh();
        return;
      }
      // The server restored the vault record but still needs the wallet's
      // signature — continue straight into approval in this same chain.
      await signAndComplete('link', retry);
    } catch (e) {
      if (e instanceof ApiError && e.retiredDeployment) {
        setStatus((s) => (s ? { ...s, retiredDeployment: true } : s));
        setErr(null);
      } else {
        fail(e, 'The re-link did not complete — saving is still paused.', retry);
      }
    } finally {
      setPending('');
    }
  };

  /** Retired deployment: self-healing repair — reset (skipped when a
      previous attempt already cleared it), then create + link again in one
      chain so the card never dead-ends. */
  const repairVault = async () => {
    const retry: StepAction = {
      label: 'Repair my vault',
      run: () => void repairVault(),
    };
    setErr(null);
    if (!guardSameWallet(retry)) return;
    try {
      setPending('reset');
      // Resume point: a fresh status tells us whether reset already landed.
      let st = await walletStatus();
      setStatus(st);
      if (st?.retiredDeployment) {
        await walletReset();
        st = await walletStatus();
        setStatus(st);
      }
      if (!st?.onboarded && !st?.pendingPhase && !st?.needsRelink) {
        const created = await signAndComplete('create', retry);
        if (!created) return;
        st = await walletStatus();
        setStatus(st);
      }
      if (!st?.onboarded || st?.needsRelink || st?.pendingPhase) {
        const linkRetry: StepAction = {
          label: 'Repair my vault',
          run: () => void repairVault(),
        };
        if (!guardSameWallet(linkRetry)) return;
        await signAndComplete('link', linkRetry);
      } else {
        onChanged?.();
      }
    } catch (e) {
      fail(e, 'The repair did not finish — nothing was saved.', retry);
    } finally {
      setPending('');
    }
  };

  /** A pending step that can no longer resume gets regenerated. */
  const regenerate = async () => {
    const phase = status?.pendingPhase;
    if (!phase) return;
    const retry: StepAction = {
      label: 'Try again',
      run: () => void regenerate(),
    };
    setErr(null);
    if (!guardSameWallet(retry)) return;
    setPending(phase);
    try {
      await signAndComplete(phase === 'create' ? 'create' : 'link', retry);
    } catch (e) {
      fail(e, 'Setup did not resume — nothing was saved.', retry);
    } finally {
      setPending('');
    }
  };

  /* Every failure pairs one plain sentence with one action (429 is a
     wait note, so it carries no button). */
  function fail(e: unknown, fallback: string, retry: StepAction): void {
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
            text: 'Your vault link broke — re-link it to resume saving.',
            action: { label: 'Re-link vault', run: () => void linkRepair() },
          });
        } else {
          setErr({
            text: 'No vault is linked yet — create one to start saving.',
            action: {
              label: 'Set up private memory',
              run: () => void setupVault(),
            },
          });
        }
        return;
      }
      if (e.status === 429) {
        setErr({ text: 'Too many tries — wait a little, then try again.' });
        return;
      }
      if (e.status === 503) {
        setErr({
          text: "The server didn't answer — nothing was saved.",
          action: retry,
        });
        return;
      }
    }
    setErr({ text: fallback, action: retry });
  }

  /* ------------------------------------------------------------ render */
  const signedIn = !!account?.address && !!status?.signedIn;
  const pendingPhase = status?.pendingPhase ?? null;
  const ready =
    signedIn &&
    !!status?.onboarded &&
    !status?.needsRelink &&
    !status?.retiredDeployment &&
    !pendingPhase;

  const stepIdx = !account?.address ? 0 : !signedIn ? 1 : ready ? 3 : 2;

  const statusLine = !account?.address
    ? 'No wallet connected yet.'
    : !signedIn
      ? 'Wallet connected — one signature left.'
      : status?.needsRelink
        ? 'Vault link broken — your sign-in works but saving is paused'
        : status?.retiredDeployment
          ? "This vault can't be reused — start a fresh one below."
          : pendingPhase
            ? 'Vault setup paused — continue below.'
            : !status?.onboarded
              ? 'No vault yet'
              : 'Vault ready — memories save here';

  const addr = status?.address ?? account?.address;

  return (
    <div className="wallet-wrap">
      <p className="wallet-intro">
        Signing in upgrades this browser from shared guest memory to a private
        vault only your wallet can open. No passwords — one signature proves
        it's you.
      </p>

      <ol className="stepper" aria-label="Setup progress">
        {STEPS.map((label, i) => (
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
      <p className="step-help">{STEP_HELP[stepIdx]}</p>

      {signedIn && addr && (
        <p className="wallet-status">
          Signed in as {shortAddress(addr)} (this browser)
        </p>
      )}
      <p className="wallet-status vault-status" role="status">
        {statusLine}
      </p>

      {err && (
        <div className="wallet-err" role="alert">
          <span>{err.text}</span>
          {err.action && (
            <Button
              variant="primary"
              onClick={err.action.run}
              disabled={!!pending}
            >
              {err.action.label}
            </Button>
          )}
        </div>
      )}

      {!account?.address && (
        <Card>
          <CardHeader>
            <CardTitle>Connect your Sui wallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted">
              Your wallet address becomes the key to your private memory vault.
            </p>
            <ConnectButton connectText="Connect wallet" />
          </CardContent>
        </Card>
      )}

      {account?.address && !signedIn && (
        <Card>
          <CardHeader>
            <CardTitle>Sign one message</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted">
              One signature, no transaction, nothing spent.
            </p>
            <Button variant="primary" onClick={signIn} disabled={!!pending}>
              {pending === 'sign'
                ? 'Check your wallet'
                : `Sign in as ${shortAddress(account.address)}`}
            </Button>
          </CardContent>
        </Card>
      )}

      {signedIn && status?.retiredDeployment && (
        <Card>
          <CardHeader>
            <CardTitle>Start a fresh vault</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted">
              This vault was set up under an older version and can no longer
              be opened. Repairing starts a fresh one for this wallet —
              anything saved in the old vault stays sealed where it is and
              nothing moves over.
            </p>
            <Button
              variant="primary"
              onClick={repairVault}
              disabled={!!pending}
            >
              {pending === 'approve'
                ? 'Approve in your wallet'
                : pending
                  ? 'Repairing…'
                  : 'Repair my vault'}
            </Button>
          </CardContent>
        </Card>
      )}

      {signedIn && status?.needsRelink && !status?.retiredDeployment && (
        <Card>
          <CardHeader>
            <CardTitle>Vault link broken</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted">
              The saved connection to your vault stopped working — your sign-in
              still works, but new memories can't be saved until you re-link.
            </p>
            <Button variant="primary" onClick={linkRepair} disabled={!!pending}>
              {pending === 'relink'
                ? 'Re-linking…'
                : pending === 'approve'
                  ? 'Approve in your wallet'
                  : 'Re-link vault'}
            </Button>
          </CardContent>
        </Card>
      )}

      {signedIn && pendingPhase && !status?.retiredDeployment && (
        <Card>
          <CardHeader>
            <CardTitle>Setup paused</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted">
              Vault setup didn't finish — your sign-in still works, but nothing
              is saved yet.
            </p>
            <Button variant="primary" onClick={regenerate} disabled={!!pending}>
              {pending
                ? pending === 'approve'
                  ? 'Approve in your wallet'
                  : 'Working…'
                : `Setup stopped at step ${phaseStep(pendingPhase)} — Continue`}
            </Button>
          </CardContent>
        </Card>
      )}

      {signedIn &&
        !status?.onboarded &&
        !status?.needsRelink &&
        !status?.retiredDeployment &&
        !pendingPhase && (
          <Card>
            <CardHeader>
              <CardTitle>Set up private memory</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="muted">
                One step creates your private vault and switches saving on.
              </p>
              <Button variant="primary" onClick={setupVault} disabled={!!pending}>
                {pending === 'vault'
                  ? 'Creating…'
                  : pending === 'approve'
                    ? 'Approve in your wallet'
                    : 'Set up private memory'}
              </Button>
            </CardContent>
          </Card>
        )}

      {signedIn && (
        <div className="btn-row signout-row">
          <Button variant="quiet" onClick={signOut} disabled={!!pending}>
            {pending === 'signout' ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      )}
    </div>
  );
}
