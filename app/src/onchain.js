// On-chain Walrus Memory account ops (DoseDaughter).
// Visitors create their own MemWalAccount with their wallet (user-funded);
// our delegate key is registered so the server can recall/remember for them.
//
// IDs verified on mainnet (Oct 2026 — the deployment migrated; the relayer
// /config is authoritative for the CURRENT package):
//   registry (current):  0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f
//   package (current):   0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5
//   package (retired):   0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
//     — MemWalAccount objects created earlier still carry the RETIRED package
//       ID in their type, so AccountCreated events exist under BOTH packages.
//       Retired-typed accounts CANNOT be used with current-package entry
//       functions (Move type check) — their owners must create fresh.
//
// Transport: SuiGraphQLClient. (The gRPC client in @mysten/sui 2.31.3 fails
// even trivial tx builds here; the GraphQL client builds + executes fine.)
// create_account is an `entry` fun (returns nothing) — the account object
// cannot be chained within one PTB, so onboarding is TWO transactions for
// fresh users: (1) create vault, (2) register DoseDaughter's delegate key.
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
export const REGISTRY_ID = process.env.MEMWAL_REGISTRY_ID || '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f';
export const PACKAGE_ID = process.env.MEMWAL_PACKAGE_ID || '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5';
export const PACKAGE_IDS = [...new Set([PACKAGE_ID, '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6'])];

let gqlClient = null;
export function suiClient() {
  if (!gqlClient) gqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL, network: 'mainnet' });
  return gqlClient;
}

async function gql(query, variables) {
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

function toU8(v) { return v instanceof Uint8Array ? Array.from(v) : v; }

// Tx 1 for fresh users: create the visitor's MemWalAccount (they own it).
export function buildCreateAccountTx(userAddress) {
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.moveCall({
    target: `${PACKAGE_ID}::account::create_account`,
    arguments: [tx.object(REGISTRY_ID), tx.object.clock()],
  });
  return tx;
}

// Tx 2: register DoseDaughter's delegate key on the user's account.
export function buildLinkDelegateTx(userAddress, accountId, delegatePublicKey) {
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.moveCall({
    target: `${PACKAGE_ID}::account::add_delegate_key`,
    arguments: [
      tx.object(accountId),
      tx.object(REGISTRY_ID),
      tx.pure.vector('u8', toU8(delegatePublicKey)),
      tx.pure.string('DoseDaughter'),
      tx.object.clock(),
    ],
  });
  return tx;
}

// Owner → account via AccountCreated events (user is the tx sender, so this
// always works for users who onboarded through this app).
const currentAccountType = PACKAGE_ID + '::account::MemWalAccount';

export async function accountForOwner(ownerAddress) {
  const owner = String(ownerAddress).toLowerCase();
  // Prefer CURRENT-package accounts everywhere: a wallet with both a retired
  // and a fresh account must resolve to the usable one (fresh-create
  // completion, link, status). Retired-typed accounts are a fallback only.
  const currentRe = new RegExp(`^${PACKAGE_ID}::account::MemWalAccount$`);
  const anyRe = /::account::MemWalAccount$/;
  let fallback = null;
  const consider = (accountId, repr, source) => {
    if (!accountId) return null;
    if (currentRe.test(String(repr || ''))) return { accountId, source };
    if (!fallback && anyRe.test(String(repr || ''))) fallback = { accountId, source };
    return null;
  };
  // Owned-objects first: no event-window limit, any package. A dashboard-made
  // account older than the last 50 sent events is invisible to the events
  // scan below but still owned — and ownership is exactly what link needs.
  try {
    const data = await gql(
      `query($a: SuiAddress!) { objects(first: 50, filter: { owner: $a }) { nodes { address asMoveObject { contents { type { repr } json } } } } }`,
      { a: owner },
    );
    for (const node of data?.objects?.nodes || []) {
      const repr = String(node?.asMoveObject?.contents?.type?.repr || '');
      const j = node?.asMoveObject?.contents?.json || {};
      const hit = consider(node?.address || j?.account_id || null, repr, 'owned-objects');
      if (hit) return hit;
    }
  } catch { /* fall through to the events scan */ }
  for (const pkg of PACKAGE_IDS) {
    const data = await gql(
      `query($a: SuiAddress!) { events(last: 50, filter: { sender: $a, module: "${pkg}::account" }) { nodes { contents { json } } } }`,
      { a: owner },
    );
    for (const node of data?.events?.nodes || []) {
      const j = node.contents?.json;
      // Event payloads carry no type repr; the module filter already tells us
      // the package — current-package events win, others are fallback.
      const hit = consider(j?.account_id || null, `${pkg}::account::MemWalAccount`, `events:${pkg.slice(0, 10)}`);
      if (hit) return hit;
    }
  }
  return fallback;
}

// MemWalAccount is a shared object — verify via the object itself.
export async function verifyAccount(accountId, { expectOwner, expectDelegateAddress } = {}) {
  const data = await gql(
    `query($o: SuiAddress!) { object(address: $o) { address asMoveObject { contents { type { repr } json } } } }`,
    { o: accountId },
  );
  const obj = data?.object;
  const j = obj?.asMoveObject?.contents?.json;
  if (!j || !/MemWalAccount$/.test(String(obj?.asMoveObject?.contents?.type?.repr || ''))) {
    return { ok: false, reason: 'not a MemWalAccount' };
  }
  if (expectOwner && String(j.owner).toLowerCase() !== String(expectOwner).toLowerCase()) {
    return { ok: false, reason: 'owner mismatch' };
  }
  if (expectDelegateAddress && !(j.delegate_keys || []).some((d) => String(d.sui_address).toLowerCase() === String(expectDelegateAddress).toLowerCase())) {
    return { ok: false, reason: 'delegate not registered' };
  }
  return { ok: true, account: j, type: String(obj?.asMoveObject?.contents?.type?.repr || '') };
}

// Visitor's SUI balance in nano (0 SUI users may need the sponsor path).
export async function getSuiBalance(ownerAddress) {
  try {
    const data = await gql(
      `query($a: SuiAddress!) { address(address: $a) { balance(coinType: "0x2::sui::SUI") { totalBalance } } }`,
      { a: ownerAddress },
    );
    return Number(data?.address?.balance?.totalBalance || 0);
  } catch {
    return -1; // unknown — never block on a probe failure
  }
}

// Submit a visitor-signed transaction (user pays gas — the v1 relayer model).
export async function executeSigned(txBytes, signatureBase64) {
  const res = await suiClient().core.executeTransaction({
    transaction: txBytes,
    signatures: [signatureBase64],
  });
  // The SDK resolves a submit into a UNION, not the flat result:
  //   { $kind: 'Transaction' | 'FailedTransaction', Transaction, FailedTransaction }
  // Reading `.effects`/`.digest` off the union silently yields undefined, which
  // is how a failed submit used to slip through as "landed" (and why the digest
  // never reached the retry message). Unwrap, then inspect honestly.
  const out = (res && (res.Transaction || res.FailedTransaction)) || res;
  const status = out?.effects?.status ?? out?.status;
  const kind = (status && typeof status === 'object') ? status.status : status;
  const failed =
    out?.$kind === 'FailedTransaction' ||
    (status && typeof status === 'object' && status.success === false) ||
    Boolean(kind && kind !== 'success' && kind !== 'SUCCESS');
  if (failed) {
    const e = status && typeof status === 'object' ? status.error : null;
    const detail = (e && (e.message || e.constant || e.identifier)) || kind || 'execution failed';
    const err = new Error(`transaction failed onchain: ${String(detail).slice(0, 200)}`);
    err.status = 422; err.expose = true; err.digest = out?.digest || null;
    throw err;
  }
  return out; // { digest, effects, ... }
}
