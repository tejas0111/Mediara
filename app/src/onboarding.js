// Onboarding orchestrator (DoseDaughter).
// Flow — the visitor's wallet signs and PAYS every transaction (v1 relayer
// model: users own and fund their memory; the bot holds NO wallet power):
//   fresh user:  tx 1 create_account  →  tx 2 add_delegate_key (link us)
//   existing:    tx 1 add_delegate_key only
// After linking, the server talks Walrus Memory AS THE USER's delegate —
// memory lives in the user's own MemWalAccount, Seal-encrypted on Walrus.
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateDelegateKey } from '@mysten-incubation/memwal/account';
import {
  buildCreateAccountTx,
  buildLinkDelegateTx,
  accountForOwner,
  verifyAccount,
  executeSigned,
} from './onchain.js';
import { upsertUser, markAccountLinked, getUser, getRawUser } from './userRegistry.js';

const MODE = process.env.MEMWAL_MODE === 'mainnet' ? 'mainnet' : 'local';

// Graphql client is only used for tx byte building (tx.build({ client })).
function buildClient() {
  return new SuiGraphQLClient({ url: process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });
}

// Client-state errors (user skipped a step / wrong order) carry a status so the
// route returns 4xx, not a misleading 500.
function clientError(message, status = 409) { const e = new Error(message); e.status = status; e.expose = true; return e; }

function keypairFromHexPrivateKey(hex) {
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(String(hex).replace(/^0x/, ''), 'hex')));
}

export async function walletStatus(address) {
  const user = getUser(address);
  let onchain = null;
  // Local mode must not make outbound Sui-mainnet calls (status is on every
  // signed-in page load); registry-only is enough offline.
  if (!user?.accountId && MODE === 'mainnet') onchain = await accountForOwner(address);
  const accountId = user?.accountId || onchain?.accountId || null;
  // "onboarded" means THIS server can act as the user's delegate: an account id
  // AND a delegate key on file. An account that exists onchain without a stored
  // delegate key is NOT usable — the user must (re)link, not just view.
  const hasDelegate = Boolean(user?.accountId && user?.delegatePrivateKey);
  return {
    address,
    onboarded: hasDelegate,
    // true => account exists onchain but this server has no usable delegate row
    // (e.g. redeploy lost the registry): user needs the LINK step, not create.
    needsRelink: Boolean(!hasDelegate && accountId),
    accountId,
  };
}

// --- Step 1a (fresh user): build create_account tx for the wallet to sign.
export async function prepareCreateAccount(address) {
  if (MODE !== 'mainnet') throw clientError('Wallet onboarding requires MEMWAL_MODE=mainnet (Sui Mainnet). Local mode is a keyless demo only.', 501);
  // NEVER clobber a working vault. Use the RAW row: getUser() returns null when a
  // row exists but its key can't be decrypted (e.g. rotated SESSION_SECRET), and
  // trusting that null would overwrite accountId with null and brick the user.
  const raw = getRawUser(address);
  if (raw?.accountId && !getUser(address)) {
    throw clientError('Registry key cannot be decrypted (SESSION_SECRET changed) — re-link required; refusing to overwrite the existing vault.', 409);
  }
  if (raw?.accountId && raw?.delegatePrivateKey && !raw.pendingPhase) {
    throw clientError('This wallet already has a linked memory vault — use the link step (or re-link) instead of create.', 409);
  }
  const delegate = await generateDelegateKey();
  const delegatePublicKeyHex = Buffer.from(delegate.publicKey).toString('hex');
  const tx = buildCreateAccountTx(address);
  const bytes = await tx.build({ client: buildClient() });
  const txBytesBase64 = Buffer.from(bytes).toString('base64');
  // Persist BEFORE the signature is requested. If the tab closes mid-flow,
  // the delegate keypair is already durably stored; a re-prepare regenerates
  // a fresh pair (last one wins) and any stale signed tx fails onchain.
  upsertUser({
    address,
    accountId: raw?.accountId ?? null, // never downgrade a stored accountId
    delegatePrivateKey: delegate.privateKey,
    delegatePublicKey: delegatePublicKeyHex,
    delegateAddress: delegate.suiAddress,
    pendingPhase: 'create',
    pendingTxBytes: txBytesBase64,
  });
  return { txBytesBase64, delegateAddress: delegate.suiAddress };
}

// --- Step 1b (existing account, or fresh user after tx 1 landed): link tx.
export async function prepareLinkDelegate(address) {
  if (MODE !== 'mainnet') throw clientError('Wallet onboarding requires MEMWAL_MODE=mainnet (Sui Mainnet). Local mode is a keyless demo only.', 501);
  const user = getUser(address);
  let accountId = user?.accountId || (await accountForOwner(address))?.accountId || null;
  if (!accountId) throw clientError('No MemWalAccount found for this address — create one first', 409);
  // Recovery path: if we have an onchain account but no delegate key on file
  // (registry row lost on redeploy), generate + persist a fresh key now and link
  // it. Without this, a "needsRelink" user could never become usable again.
  let delegatePrivateKey = user?.delegatePrivateKey;
  let delegatePublicKeyHex = user?.delegatePublicKey;
  let delegateAddress = user?.delegateAddress;
  if (!delegatePrivateKey || !delegatePublicKeyHex) {
    const delegate = await generateDelegateKey();
    delegatePrivateKey = delegate.privateKey;
    delegatePublicKeyHex = Buffer.from(delegate.publicKey).toString('hex');
    delegateAddress = delegate.suiAddress;
    upsertUser({ address, accountId, delegatePrivateKey, delegatePublicKey: delegatePublicKeyHex, delegateAddress });
  }
  const delegatePublicKey = Uint8Array.from(Buffer.from(delegatePublicKeyHex, 'hex'));
  const tx = buildLinkDelegateTx(address, accountId, delegatePublicKey);
  const bytes = await tx.build({ client: buildClient() });
  const txBytesBase64 = Buffer.from(bytes).toString('base64');
  // Persist the account id with the pending phase: if the user signs but
  // closes the tab before completion, the next visit finds the account id
  // locally instead of re-discovering it via events.
  upsertUser({ address, accountId, pendingPhase: 'link', pendingTxBytes: txBytesBase64 });
  return { txBytesBase64, accountId };
}

// --- Step 2: submit the visitor-signed bytes, then verify onchain state.
export async function completeOnboarding(address, signatureBase64) {
  const user = getUser(address);
  if (!user?.pendingTxBytes || !user?.pendingPhase) {
    throw clientError('No onboarding in progress for this address — call prepare first', 409);
  }
  // Submit. Do NOT clear the pending state yet: if verification is transiently
  // unavailable (indexer lag), the user can retry. If the tx already landed on a
  // previous attempt, tolerate the "already executed" error and go verify.
  let digest = null;
  try {
    const res = await executeSigned(
      Uint8Array.from(Buffer.from(user.pendingTxBytes, 'base64')),
      signatureBase64,
    );
    digest = res?.digest || null;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/already|executed|duplicate|exists|consumed|invalid object/i.test(msg)) throw e;
  }

  if (user.pendingPhase === 'create') {
    // Account id arrives via AccountCreated events (sender = the user).
    let account = null;
    for (let i = 0; i < 6 && !account; i++) {
      account = await accountForOwner(address);
      if (!account) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!account?.accountId) {
      throw clientError(`Transaction ${digest || ''} landed but the AccountCreated event is not indexed yet — retry /api/wallet/status in a few seconds`, 409);
    }
    const check = await verifyAccount(account.accountId, { expectOwner: address });
    if (!check.ok) throw new Error(`Account verification failed: ${check.reason}`);
    markAccountLinked(address, account.accountId);
    upsertUser({ address, pendingPhase: null, pendingTxBytes: null });
    return { stage: 'created', accountId: account.accountId, digest, nextStep: 'link' };
  }

  // link phase: the delegate key must now be registered on the account.
  const accountId = user.accountId || (await accountForOwner(address))?.accountId;
  if (!accountId) throw new Error('Account not found after link transaction — unexpected state');
  const check = await verifyAccount(accountId, {
    expectOwner: address,
    expectDelegateAddress: user.delegateAddress,
  });
  if (!check.ok) throw new Error(`Link verification failed: ${check.reason}`);
  upsertUser({ address, pendingPhase: null, pendingTxBytes: null });
  return { stage: 'linked', accountId, digest, nextStep: null };
}

// Recover a lost registry: the account already exists onchain, but this server
// has no (or a stale) local row. We can only restore the registry row here.
//
// IMPORTANT: without a fresh wallet signature the server cannot register a new
// delegate key onchain. Relinking is therefore *partial* recovery: it restores
// `address → accountId`, and reports whether a delegate key still needs to be
// linked. When `needsDelegateLink` is true the client must run the link flow
// (prepareLinkDelegate → wallet signs → completeOnboarding) to become usable.
export async function relinkExisting(address) {
  if (MODE !== 'mainnet') return null; // no outbound mainnet calls in local mode
  const account = await accountForOwner(address);
  if (!account?.accountId) return null;
  const before = getUser(address); // decrypted view; null if row missing/corrupt
  const alreadyLinked = Boolean(before?.accountId);
  markAccountLinked(address, account.accountId);
  return {
    accountId: account.accountId,
    alreadyLinked,
    needsDelegateLink: !before?.delegatePrivateKey,
  };
}
