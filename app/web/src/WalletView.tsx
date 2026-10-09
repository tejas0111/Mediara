import React from 'react';
import {
  ConnectButton,
  useCurrentAccount,
  useDisconnectWallet,
  useSignPersonalMessage,
  useSignTransaction,
  useWallets,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import {
  ApiError,
  authLogout,
  authMessage,
  authVerify,
  onboardComplete,
  onboardCreate,
  onboardLink,
  relink,
  resetVault,
  walletStatus,
} from './api';
import type { WalletStatus } from './api';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FieldHint, IconCheck, Input, FieldLabel, Skeleton } from './ui';
import './WalletView.css';

function statusOf(e: unknown): number | null {
  if (e instanceof ApiError) return e.status;
  return null;
}

function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message || 'Request failed.';
    if (e.status === 401) return `Your session expired — sign in again. (${msg})`;
    if (e.status === 409) return msg;
    if (e.status === 429) return `${msg} — please wait, then try again.`;
    if (e.status === 501) return `${msg} Onboarding needs the Mainnet backend with wallet support.`;
    if (e.status === 503) return `${msg} — please retry in a moment.`;
    return `Server error (${e.status}): ${msg}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function errText(e: unknown): string {
  return friendlyError(e);
}

function trunc(tx: string): string {
  return tx.length > 140 ? `${tx.slice(0, 140)}…` : tx;
}

function shortAddr(a: string): string {
  return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function WalletView({ userId, onAuth }: { userId: string; onAuth: () => void }) {
  const [status, setStatus] = React.useState<WalletStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [statusError, setStatusError] = React.useState<string | null>(null);

  // dAppKit wallet state (real Sui wallet: Sui Wallet, Slush, …).
  const account = useCurrentAccount();
  const wallets = useWallets();
  const disconnectWallet = useDisconnectWallet();
  const signPersonalMessage = useSignPersonalMessage();
  const signTransaction = useSignTransaction();
  const noWalletInstalled = wallets.length === 0;

  // sign-in state
  const [authBusy, setAuthBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [authStatus, setAuthStatus] = React.useState<number | null>(null);

  // onboarding wizard state
  const [step, setStep] = React.useState(0); // 0 create, 1 link
  const [txBytes, setTxBytes] = React.useState<string | null>(null);
  const [stepSig, setStepSig] = React.useState('');
  const [bytesMismatch, setBytesMismatch] = React.useState(false);
  const [stepBusy, setStepBusy] = React.useState(false);
  const [stepError, setStepError] = React.useState<string | null>(null);
  const [stepStatus, setStepStatus] = React.useState<number | null>(null);
  const [stepMsg, setStepMsg] = React.useState<string | null>(null);
  const [relinkMsg, setRelinkMsg] = React.useState<string | null>(null);
  const [relinkError, setRelinkError] = React.useState<string | null>(null);
  const [relinkBusy, setRelinkBusy] = React.useState(false);
  const [freshBusy, setFreshBusy] = React.useState(false);
  // Repair mode: an onboarded vault whose stored delegate key the relayer
  // rejects (Relink detects the dead key). The step UI below is gated on
  // !onboarded, so without this the link step could never be reached.
  const [linkRepair, setLinkRepair] = React.useState(false);
  // Retired deployment: the stored vault predates the live chain deployment
  // and can never link — offer an explicit fresh start instead of dead ends.
  const [retiredDeployment, setRetiredDeployment] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setStatusError(null);
    try {
      const st = await walletStatus();
      setStatus(st);
      // Resume: a tab closed mid-flow leaves a server-side pending step. Point
      // the wizard at it so the next action (regenerate + sign + submit) is
      // visible instead of silently resetting to step 1.
      if (st.pendingPhase === 'link') setStep(1);
      else if (st.pendingPhase === 'create') setStep(0);
    } catch (e) {
      setStatusError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sign-in with the connected Sui wallet. The EXACT server message bytes are
  // signed (TextEncoder, no prefix tampering) and the wallet returns a base64
  // Sui personal-message signature — the format the server verifies with
  // verifyPersonalMessageSignature over authMessage(nonce) for a 0x{64}
  // address. Ethereum-style signatures can never satisfy that check.
  async function signInWithWallet() {
    if (!account) {
      setAuthError('Connect a wallet first, then sign in.');
      setAuthStatus(null);
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthStatus(null);
    try {
      const { nonce: n, message: m } = await authMessage();
      const { signature } = await signPersonalMessage.mutateAsync({
        message: new TextEncoder().encode(m),
      });
      const res = await authVerify(account.address, signature, n);
      if (!res.ok) throw new Error('Server did not confirm sign-in.');
      await refresh();
      onAuth();
    } catch (e) {
      setAuthError(friendlyError(e));
      setAuthStatus(statusOf(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authLogout();
      try {
        await disconnectWallet.mutateAsync();
      } catch {
        /* wallet already disconnected — server session is still cleared above */
      }
      setStatus(null);
      await refresh();
      onAuth();
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function disconnectOnly() {
    try {
      await disconnectWallet.mutateAsync();
    } catch (e) {
      setAuthError(errText(e));
    }
  }

  async function copyTx() {
    if (!txBytes) return;
    try {
      await navigator.clipboard.writeText(txBytes);
    } catch {
      /* clipboard unavailable — user can select the text manually */
    }
  }

  const signedIn = !!status?.signedIn;
  const onboarded = !!status?.onboarded;
  // Vault is ready only when the server can act as delegate AND no step is
  // still pending AND no re-link is required. A dead delegate key must never
  // show a green ready badge.
  const needsRelinkFlag = !!status?.needsRelink;
  const pendingPhase = status?.pendingPhase ?? null;
  const vaultReady = onboarded && !needsRelinkFlag && !pendingPhase;
  const vaultLabel = vaultReady
    ? 'Memory vault ready'
    : needsRelinkFlag
      ? 'Vault action needed'
      : pendingPhase
        ? `Setup paused at ${pendingPhase}`
        : 'Vault setup needed';
  const sessionAddr = status?.address ?? null;
  const walletAddr = account?.address ?? null;
  const addrMatch =
    !!sessionAddr && !!walletAddr && sessionAddr.toLowerCase() === walletAddr.toLowerCase();

  // Onboarding step 1: fetch tx bytes the wallet must sign. The server builds
  // the tx with sender = the signed-in session address and stores the bytes as
  // pending; the signature is submitted via the complete step, which the server
  // executes itself (executeSigned) and verifies onchain. Retry = press again
  // (a fresh prepare regenerates the pending bytes).
  async function runStep(kind: 'create' | 'link') {
    if (!addrMatch) {
      setStepError(
        `The connected wallet (${walletAddr ? shortAddr(walletAddr) : 'none'}) does not match the signed-in session (${sessionAddr ? shortAddr(sessionAddr) : 'none'}). Switch wallet account or sign out first.`,
      );
      return;
    }
    setStepBusy(true);
    setStepError(null);
    setStepStatus(null);
    setStepMsg(null);
    setTxBytes(null);
    setStepSig('');
    setBytesMismatch(false);
    try {
      const res = kind === 'create' ? await onboardCreate() : await onboardLink();
      const tx = String(res.txBytesBase64 ?? res.txBytes ?? '');
      if (!tx) throw new Error('Server returned no transaction bytes.');
      setTxBytes(tx);
    } catch (e) {
      setStepError(friendlyError(e));
      setStepStatus(statusOf(e));
      if (e instanceof ApiError && (e.data as { retiredDeployment?: boolean })?.retiredDeployment === true) {
        setRetiredDeployment(true);
      }
    } finally {
      setStepBusy(false);
    }
  }

  // Sign the server-issued bytes with the connected wallet. Transaction.from
  // restores the exact built tx (sender is already set server-side); the
  // wallet returns the base64 signature the server executes — sign-only, the
  // server submits it in the complete step.
  async function signStepTx() {
    if (!txBytes) return;
    if (!account) {
      setStepError('Connect the wallet matching your signed-in session first.');
      setStepStatus(null);
      return;
    }
    setStepBusy(true);
    setStepError(null);
    setStepStatus(null);
    setBytesMismatch(false);
    try {
      const tx = Transaction.from(txBytes);
      const { bytes, signature } = await signTransaction.mutateAsync({ transaction: tx });
      if (bytes !== txBytes) setBytesMismatch(true);
      setStepSig(signature);
    } catch (e) {
      setStepError(friendlyError(e));
      setStepStatus(statusOf(e));
    } finally {
      setStepBusy(false);
    }
  }

  async function finishStep(kind: 'create' | 'link') {
    if (!stepSig.trim()) {
      setStepError('Sign the transaction in your wallet first.');
      setStepStatus(null);
      return;
    }
    setStepBusy(true);
    setStepError(null);
    setStepStatus(null);
    setStepMsg(null);
    try {
      const res = await onboardComplete(stepSig.trim());
      if (res && typeof res === 'object' && 'ok' in res && (res as { ok: boolean }).ok === false) {
        throw new Error('Server did not confirm onboarding.');
      }
      const next = (res as { nextStep?: string | null }).nextStep;
      const stage = (res as { stage?: string }).stage;
      const doneId = (res as { accountId?: string }).accountId;
      setStepSig('');
      setTxBytes(null);
      setBytesMismatch(false);
      if (kind === 'create' && next === 'link') {
        setStep(1);
        setStepMsg(
          `Account created${doneId ? ` (${doneId})` : ''}${stage ? ` — stage: ${stage}` : ''}. Now run the link step.`,
        );
      } else {
        setStep(0);
        setLinkRepair(false);
        setStepMsg(`Onboarding complete${doneId ? ` — account ${doneId}` : ''}.`);
      }
      await refresh();
      onAuth();
    } catch (e) {
      setStepError(friendlyError(e));
      setStepStatus(statusOf(e));
    } finally {
      setStepBusy(false);
    }
  }

  async function doFreshStart() {
    setRelinkError(null);
    setStepError(null);
    setStepStatus(null);
    setFreshBusy(true);
    try {
      await resetVault();
      setRetiredDeployment(false);
      setLinkRepair(false);
      setStep(0);
      setTxBytes(null);
      setStepSig('');
      setRelinkMsg('Old vault row abandoned — run create, then link, on the live deployment.');
      await refresh();
      onAuth();
    } catch (e) {
      setStepError(friendlyError(e));
      setStepStatus(statusOf(e));
    } finally {
      setFreshBusy(false);
    }
  }

  async function doRelink() {
    setRelinkMsg(null);
    setRelinkError(null);
    setRelinkBusy(true);
    try {
      const out = (await relink()) as {
        ok: boolean;
        accountId?: string;
        alreadyLinked?: boolean;
        needsDelegateLink?: boolean;
      };
      if (out?.needsDelegateLink) {
        setStep(1);
        setLinkRepair(true);
        setRelinkMsg(
          (out as { delegateRotated?: boolean })?.delegateRotated
            ? 'The stored vault key was rejected by the memory network — a fresh key is ready on the server. Run the link step below to register it.'
            : `Found onchain account${out.accountId ? ` ${out.accountId}` : ''} but this server has no delegate key — run the link step below.`,
        );
      } else {
        setRelinkMsg(
          `Relink accepted${out?.accountId ? ` — account ${out.accountId}` : ''}${out?.alreadyLinked ? ' (already linked).' : '.'}`,
        );
      }
      await refresh();
      onAuth();
    } catch (e) {
      setRelinkError(friendlyError(e));
    } finally {
      setRelinkBusy(false);
    }
  }

  const stepName = step === 0 ? 'create' : 'link';

  return (
    <div className="wallet">
      <p className="eyebrow">Account</p>
      <Card>
        <CardHeader>
          <CardTitle>Wallet</CardTitle>
          <CardDescription>
            You&apos;re chatting as <span className="mono">{userId}</span>. Signing in binds this browser
            to your Sui address and unlocks your private memory vault.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="stack" aria-busy="true">
              <Skeleton style={{ height: 22, width: '55%' }} />
              <Skeleton style={{ height: 40 }} />
            </div>
          ) : statusError ? (
            <div className="stack">
              <Alert variant="danger">{statusError}</Alert>
              <div className="btn-row">
                <Button size="sm" onClick={() => void refresh()}>Retry</Button>
              </div>
            </div>
          ) : signedIn ? (
            <div className="stack">
              <p className="signed-line">
                <IconCheck /> Signed in as{' '}
                <span className="mono" title={status?.address ?? ''}>{status?.address ? shortAddr(status.address) : 'unknown address'}</span>
              </p>
              <div className="btn-row">
                <Badge variant={vaultReady ? 'ok' : 'warn'}>{vaultLabel}</Badge>
                {status?.accountId ? (
                  <Badge variant="default" title={status.accountId}>Account {trunc(status.accountId)}</Badge>
                ) : null}
                <Button size="sm" onClick={() => void signOut()} disabled={authBusy}>
                  {authBusy ? 'Signing out…' : 'Sign out'}
                </Button>
              </div>
              {needsRelinkFlag ? (
                <Alert variant="warn">
                  This server has no usable key for your onchain account — the vault is not ready.
                  Run Relink below, then complete the link step.
                </Alert>
              ) : null}
              {pendingPhase ? (
                <Alert variant="warn">
                  Setup paused at the {pendingPhase} step. Continue in the setup section below — pressing
                  prepare again regenerates the transaction, nothing is lost.
                </Alert>
              ) : null}
              {account && status?.address && account.address.toLowerCase() !== status.address.toLowerCase() ? (
                <Alert variant="warn">
                  Connected wallet {shortAddr(account.address)} is not the signed-in one.{' '}
                  <Button size="sm" onClick={() => void disconnectOnly()}>Disconnect</Button>
                </Alert>
              ) : null}
              {authError ? (
                <Alert variant="danger">
                  {authError}
                  {authStatus === 401 ? ' Press Sign out, then sign in again.' : null}
                </Alert>
              ) : null}
            </div>
          ) : (
            <div className="stack">
              {!account ? (
                <div className="stack">
                  <div className="btn-row">
                    <span className="top-connect">
                      <ConnectButton connectText="Connect wallet" className="btn btn-sm wallet-btn" />
                    </span>
                  </div>
                  {noWalletInstalled ? (
                    <FieldHint>No wallet detected in this browser. Install a Sui wallet, then return here to connect.</FieldHint>
                  ) : (
                    <FieldHint>Connect your wallet to begin — signing in takes one more step after that.</FieldHint>
                  )}
                </div>
              ) : (
                <div className="stack">
                  <Button variant="primary" onClick={() => void signInWithWallet()} disabled={authBusy}>
                    {authBusy ? 'Check your wallet…' : `Sign in as ${shortAddr(account.address)}`}
                  </Button>
                  {authBusy ? (
                    <FieldHint>Approve the signature request in your wallet to finish signing in.</FieldHint>
                  ) : null}
                  {status?.staleSession ? (
                    <FieldHint>Your last session expired — signing in again takes one step.</FieldHint>
                  ) : null}
                  <div className="btn-row">
                    <Button size="sm" onClick={() => void disconnectOnly()} disabled={authBusy || disconnectWallet.isPending}>
                      Use a different wallet
                    </Button>
                  </div>
                </div>
              )}
              {authError ? (
                <Alert variant="danger">
                  {authError}
                  <span className="btn-row">
                    <Button size="sm" onClick={() => void signInWithWallet()} disabled={authBusy || !account}>Try signing in again</Button>
                  </span>
                </Alert>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {signedIn && (!vaultReady || linkRepair) ? (
        <Card>
          <CardHeader>
            <CardTitle>Vault setup ({stepName} — step {step + 1} of 2)</CardTitle>
            <CardDescription>
              Three steps: connect, sign a message, then set up the vault. This section is step 3.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="stack">
              <FieldHint>Setup submits network transactions from your wallet. The server prepares each transaction, your wallet signs it, and the server submits and verifies it. Every step reports the exact server result.</FieldHint>
              {pendingPhase ? (
                <Alert variant="warn">
                  You have a pending {pendingPhase} transaction from an earlier visit — press {pendingPhase === 'link' ? '“Next: link account”' : '“Start: create account”'} again to regenerate it (old bytes are replaced, nothing is lost), then sign and submit.
                </Alert>
              ) : null}
              {needsRelinkFlag && !linkRepair ? (
                <Alert variant="warn">
                  Your account exists but this server holds no usable key. Press “Relink wallet” below first —
                  you will be sent back here to the link step.
                </Alert>
              ) : null}
              {!addrMatch ? (
                <Alert variant="warn">
                  {account
                    ? `Connected wallet ${shortAddr(account.address)} does not match the signed-in session ${sessionAddr ? shortAddr(sessionAddr) : '(unknown)'}. Switch wallet account or sign out and sign back in.`
                    : 'Connect the wallet matching your signed-in session to continue setup.'}
                </Alert>
              ) : null}
              <div className="btn-row">
                <Button
                  variant="primary"
                  disabled={stepBusy || !addrMatch}
                  onClick={() => void runStep(step === 0 ? 'create' : 'link')}
                >
                  {stepBusy ? 'Requesting transaction…' : step === 0 ? 'Start: create account' : 'Next: link account'}
                </Button>
              </div>
              {txBytes ? (
                <div className="stack">
                  <p className="muted">Sign this transaction in your wallet:</p>
                  <p className="mono msg" title={txBytes}>{trunc(txBytes)}</p>
                  <div className="btn-row">
                    <Button size="sm" onClick={() => void copyTx()}>Copy full transaction bytes</Button>
                    <Button size="sm" variant="primary" onClick={() => void signStepTx()} disabled={stepBusy || !addrMatch}>
                      {stepBusy ? 'Waiting for wallet…' : stepSig ? 'Re-sign in wallet' : 'Sign in wallet'}
                    </Button>
                  </div>
                  {bytesMismatch ? (
                    <Alert variant="warn">The wallet returned different bytes than the server issued. Submitting may fail — the exact server error will be shown.</Alert>
                  ) : null}
                  {stepSig ? (
                    <div className="stack">
                      <FieldLabel htmlFor="w-stepsig">Wallet signature (base64)</FieldLabel>
                      <p className="mono msg" title={stepSig}>{trunc(stepSig)}</p>
                      <div className="btn-row">
                        <Button variant="primary" disabled={stepBusy} onClick={() => void finishStep(step === 0 ? 'create' : 'link')}>
                          {stepBusy ? 'Submitting…' : step === 0 ? 'Submit & create' : 'Submit & complete setup'}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {stepMsg ? <Alert variant="ok">{stepMsg}</Alert> : null}
              {stepError ? (
                <Alert variant="danger">
                  <span>{stepError}</span>
                  <span className="btn-row">
                    {stepStatus === 401 ? (
                      <Button size="sm" onClick={() => void signOut()}>Sign out, then sign in again</Button>
                    ) : null}
                    {stepStatus === 409 && step === 0 ? (
                      <Button size="sm" onClick={() => { setStep(1); setStepError(null); }}>Go to link step instead</Button>
                    ) : null}
                    <Button size="sm" onClick={() => void runStep(step === 0 ? 'create' : 'link')} disabled={stepBusy || !addrMatch}>Retry this step</Button>
                  </span>
                </Alert>
              ) : null}
              {retiredDeployment ? (
                <Alert variant="warn" role="alert">
                  <span>Your old vault was created under a retired deployment and cannot link. Starting fresh abandons the old row (its memories stay unreadable) and runs create + link on the live deployment.</span>
                  <span className="btn-row">
                    <Button size="sm" variant="primary" onClick={() => void doFreshStart()} disabled={freshBusy}>{freshBusy ? 'Starting fresh…' : 'Start a fresh vault'}</Button>
                  </span>
                </Alert>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {signedIn && vaultReady && !linkRepair ? (
        <Card>
          <CardHeader>
            <CardTitle>Vault details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="vault-meta">
              <div><dt>Signed-in address</dt><dd className="mono" title={status?.address ?? ''}>{status?.address ?? '—'}</dd></div>
              {status?.accountId ? <div><dt>Account</dt><dd className="mono">{status.accountId}</dd></div> : null}
              <div><dt>Status</dt><dd>Ready — chats save to your private vault.</dd></div>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {signedIn ? (
        <Card>
          <CardHeader>
            <CardTitle>Repair access</CardTitle>
            <CardDescription>If the vault stopped working, repair it here. Recovery never touches your address.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="stack">
              <p className="muted">If your session went stale or the link broke, request a fresh link. If the server finds your onchain account but no usable key, you will be sent to the link step above.</p>
              <div className="btn-row">
                <Button size="sm" variant="primary" onClick={() => void doRelink()} disabled={relinkBusy}>{relinkBusy ? 'Checking…' : 'Relink wallet'}</Button>
                <Button size="sm" onClick={() => void doFreshStart()} disabled={freshBusy} title="Abandon this server's vault row and set up again from scratch">{freshBusy ? 'Starting fresh…' : 'Start fresh vault'}</Button>
              </div>
              <FieldHint>Start fresh abandons this server&apos;s vault row and runs create + link again. Use it when the vault is from a retired deployment or cannot link.</FieldHint>
              {relinkMsg ? <Alert variant="ok">{relinkMsg}</Alert> : null}
              {relinkError ? (
                <Alert variant="danger">
                  <span>{relinkError}</span>
                  <span className="btn-row"><Button size="sm" onClick={() => void doRelink()} disabled={relinkBusy}>Retry relink</Button></span>
                </Alert>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
