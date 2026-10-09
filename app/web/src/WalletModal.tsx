import { useState } from 'react';
import { useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit';
import { ConnectButton } from '@mysten/dapp-kit';
import {
  ApiError,
  authMessage,
  authVerify,
  walletOnboardComplete,
  walletOnboardCreate,
  walletOnboardLink,
} from './api';
import { Button, Dialog } from './ui';

/* First-run guide: connect → sign → vault → chat. One numbered story with
   one primary action per step; skippable — the full Wallet view stays
   available for anything unfinished. */
const STEPS = ['Connect wallet', 'Sign message', 'Vault setup', 'Done'];

const STEP_HELP = [
  'Connect a Sui wallet — it becomes the key to your private vault. Next, you sign one message.',
  'Sign one message to prove the wallet is yours — nothing is spent. Next, your vault is created.',
  'Create your vault — private memories save here from now on. Next, you are done and can chat.',
  'Everything is ready — teach a memory in chat and every answer is checked against it.',
];

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
  const [busy, setBusy] = useState('');
  const [signed, setSigned] = useState(false);
  const [vaultDone, setVaultDone] = useState(false);
  const [err, setErr] = useState('');

  const step = !account?.address ? 0 : !signed ? 1 : !vaultDone ? 2 : 3;

  const isWalletCancel = (e: unknown): boolean =>
    /reject|denied|cancel|closed|dismiss|popup/i.test(
      String((e as { message?: unknown })?.message ?? e),
    );

  const sign = async () => {
    if (!account?.address) return;
    setErr('');
    setBusy('sign');
    try {
      const { nonce, message } = await authMessage();
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(message),
      });
      await authVerify(account.address, signature, nonce);
      setSigned(true);
    } catch (e) {
      if (isWalletCancel(e)) {
        setErr('Signature cancelled in your wallet — press again to retry');
      } else {
        setErr(
          e instanceof ApiError
            ? e.message
            : 'The signature was not completed in the wallet.',
        );
      }
    } finally {
      setBusy('');
    }
  };

  const setupVault = async () => {
    setErr('');
    setBusy('vault');
    try {
      await walletOnboardCreate();
      await walletOnboardLink();
      await walletOnboardComplete();
      setVaultDone(true);
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : 'Vault setup did not finish — the Wallet view can resume it.',
      );
    } finally {
      setBusy('');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Set up private memory" wide>
      <ol className="stepper" aria-label="Setup progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={i < step ? 'done' : i === step ? 'current' : 'todo'}
            aria-current={i === step ? 'step' : undefined}
          >
            <span className="step-n" aria-hidden="true">
              {i < step ? '✓' : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <p className="step-help">{STEP_HELP[step]}</p>

      {err && (
        <p className="wallet-err" role="alert">
          {err}
        </p>
      )}

      {step === 0 && (
        <div className="wm-body">
          <p>Connect a Sui wallet to unlock a private vault for this family.</p>
          <ConnectButton connectText="Connect wallet" />
        </div>
      )}

      {step === 1 && (
        <div className="wm-body">
          <p>One signature proves the wallet is yours. Nothing is spent.</p>
          <Button variant="primary" onClick={sign} disabled={!!busy}>
            {busy === 'sign' ? 'Check your wallet' : 'Sign the message'}
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="wm-body">
          <p>
            Create the vault where your private memories live, so answers can
            be checked against them.
          </p>
          <Button variant="primary" onClick={setupVault} disabled={!!busy}>
            {busy === 'vault' ? 'Setting up…' : 'Create my vault'}
          </Button>
        </div>
      )}

      {step === 3 && (
        <div className="wm-body">
          <p>
            You're set — teach me a medication, an allergy, or a routine and
            I'll check every future answer against it.
          </p>
          <Button variant="primary" onClick={onDone}>
            Back to chat
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
