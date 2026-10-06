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
  walletStatus,
} from './api';
import type { WalletStatus } from './api';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, FieldHint, Input, FieldLabel } from './ui';
import './WalletView.css';

const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/;

function errText(e: unknown): string {
  if (e instanceof ApiError) return `Server error (${e.status}): ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
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
  const [nonce, setNonce] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [addr, setAddr] = React.useState('');
  const [sig, setSig] = React.useState('');
  const [authBusy, setAuthBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);

  // onboarding wizard state
  const [step, setStep] = React.useState(0); // 0 create, 1 link
  const [txBytes, setTxBytes] = React.useState<string | null>(null);
  const [stepSig, setStepSig] = React.useState('');
  const [bytesMismatch, setBytesMismatch] = React.useState(false);
  const [stepBusy, setStepBusy] = React.useState(false);
  const [stepError, setStepError] = React.useState<string | null>(null);
  const [stepMsg, setStepMsg] = React.useState<string | null>(null);
  const [relinkMsg, setRelinkMsg] = React.useState<string | null>(null);
  const [relinkError, setRelinkError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setStatusError(null);
    try {
      setStatus(await walletStatus());
    } catch (e) {
      setStatusError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch a fresh server challenge without signing (used by the manual
  // fallback; nonces are single-use so every attempt needs a fresh one).
  async function fetchChallenge() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { nonce: n, message: m } = await authMessage();
      setNonce(n);
      setMessage(m);
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setAuthBusy(false);
    }
  }

  // Sign-in with the connected Sui wallet. The EXACT server message bytes are
  // signed (TextEncoder, no prefix tampering) and the wallet returns a base64
  // Sui personal-message signature — the format the server verifies with
  // verifyPersonalMessageSignature over authMessage(nonce) for a 0x{64}
  // address. Ethereum-style signatures can never satisfy that check.
  async function signInWithWallet() {
    if (!account) {
      setAuthError('Connect a Sui wallet first, then sign in.');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { nonce: n, message: m } = await authMessage();
      setNonce(n);
      setMessage(m);
      const { signature } = await signPersonalMessage.mutateAsync({
        message: new TextEncoder().encode(m),
      });
      const res = await authVerify(account.address, signature, n);
      if (!res.ok) throw new Error('Server did not confirm sign-in.');
      setNonce(null);
      setMessage(null);
      setSig('');
      await refresh();
      onAuth();
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setAuthBusy(false);
    }
  }

  // Manual fallback: accepts ONLY Sui-format credentials (0x{64} address +
  // base64 Sui personal-message signature over the message above). There is no
  // Ethereum path — an eth signature can never verify server-side.
  async function manualVerify() {
    if (!nonce) {
      setAuthError('Get a sign-in message first — nonces are single-use.');
      return;
    }
    const a = addr.trim();
    const s = sig.trim();
    if (!SUI_ADDR_RE.test(a)) {
      setAuthError('That is not a Sui address (expected 0x followed by 64 hex chars).');
      return;
    }
    if (s.length < 50) {
      setAuthError('That signature is too short to be a Sui signature (expected base64).');
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await authVerify(a, s, nonce);
      if (!res.ok) throw new Error('Server did not confirm sign-in.');
      setNonce(null);
      setMessage(null);
      setSig('');
      await refresh();
      onAuth();
    } catch (e) {
      setAuthError(errText(e));
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
      setStepError(errText(e));
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
      setStepError('Connect a Sui wallet first.');
      return;
    }
    setStepBusy(true);
    setStepError(null);
    setBytesMismatch(false);
    try {
      const tx = Transaction.from(txBytes);
      const { bytes, signature } = await signTransaction.mutateAsync({ transaction: tx });
      if (bytes !== txBytes) setBytesMismatch(true);
      setStepSig(signature);
    } catch (e) {
      setStepError(errText(e));
    } finally {
      setStepBusy(false);
    }
  }

  async function finishStep(kind: 'create' | 'link') {
    if (!stepSig.trim()) {
      setStepError('Sign the transaction in your Sui wallet first.');
      return;
    }
    setStepBusy(true);
    setStepError(null);
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
        setStepMsg(`Onboarding complete${doneId ? ` — account ${doneId}` : ''}.`);
      }
      await refresh();
      onAuth();
    } catch (e) {
      setStepError(errText(e));
    } finally {
      setStepBusy(false);
    }
  }

  async function doRelink() {
    setRelinkMsg(null);
    setRelinkError(null);
    try {
      const out = (await relink()) as {
        ok: boolean;
        accountId?: string;
        alreadyLinked?: boolean;
        needsDelegateLink?: boolean;
      };
      if (out?.needsDelegateLink) {
        setStep(1);
        setRelinkMsg(
          `Found onchain account${out.accountId ? ` ${out.accountId}` : ''} but this server has no delegate key — run the link step below.`,
        );
      } else {
        setRelinkMsg(
          `Relink accepted${out?.accountId ? ` — account ${out.accountId}` : ''}${out?.alreadyLinked ? ' (already linked).' : '.'}`,
        );
      }
      await refresh();
      onAuth();
    } catch (e) {
      setRelinkError(errText(e));
    }
  }

  const stepName = step === 0 ? 'create' : 'link';

  return (
    <div className="wallet">
      <Card>
        <CardHeader>
          <CardTitle>Wallet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="muted">Acting as <span className="mono">{userId}</span>. Sign-in binds this browser session to your Sui wallet address.</p>
          {loading ? (
            <p className="muted">Checking wallet status…</p>
          ) : statusError ? (
            <Alert variant="danger">{statusError}</Alert>
          ) : (
            <p className="status-row">
              <Badge variant={signedIn ? 'ok' : 'default'}>{signedIn ? 'signed in' : 'signed out'}</Badge>
              {signedIn && status?.address ? <span className="mono">{status.address}</span> : null}
              {signedIn ? (
                <Badge variant={onboarded ? 'mainnet' : 'warn'}>{onboarded ? 'onboarded' : 'not onboarded'}</Badge>
              ) : null}
              {status?.staleSession ? <Badge variant="warn">stale session</Badge> : null}
            </p>
          )}
          {account ? (
            <p className="muted">Connected Sui wallet: <span className="mono">{account.address}</span></p>
          ) : null}

          {!signedIn ? (
            <div className="stack">
              <div className="btn-row">
                <ConnectButton connectText="Connect Sui wallet" />
              </div>
              {noWalletInstalled ? (
                <FieldHint>No Sui wallet detected in this browser. Install one (e.g. Slush — https://slush.app) then connect.</FieldHint>
              ) : null}
              {account ? (
                <div className="stack">
                  <Button variant="primary" onClick={() => void signInWithWallet()} disabled={authBusy}>
                    {authBusy ? 'Signing…' : `Sign in as ${shortAddr(account.address)}`}
                  </Button>
                  <div className="btn-row">
                    <Button size="sm" onClick={() => void fetchChallenge()} disabled={authBusy}>
                      {message ? 'Retry with fresh message' : 'Get sign-in message'}
                    </Button>
                    <Button size="sm" onClick={() => void disconnectOnly()} disabled={authBusy || disconnectWallet.isPending}>
                      Disconnect wallet
                    </Button>
                  </div>
                </div>
              ) : null}
              {message ? (
                <div className="stack">
                  <FieldLabel>Sign this message (exact bytes)</FieldLabel>
                  <p className="mono msg">{message}</p>
                  <FieldHint>Your wallet signs these exact bytes. Nonces are single-use — if an attempt fails or expires, use “Retry with fresh message”.</FieldHint>
                </div>
              ) : null}
              <div className="stack">
                <FieldLabel htmlFor="w-addr">Manual fallback — Sui wallet address</FieldLabel>
                <Input id="w-addr" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x… (64 hex chars)" />
                <FieldLabel htmlFor="w-sig">Manual fallback — Sui signature (base64)</FieldLabel>
                <Input id="w-sig" value={sig} onChange={(e) => setSig(e.target.value)} placeholder="Base64 Sui personal-message signature" />
                <div className="btn-row">
                  {!message ? (
                    <Button size="sm" onClick={() => void fetchChallenge()} disabled={authBusy}>
                      Get sign-in message
                    </Button>
                  ) : null}
                  <Button onClick={() => void manualVerify()} disabled={authBusy || !nonce || !addr.trim() || !sig.trim()}>
                    Verify signature
                  </Button>
                </div>
                <FieldHint>Paste a Sui-format signature over the message above. Ethereum signatures cannot verify and are not accepted.</FieldHint>
              </div>
              {authError ? <Alert variant="danger">{authError}</Alert> : null}
            </div>
          ) : (
            <div className="stack">
              <div className="btn-row">
                <Button onClick={() => void signOut()} disabled={authBusy}>Sign out</Button>
                {account ? (
                  <Button size="sm" onClick={() => void disconnectOnly()} disabled={authBusy || disconnectWallet.isPending}>
                    Disconnect wallet
                  </Button>
                ) : null}
              </div>
              {authError ? <Alert variant="danger">{authError}</Alert> : null}
            </div>
          )}
        </CardContent>
      </Card>

      {signedIn && !onboarded ? (
        <Card>
          <CardHeader>
            <CardTitle>Onboarding ({stepName} — step {step + 1} of 2)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stack">
              <FieldHint>Onboarding submits real Sui mainnet transactions from your wallet (you pay gas). The server prepares each transaction; your wallet signs; the server submits and verifies onchain. No fake success is shown — every step reports the exact server result.</FieldHint>
              {!addrMatch ? (
                <Alert variant="warn">
                  {account
                    ? `Connected wallet ${shortAddr(account.address)} does not match the signed-in session ${sessionAddr ? shortAddr(sessionAddr) : '(unknown)'}. Switch wallet account or sign out and sign back in.`
                    : 'Connect the Sui wallet matching your signed-in session to continue onboarding.'}
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
                  <p className="muted">Sign this transaction in your Sui wallet:</p>
                  <p className="mono msg">{trunc(txBytes)}</p>
                  <div className="btn-row">
                    <Button size="sm" onClick={() => void copyTx()}>Copy full txBytes</Button>
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
                      <p className="mono msg">{trunc(stepSig)}</p>
                      <div className="btn-row">
                        <Button variant="primary" disabled={stepBusy} onClick={() => void finishStep(step === 0 ? 'create' : 'link')}>
                          {stepBusy ? 'Submitting…' : step === 0 ? 'Submit & create' : 'Submit & complete onboarding'}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {stepMsg ? <Alert variant="ok">{stepMsg}</Alert> : null}
              {stepError ? (
                <Alert variant="danger">
                  {stepError}
                  {/501|mainnet/i.test(stepError) ? ' Onboarding targets Sui mainnet and needs MEMWAL_MODE=mainnet plus SESSION_SECRET on the server.' : null}
                </Alert>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {signedIn ? (
        <Card>
          <CardHeader>
            <CardTitle>Relink</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stack">
              <p className="muted">If your session went stale or the link broke, request a fresh link. If the server finds your onchain account but no delegate key, you will be sent to the link step above.</p>
              <div><Button size="sm" onClick={() => void doRelink()}>Relink wallet</Button></div>
              {relinkMsg ? <Alert variant="ok">{relinkMsg}</Alert> : null}
              {relinkError ? <Alert variant="danger">{relinkError}</Alert> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
