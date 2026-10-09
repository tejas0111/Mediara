// Wallet onboarding regressions — deterministic, ZERO outbound network.
// A loopback HTTP stub stands in for the Sui GraphQL endpoint (onchain.js
// pins SUI_GRAPHQL_URL at import time, so it must be set BEFORE any app module
// is imported here), the wallet registry is a temp file, and the signature
// step is stubbed the way wallet.test.js stubs everything else: no wallet, no
// chain, no flake. Covers the three regression classes that bit production:
//   (1) a create 409 that reaches an already-onboarded wallet must carry the
//       machine-readable next step (needsRelink / alreadyLinked), never just
//       prose — otherwise the client re-presses create and repeats the 409;
//   (2) relink must ADOPT the existing current-package account (never the
//       retired twin, never a fresh create) so one click reconnects the vault;
//   (3) walletStatus must report retiredDeployment from the account's real
//       type: false for the current package, true for the retired one.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase58 } from '@mysten/sui/utils';

const WALLET = '0x' + 'ab'.repeat(32);
const PKG = '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5'; // current
const RETIRED_PKG = '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6'; // retired
const ACCOUNT = '0x' + 'cd'.repeat(32);
const RETIRED_ACCOUNT = '0x' + 'ee'.repeat(32);
const DELEGATE_ADDRESS = '0x' + '12'.repeat(32);
const REGISTRY_ID = '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f';
// Exact SDK wording seen onchain when create_account is called a second time.
const CREATE_ABORT =
  "Transaction resolution failed: MoveAbort in 1st command, abort code: 3, in '0x9bb69df6fab877f81c97509523204191d9f2e356af8add901d2886e1dc445650::account::create_account' (instruction 46)";

const obj = (address, repr, json) => ({ address, asMoveObject: { contents: { type: { repr }, json } } });

// A BCS TransactionData the SDK can actually resolve: the stub answers
// simulateTransaction with it, so a *successful* build is reachable in tests.
// (The old 'AAAA' placeholder made every real build die on a ULEB decode
// error, which is why no test could ever walk create → sign → submit.) The two
// object inputs mirror what buildCreateAccountTx asks for: the shared Registry
// object and the Clock.
const RESOLVED_TX_B64 = Buffer.from(
  new TransactionDataBuilder({
    version: 2,
    sender: WALLET,
    expiration: { None: true },
    gasData: {
      payment: [{ digest: toBase58(new Uint8Array(32).fill(7)), objectId: '0x' + '11'.repeat(32), version: 1 }],
      owner: WALLET,
      price: 1n,
      budget: 1000n,
    },
    inputs: [
      { Object: { SharedObject: { objectId: REGISTRY_ID, initialSharedVersion: '1', mutable: true } } },
      { Object: { SharedObject: { objectId: '0x6', initialSharedVersion: '1', mutable: false } } },
    ],
    commands: [],
  }).build(),
).toString('base64');

// The same, shaped for buildLinkDelegateTx's inputs: the account object, the
// Registry object, the delegate key bytes, the label, then the Clock.
const LINK_RESOLVED_TX_B64 = Buffer.from(
  new TransactionDataBuilder({
    version: 2,
    sender: WALLET,
    expiration: { None: true },
    gasData: {
      payment: [{ digest: toBase58(new Uint8Array(32).fill(7)), objectId: '0x' + '11'.repeat(32), version: 1 }],
      owner: WALLET,
      price: 1n,
      budget: 1000n,
    },
    inputs: [
      { Object: { SharedObject: { objectId: ACCOUNT, initialSharedVersion: '1', mutable: true } } },
      { Object: { SharedObject: { objectId: REGISTRY_ID, initialSharedVersion: '1', mutable: true } } },
      { Pure: { bytes: Array.from({ length: 32 }, (_, i) => i) } },
      { Pure: { bytes: Array.from(new TextEncoder().encode('DoseDaughter')) } },
      { Object: { SharedObject: { objectId: '0x6', initialSharedVersion: '1', mutable: false } } },
    ],
    commands: [],
  }).build(),
).toString('base64');

// One knob object the stub reads per request; each test flips what it needs.
const mode = {
  build: 'abort', // 'abort' -> the create_account build MoveAborts; 'ok' -> resolves
  execute: 'ok', // 'ok' -> the submit mutation reports success
  objects: [], // owned objects for accountForOwner
  type: `${PKG}::account::MemWalAccount`, // type repr for verifyAccount
  delegates: [], // delegate_keys on the account object
  failAll: false, // every GraphQL answer fails — proves a healthy status never calls out
};

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let q = '';
    try { q = JSON.parse(body).query || ''; } catch { /* not JSON — ignore */ }
    const json = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    // Offline switch: a healthy wallet's status must not need the chain at
    // all, so every answer failing cannot change what a complete row reports.
    if (mode.failAll) return json({ errors: [{ message: 'stub offline' }] });
    // Order matters: the submit mutation document also mentions executeTransaction.
    if (/executeTransaction\s*\(/.test(q)) {
      if (mode.execute === 'failed') {
        return json({
          data: {
            executeTransaction: {
              effects: { transaction: { digest: 'stub-digest', signatures: [], effects: { status: 'FAILURE', executionError: { message: 'Insufficient gas' } } } },
            },
          },
        });
      }
      if (mode.execute === 'unreachable') return json({ errors: [{ message: 'fetch failed' }] });
      if (mode.execute !== 'ok') return json({ errors: [{ message: 'submit failed' }] });
      return json({
        data: {
          executeTransaction: {
            effects: { transaction: { digest: 'stub-digest', signatures: [], effects: { status: 'SUCCESS' } } },
          },
        },
      });
    }
    if (/simulateTransaction/.test(q)) {
      const wantsCreate = /create_account/.test(body);
      if (mode.build === 'ok') {
        // A successful build, shaped like the inputs this builder asked for:
        // create resolves against Registry+Clock, link against the account.
        return json({
          data: {
            simulateTransaction: {
              effects: { transaction: { transactionBcs: wantsCreate ? RESOLVED_TX_B64 : LINK_RESOLVED_TX_B64, status: 'SUCCESS' } },
            },
          },
        });
      }
      // Any other setting means the build fails. The create build fails with
      // the exact SDK MoveAbort wording seen onchain when create_account is
      // called a second time; every other build fails as a transient relayer
      // error (the actionable-retry path).
      if (wantsCreate) return json({ errors: [{ message: CREATE_ABORT }] });
      return json({ errors: [{ message: 'stub: relayer could not build the transaction' }] });
    }
    if (/objects\(/.test(q)) return json({ data: { objects: { nodes: mode.objects } } });
    if (/object\(address/.test(q)) {
      return json({
        data: {
          object: obj(ACCOUNT, mode.type, {
            account_id: ACCOUNT,
            owner: WALLET,
            delegate_keys: mode.delegates.map((a) => ({ sui_address: a })),
          }),
        },
      });
    }
    if (/events\(/.test(q)) return json({ data: { events: { nodes: [] } } });
    return json({ data: {} });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB_PORT = stub.address().port;

// Config BEFORE importing the app: dotenv does not override existing vars, and
// onchain.js / onboarding.js capture theirs at module load.
const TMP = path.join(os.tmpdir(), `dd-onboard-${process.pid}-${Date.now()}.json`);
process.env.MEMWAL_MODE = 'mainnet';
process.env.SESSION_SECRET = 'onboard-test-secret';
process.env.DD_REGISTRY_PATH = TMP;
process.env.SUI_GRAPHQL_URL = `http://127.0.0.1:${STUB_PORT}/graphql`;
process.env.DD_CHAT_LIMIT = '10000';
process.env.DD_READ_LIMIT = '10000';
process.env.DD_NONCE_LIMIT = '10000';
process.env.DD_AUTH_LIMIT = '10000';
process.env.DD_ONBOARD_LIMIT = '1000';
process.env.DD_DAY_LIMIT_WALLET = '10000';

const { default: app } = await import('./server.js');
const { issueSession } = await import('./walletAuth.js');
const { upsertUser, clearUser, getUser } = await import('./userRegistry.js');

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  try { server.close(); } catch { /* already down */ }
  try { stub.close(); } catch { /* already down */ }
  try { fs.unlinkSync(TMP); } catch { /* best effort */ }
});

// Each case starts from a fresh container: no local row at all (the exact state
// an ephemeral-disk host comes back with) — the onchain account still exists.
beforeEach(() => {
  clearUser(WALLET);
  mode.build = 'abort';
  mode.execute = 'ok';
  mode.objects = [];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [];
  mode.failAll = false;
});

const h = () => ({ Cookie: `dd_session=${issueSession(WALLET)}` });
const post = (p, body) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h() }, body: JSON.stringify(body) });
const get = (p) => fetch(`${base}${p}`, { headers: h() });
const statusOf = async () => (await (await get('/api/wallet/status')).json());
// A row with an account id but NO delegate key: the vault exists onchain, this
// server holds nothing — the state needsRelink describes exactly.
const seedAccountOnly = () => upsertUser({ address: WALLET, accountId: ACCOUNT });
const seedLinked = () => upsertUser({
  address: WALLET,
  accountId: ACCOUNT,
  delegatePrivateKey: 'ab'.repeat(32),
  delegatePublicKey: 'cd'.repeat(32),
  delegateAddress: DELEGATE_ADDRESS,
  pendingPhase: null,
  pendingTxBytes: null,
});

test('create 409 on an already-owned vault carries needsRelink, not just prose', async () => {
  // Fresh container, account already onchain: create_account aborts.
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  const r = await post('/api/wallet/onboard/create', {});
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.needsRelink, true, 'the 409 body must flag the link step');
  assert.match(body.error, /already owns a memory vault onchain/i);
  assert.match(body.error, /link step/i, 'the sentence names the next step too');
  // Actionable flags only: never key material, never a registry path.
  assert.deepEqual(Object.keys(body).sort(), ['error', 'needsRelink']);
  // A client that honours the flag links: status routes to the link step, so
  // there is no reason (and no state) for a second create press.
  const st = await statusOf();
  assert.equal(st.needsRelink, true);
  assert.equal(st.retiredDeployment, false);
  assert.equal(st.onboarded, false);
});

test('create 409 for an already-linked vault is flagged, so no client re-creates', async () => {
  mode.build = 'ok';
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  seedLinked();
  const r = await post('/api/wallet/onboard/create', {});
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.alreadyLinked, true, 'a usable vault must not read as "no vault yet"');
  assert.equal(body.needsRelink, undefined);
  assert.match(body.error, /already has a linked memory vault/i);
  assert.deepEqual(Object.keys(body).sort(), ['alreadyLinked', 'error']);
});

test('relink adopts the existing CURRENT-package account (not the retired twin)', async () => {
  mode.objects = [
    obj(RETIRED_ACCOUNT, `${RETIRED_PKG}::account::MemWalAccount`, { account_id: RETIRED_ACCOUNT, owner: WALLET }),
    obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET }),
  ];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [];
  const r = await post('/api/wallet/relink', {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.accountId, ACCOUNT, 'adoption resolves to the current-package account');
  assert.equal(body.alreadyLinked, false);
  assert.equal(body.needsDelegateLink, true, 'the wallet still signs the link tx');
  // The local row now points at the adopted account: status asks for LINK.
  const st = await statusOf();
  assert.equal(st.accountId, ACCOUNT);
  assert.equal(st.needsRelink, true);
  assert.equal(st.retiredDeployment, false);
  assert.equal(st.onboarded, false, 'not usable until the delegate link lands');
});

test('walletStatus.retiredDeployment: false for a current type, true for a retired type', async () => {
  seedAccountOnly();
  mode.type = `${PKG}::account::MemWalAccount`;
  let st = await statusOf();
  assert.equal(st.needsRelink, true);
  assert.equal(st.retiredDeployment, false, 'a current-package account is linkable');
  mode.type = `${RETIRED_PKG}::account::MemWalAccount`;
  st = await statusOf();
  assert.equal(st.needsRelink, true);
  assert.equal(st.retiredDeployment, true, 'a retired-typed account must offer a fresh start');
  mode.type = `${PKG}::account::MemWalAccount`;
});

test('an adopted vault reaches stage linked with a stubbed signature', async () => {
  // Pending link row: the wallet signed, the tab closed before completion.
  mode.build = 'ok';
  mode.execute = 'ok';
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [DELEGATE_ADDRESS]; // the link tx registered our delegate
  upsertUser({
    address: WALLET,
    accountId: ACCOUNT,
    delegatePrivateKey: 'ab'.repeat(32),
    delegatePublicKey: 'cd'.repeat(32),
    delegateAddress: DELEGATE_ADDRESS,
    pendingPhase: 'link',
    pendingTxBytes: Buffer.from('stub-link-tx').toString('base64'),
  });
  const r = await post('/api/wallet/onboard/complete', { signature: 'S'.repeat(88) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.stage, 'linked', 'the adopted vault finishes at stage linked');
  assert.equal(body.accountId, ACCOUNT);
  assert.equal(body.digest, 'stub-digest', 'the submit digest survives to the client');
  const st = await statusOf();
  assert.equal(st.onboarded, true, 'a finished onboarding reports onboarded');
  assert.equal(st.needsRelink, false);
  assert.equal(st.pendingPhase, null);
});

test('a failed submit is a 422 with the real reason, never a silent "landed"', async () => {
  mode.build = 'ok';
  mode.execute = 'failed'; // the SDK surfaces a FailedTransaction union
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [DELEGATE_ADDRESS];
  upsertUser({
    address: WALLET,
    accountId: ACCOUNT,
    delegatePrivateKey: 'ab'.repeat(32),
    delegatePublicKey: 'cd'.repeat(32),
    delegateAddress: DELEGATE_ADDRESS,
    pendingPhase: 'link',
    pendingTxBytes: Buffer.from('stub-link-tx').toString('base64'),
  });
  const r = await post('/api/wallet/onboard/complete', { signature: 'S'.repeat(88) });
  assert.equal(r.status, 422, 'a failed onchain submit must not be reported as landed');
  const body = await r.json();
  assert.match(body.error, /failed onchain/i);
  assert.ok(!JSON.stringify(body).includes('delegatePrivateKey'), 'no key material in an error body');
});

test('an unreachable submit is an actionable 409, never a bare 500', async () => {
  mode.build = 'ok';
  mode.execute = 'unreachable';
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [DELEGATE_ADDRESS];
  upsertUser({
    address: WALLET,
    accountId: ACCOUNT,
    delegatePrivateKey: 'ab'.repeat(32),
    delegatePublicKey: 'cd'.repeat(32),
    delegateAddress: DELEGATE_ADDRESS,
    pendingPhase: 'link',
    pendingTxBytes: Buffer.from('stub-link-tx').toString('base64'),
  });
  const r = await post('/api/wallet/onboard/complete', { signature: 'S'.repeat(88) });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.match(body.error, /was not submitted/i);
  assert.match(body.error, /press the step again/i, 'the user is told what to do next');
  assert.equal(body.pendingPhase ?? undefined, undefined, 'the pending step stays server-side, not in the error');
});

// --- Regression: the live "Repair my vault" loop (production, wallet 0xf355…) ---
// The link tx landed on a previous attempt, so the SECOND link prepare re-adds
// the same delegate key → the build aborts → the old classifier matched the
// MoveAbort message and labelled the CURRENT-package account "retired", so the
// UI offered "Repair my vault", which 409s on create and loops forever.
test('a duplicate link (delegate already registered) reports alreadyLinked — no tx, no loop', async () => {
  mode.build = 'ok';
  mode.execute = 'ok';
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  // The on-chain account ALREADY carries this server's delegate: the earlier
  // link landed; only the completion step was lost.
  mode.delegates = [DELEGATE_ADDRESS];
  upsertUser({
    address: WALLET,
    accountId: ACCOUNT,
    delegatePrivateKey: 'ab'.repeat(32),
    delegatePublicKey: 'cd'.repeat(32),
    delegateAddress: DELEGATE_ADDRESS,
    pendingPhase: null,
    pendingTxBytes: null,
  });
  const r = await post('/api/wallet/onboard/link', {});
  assert.equal(r.status, 200, 'nothing to sign: the link already landed');
  const body = await r.json();
  assert.equal(body.alreadyLinked, true, 'the client lands straight on Done');
  const st = await statusOf();
  assert.equal(st.onboarded, true, 'the account is usable without a second wallet prompt');
  assert.equal(st.needsRelink, false);
});

test('a link build failure on a CURRENT-package account never claims the vault is retired', async () => {
  mode.build = 'abort'; // any build failure (e.g. transient relayer error)
  mode.execute = 'ok';
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = []; // not registered yet → a real link tx is offered
  upsertUser({
    address: WALLET,
    accountId: ACCOUNT,
    delegatePrivateKey: 'ab'.repeat(32),
    delegatePublicKey: 'cd'.repeat(32),
    delegateAddress: DELEGATE_ADDRESS,
    pendingPhase: null,
    pendingTxBytes: null,
  });
  const r = await post('/api/wallet/onboard/link', {});
  assert.equal(r.status, 409, 'the failed build is an actionable retry');
  const body = await r.json();
  assert.ok(!body.retiredDeployment, 'a CURRENT-package account is never called retired');
  assert.match(body.error, /again to regenerate/i, 'the user is told to retry, not to start a fresh vault');
  const st = await statusOf();
  assert.equal(st.retiredDeployment, false, 'status stays linkable');
});

test('a RETIRED-typed account still offers the fresh-vault path', async () => {
  mode.build = 'abort';
  mode.execute = 'ok';
  mode.objects = [obj(RETIRED_ACCOUNT, `${RETIRED_PKG}::account::MemWalAccount`, { account_id: RETIRED_ACCOUNT, owner: WALLET })];
  mode.type = `${RETIRED_PKG}::account::MemWalAccount`;
  mode.delegates = [];
  clearUser(WALLET);
  const r = await post('/api/wallet/onboard/link', {});
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.retiredDeployment, true, 'a truly retired-typed account still offers repair');
});

// --- Regression: the "sign, then an unnecessary step" complaint (wallet 0xf355…) ---
// The onboarding surfaces read GET /api/wallet/status and show exactly one
// action for its answer. These pin the three answers a returning owner can
// get, so no client can walk a vault owner through a create that cannot work.

test('status: an onchain-linked vault whose local row is lost reports needsRelink with an alreadyLinked-able link', async () => {
  // Fresh container: no local row. The account (and a delegate) live onchain.
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [DELEGATE_ADDRESS];
  clearUser(WALLET);
  const st = await statusOf();
  assert.equal(st.needsRelink, true, 'an account without a stored delegate asks for LINK, never create');
  assert.equal(st.retiredDeployment, false, 'a current-package account is linkable');
  assert.equal(st.onboarded, false);
  assert.equal(st.accountId, ACCOUNT);
  // One link press reconnects it — and when the stored delegate IS the one
  // registered onchain, the server must answer without prompting the wallet.
  upsertUser({
    address: WALLET,
    accountId: ACCOUNT,
    delegatePrivateKey: 'ab'.repeat(32),
    delegatePublicKey: 'cd'.repeat(32),
    delegateAddress: DELEGATE_ADDRESS,
    pendingPhase: null,
    pendingTxBytes: null,
  });
  const r = await post('/api/wallet/onboard/link', {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).alreadyLinked, true, 'nothing to sign: the delegate is already registered');
  const after = await statusOf();
  assert.equal(after.onboarded, true, 'the vault is usable without a second wallet prompt');
  assert.equal(after.needsRelink, false);
});

test('status: a fully onboarded wallet reports ready with no pending phase — and never calls out', async () => {
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [DELEGATE_ADDRESS];
  seedLinked();
  mode.failAll = true; // the whole chain is unreachable…
  const st = await statusOf();
  assert.equal(st.onboarded, true, 'a complete row is answered from the registry alone');
  assert.equal(st.needsRelink, false);
  assert.equal(st.pendingPhase, null, 'no step is left pending for a ready wallet');
  assert.equal(st.retiredDeployment, false);
});

test('create auto-detects an existing CURRENT-package vault before it builds a doomed tx', async () => {
  // build 'ok': a fresh create WOULD resolve, so a 409 can only come from
  // discovery — the wallet is never offered a transaction that cannot land.
  mode.build = 'ok';
  mode.execute = 'ok';
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [];
  clearUser(WALLET);
  const r = await post('/api/wallet/onboard/create', {});
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.needsRelink, true, 'the previous vault is detected before any transaction is built');
  assert.deepEqual(Object.keys(body).sort(), ['error', 'needsRelink']);
  // That flag is the client's route to the one link signature that reconnects.
  const st = await statusOf();
  assert.equal(st.needsRelink, true);
  assert.equal(st.retiredDeployment, false);
});

test('a RETIRED-only vault still creates fresh — create never short-circuits into a relink loop', async () => {
  // The retired twin is discoverable but unusable: create must fall through
  // to a fresh vault on the live package, or "start fresh" can never finish.
  mode.build = 'ok';
  mode.execute = 'ok';
  mode.objects = [obj(RETIRED_ACCOUNT, `${RETIRED_PKG}::account::MemWalAccount`, { account_id: RETIRED_ACCOUNT, owner: WALLET })];
  mode.type = `${RETIRED_PKG}::account::MemWalAccount`;
  mode.delegates = [];
  clearUser(WALLET);
  const r = await post('/api/wallet/onboard/create', {});
  assert.equal(r.status, 200, 'a retired-typed account must not block the fresh create');
  assert.ok((await r.json()).txBytesBase64, 'the fresh create is offered to the wallet');
  // …and the row left behind still reports the twin as retired.
  const st = await statusOf();
  assert.equal(st.retiredDeployment, true);
});

test('a fresh wallet walks create → link with one signature per step and no double-charge', async () => {
  // The minimal fresh path the onboarding modal/view now runs: two distinct
  // transactions, each signed once, then the vault reports ready.
  mode.build = 'ok';
  mode.execute = 'ok';
  mode.objects = []; // no account onchain yet — that is what makes this wallet fresh
  mode.type = `${PKG}::account::MemWalAccount`;
  mode.delegates = [];
  clearUser(WALLET);
  // Step 1 — create.
  const c = await post('/api/wallet/onboard/create', {});
  assert.equal(c.status, 200);
  const created = await c.json();
  assert.ok(created.txBytesBase64, 'create hands the wallet a transaction to sign');
  // The account now exists onchain — discovery can see it from here on.
  mode.objects = [obj(ACCOUNT, `${PKG}::account::MemWalAccount`, { account_id: ACCOUNT, owner: WALLET })];
  const d1 = await post('/api/wallet/onboard/complete', { signature: 'S'.repeat(88) });
  assert.equal(d1.status, 200);
  const done1 = await d1.json();
  assert.equal(done1.stage, 'created');
  assert.equal(done1.nextStep, 'link', 'the client is told the link step is next');
  // …and the vault is NOT usable yet: reporting ready here is what used to
  // hide the link step and break saving later.
  const mid = await statusOf();
  assert.equal(mid.onboarded, false, 'a create-only vault must never report ready');
  assert.equal(mid.pendingPhase, 'link', 'the outstanding step is named');
  // Step 2 — link the delegate the create row already minted.
  const l = await post('/api/wallet/onboard/link', {});
  assert.equal(l.status, 200);
  const linked = await l.json();
  assert.ok(linked.txBytesBase64, 'link hands the wallet its own transaction');
  assert.notEqual(linked.txBytesBase64, created.txBytesBase64, 'two steps, two transactions — the wallet is never charged twice');
  // The chain sees the delegate the link registered, so completion verifies.
  const row = getUser(WALLET);
  assert.ok(row?.delegateAddress, 'the link step reuses the stored delegate');
  mode.delegates = [row.delegateAddress];
  const d2 = await post('/api/wallet/onboard/complete', { signature: 'S'.repeat(88) });
  assert.equal(d2.status, 200);
  assert.equal((await d2.json()).stage, 'linked');
  const st = await statusOf();
  assert.equal(st.onboarded, true, 'the fresh vault is usable after both signatures');
  assert.equal(st.needsRelink, false);
  assert.equal(st.pendingPhase, null);
  assert.equal(st.retiredDeployment, false);
});
