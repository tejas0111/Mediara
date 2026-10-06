import React from 'react';
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
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, FieldLabel } from './ui';
import './WalletView.css';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown }) => Promise<unknown>;
    };
    sui?: {
      signAndExecuteTransaction?: (args: { transaction: string }) => Promise<{ signature?: string; digest?: string } & Record<string, unknown>>;
    };
  }
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return `Server error (${e.status}): ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

function trunc(tx: string): string {
  return tx.length > 140 ? `${tx.slice(0, 140)}…` : tx;
}

export default function WalletView({ userId, onAuth }: { userId: string; onAuth: () => void }) {
  const [status, setStatus] = React.useState<WalletStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [statusError, setStatusError] = React.useState<string | null>(null);

  // sign-in state
  const [nonce, setNonce] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [addr, setAddr] = React.useState('');
  const [sig, setSig] = React.useState('');
  const [authBusy, setAuthBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const hasEth = typeof window !== 'undefined' && !!window.ethereum;

  // onboarding wizard state
  const [step, setStep] = React.useState(0); // 0 create, 1 link, 2 complete
  const [txBytes, setTxBytes] = React.useState<string | null>(null);
  const [stepSig, setStepSig] = React.useState('');
  const [stepBusy, setStepBusy] = React.useState(false);
  const [stepError, setStepError] = React.useState<string | null>(null);
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

  async function startSignIn() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { nonce: n, message: m } = await authMessage();
      setNonce(n);
      setMessage(m);
      if (window.ethereum) {
        const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
        const account = accounts?.[0] ?? '';
        if (!account) throw new Error('No Ethereum account available.');
        setAddr(account);
        const signature = (await window.ethereum.request({
          method: 'personal_sign',
          params: [m, account],
        })) as string;
        const res = await authVerify(account, signature, n);
        if (!res.ok) throw new Error('Server did not confirm sign-in.');
        setNonce(null);
        setMessage(null);
        await refresh();
        onAuth();
      }
      // Without window.ethereum the manual address/signature form below is used.
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function manualVerify() {
    if (!nonce) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await authVerify(addr.trim(), sig.trim(), nonce);
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
      setStatus(null);
      await refresh();
      onAuth();
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setAuthBusy(false);
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

  async function trySuiSign(tx: string): Promise<string | null> {
    const fn = window.sui?.signAndExecuteTransaction;
    if (!fn) return null;
    try {
      const res = await fn.call(window.sui, { transaction: tx });
      if (typeof res?.signature === 'string' && res.signature) return res.signature;
      return null;
    } catch {
      return null;
    }
  }

  async function runStep(kind: 'create' | 'link') {
    setStepBusy(true);
    setStepError(null);
    setTxBytes(null);
    try {
      const res = kind === 'create' ? await onboardCreate() : await onboardLink();
      const tx = String(res.txBytes ?? '');
      if (!tx) throw new Error('Server returned no transaction bytes.');
      const auto = await trySuiSign(tx);
      if (auto) {
        // Wallet signed it — advance immediately, no fake state: completion
        // of the full flow still requires the explicit complete step.
        setTxBytes(tx);
        setStepSig(auto);
        setStep(kind === 'create' ? 1 : 2);
      } else {
        setTxBytes(tx);
      }
    } catch (e) {
      setStepError(errText(e));
    } finally {
      setStepBusy(false);
    }
  }

  function advance(tx: string) {
    // Manual path: user pastes the wallet signature, then moves on.
    if (!stepSig.trim()) {
      setStepError('Paste the signature from your Sui wallet to continue.');
      return;
    }
    void tx;
    setStepError(null);
    setStep((s) => Math.min(s + 1, 2));
    setTxBytes(null);
  }

  async function finish() {
    if (!stepSig.trim()) {
      setStepError('Paste the signature from your Sui wallet to finish.');
      return;
    }
    setStepBusy(true);
    setStepError(null);
    try {
      const res = await onboardComplete(stepSig.trim());
      if (!res.ok) throw new Error('Server did not confirm onboarding.');
      setStep(0);
      setTxBytes(null);
      setStepSig('');
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
      await relink();
      setRelinkMsg('Relink request accepted.');
      await refresh();
      onAuth();
    } catch (e) {
      setRelinkError(errText(e));
    }
  }

  const signedIn = !!status?.signedIn;
  const onboarded = !!status?.onboarded;

  return (
    <div className="wallet">
      <Card>
        <CardHeader>
          <CardTitle>Wallet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="muted">Acting as <span className="mono">{userId}</span>. Sign-in binds this browser session to your wallet address.</p>
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

          {!signedIn ? (
            <div className="stack">
              <Button variant="primary" onClick={() => void startSignIn()} disabled={authBusy || loading}>
                {authBusy ? 'Starting sign-in…' : 'Sign in with wallet'}
              </Button>
              {message ? (
                <div className="stack">
                  <FieldLabel>Sign this message</FieldLabel>
                  <p className="mono msg">{message}</p>
                  {!hasEth ? (
                    <>
                      <FieldLabel htmlFor="w-addr">Wallet address</FieldLabel>
                      <Input id="w-addr" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" />
                      <FieldLabel htmlFor="w-sig">Signature (personal_sign of the message above)</FieldLabel>
                      <Input id="w-sig" value={sig} onChange={(e) => setSig(e.target.value)} placeholder="0x…" />
                      <Button onClick={() => void manualVerify()} disabled={authBusy || !addr.trim() || !sig.trim()}>
                        Verify signature
                      </Button>
                    </>
                  ) : (
                    <p className="muted">Waiting for your Ethereum wallet… approve the personal_sign prompt.</p>
                  )}
                </div>
              ) : null}
              {authError ? <Alert variant="danger">{authError}</Alert> : null}
            </div>
          ) : (
            <div className="stack">
              <Button onClick={() => void signOut()} disabled={authBusy}>Sign out</Button>
              {authError ? <Alert variant="danger">{authError}</Alert> : null}
            </div>
          )}
        </CardContent>
      </Card>

      {signedIn && !onboarded ? (
        <Card>
          <CardHeader>
            <CardTitle>Onboarding ({['create', 'link', 'complete'][step]} — step {step + 1} of 3)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stack">
              {step < 2 ? (
                <>
                  <Button
                    variant="primary"
                    disabled={stepBusy}
                    onClick={() => void runStep(step === 0 ? 'create' : 'link')}
                  >
                    {stepBusy ? 'Requesting transaction…' : step === 0 ? 'Start: create account' : 'Next: link account'}
                  </Button>
                  {txBytes ? (
                    <div className="stack">
                      <p className="muted">Sign this transaction in your Sui wallet:</p>
                      <p className="mono msg">{trunc(txBytes)}</p>
                      <div className="btn-row">
                        <Button size="sm" onClick={() => void copyTx()}>Copy full txBytes</Button>
                      </div>
                      <FieldLabel htmlFor="w-stepsig">Signature from your Sui wallet</FieldLabel>
                      <Input
                        id="w-stepsig"
                        value={stepSig}
                        onChange={(e) => setStepSig(e.target.value)}
                        placeholder="Paste signature here"
                      />
                      <Button disabled={stepBusy || !stepSig.trim()} onClick={() => advance(txBytes)}>
                        Continue
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  {txBytes ? <p className="mono msg">{trunc(txBytes)}</p> : null}
                  <FieldLabel htmlFor="w-finalsig">Final signature</FieldLabel>
                  <Input
                    id="w-finalsig"
                    value={stepSig}
                    onChange={(e) => setStepSig(e.target.value)}
                    placeholder="Paste signature here"
                  />
                  <Button variant="primary" disabled={stepBusy} onClick={() => void finish()}>
                    {stepBusy ? 'Completing…' : 'Complete onboarding'}
                  </Button>
                </>
              )}
              {stepError ? <Alert variant="danger">{stepError}</Alert> : null}
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
              <p className="muted">If your session went stale or the link broke, request a fresh link.</p>
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
