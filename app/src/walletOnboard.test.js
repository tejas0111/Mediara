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

const WALLET = '0x' + 'ab'.repeat(32);
const PKG = '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5'; // current
const RETIRED_PKG = '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6'; // retired
const ACCOUNT = '0x' + 'cd'.repeat(32);
const RETIRED_ACCOUNT = '0x' + 'ee'.repeat(32);
const DELEGATE_ADDRESS = '0x' + '12'.repeat(32);
// Exact SDK wording seen onchain when create_account is called a second time.
const CREATE_ABORT =
  "Transaction resolution failed: MoveAbort in 1st command, abort code: 3, in '0x9bb69df6fab877f81c97509523204191d9f2e356af8add901d2886e1dc445650::account::create_account' (instruction 46)";

const obj = (address, repr, json) => ({ address, asMoveObject: { contents: { type: { repr }, json } } });

// One knob object the stub reads per request; each test flips what it needs.
const mode = {
  build: 'abort', // 'abort' -> the create_account build MoveAborts; 'ok' -> resolves
  execute: 'ok', // 'ok' -> the submit mutation reports success
  objects: [], // owned objects for accountForOwner
  type: `${PKG}::account::MemWalAccount`, // type repr for verifyAccount
  delegates: [], // delegate_keys on the account object
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
      // Only the create build aborts (the vault already exists onchain); a
      // link build resolves, so the link step stays reachable after that 409.
      const wantsCreate = /create_account/.test(body);
      if (wantsCreate && mode.build !== 'ok') return json({ errors: [{ message: CREATE_ABORT }] });
      if (!wantsCreate && mode.build === 'abort-all') return json({ errors: [{ message: CREATE_ABORT }] });
      return json({
        data: {
          simulateTransaction: {
            effects: { transaction: { transactionBcs: 'AAAA', status: 'SUCCESS' } },
          },
        },
      });
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
const { upsertUser, clearUser } = await import('./userRegistry.js');

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
