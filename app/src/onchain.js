// On-chain Walrus Memory account ops (DoseDaughter).
// Visitors create their own MemWalAccount with their wallet (user-funded);
// our delegate key is registered so the server can recall/remember for them.
//
// IDs verified on mainnet (Sept 2026):
//   registry (current):  0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd
//   package (current):   0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
//   package (original):  0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5
//     — MemWalAccount objects created earlier still carry the ORIGINAL package
//       ID in their type, so AccountCreated events exist under BOTH packages.
//
// Transport: SuiGraphQLClient. (The gRPC client in @mysten/sui 2.31.3 fails
// even trivial tx builds here; the GraphQL client builds + executes fine.)
// create_account is an `entry` fun (returns nothing) — the account object
// cannot be chained within one PTB, so onboarding is TWO transactions for
// fresh users: (1) create vault, (2) register DoseDaughter's delegate key.
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
export const REGISTRY_ID = process.env.MEMWAL_REGISTRY_ID || '0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd';
export const PACKAGE_ID = process.env.MEMWAL_PACKAGE_ID || '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6';
export const PACKAGE_IDS = [...new Set([PACKAGE_ID, '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5'])];

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
export async function accountForOwner(ownerAddress) {
  const owner = String(ownerAddress).toLowerCase();
  for (const pkg of PACKAGE_IDS) {
    const data = await gql(
      `query($a: SuiAddress!) { events(last: 50, filter: { sender: $a, module: "${pkg}::account" }) { nodes { contents { json } } } }`,
      { a: owner },
    );
    for (const node of data?.events?.nodes || []) {
      const j = node.contents?.json;
      if (j?.account_id) return { accountId: j.account_id, source: `events:${pkg.slice(0, 10)}` };
    }
  }
  return null;
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
  return { ok: true, account: j };
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
  // A transaction that FAILED onchain must not be reported as "landed, retry the
  // indexer" — surface the real failure immediately (4xx, not a retry loop).
  const status = res?.effects?.status;
  const kind = (status && typeof status === 'object') ? status.status : status;
  if (kind && kind !== 'success') {
    const err = new Error(`transaction failed onchain: ${(status && status.error) || kind}`);
    err.status = 422; err.expose = true; err.digest = res?.digest || null;
    throw err;
  }
  return res; // { digest, ... }
}
