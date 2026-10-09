# Security policy

If you find a vulnerability in Mediara, don't open a public issue. Open a
private GitHub Security Advisory against this repo instead, with steps to
reproduce and what you expected to happen. I'll confirm receipt within a few
days and keep you posted as a fix lands.

What counts as in scope: the Express server (`app/src/server.js`), wallet
sign-in and session handling (`walletAuth.js`, cookies), the per-user delegate
registry and its encryption (`userRegistry.js`, `cryptoUtils.js`), the
namespace and budget guards (`SPEC.md` scope rules), and the Telegram bot
(`telegram.js`). Out of scope: the hosted Walrus relayer, Sui mainnet itself,
and OpenRouter or any LLM provider. Those are upstream services with their own
disclosure paths.

A note from building this: the scariest bug I found wasn't exotic. It was an
anonymous request naming another user's vault namespace and getting served. So
report anything that crosses a namespace boundary, leaks a delegate key, or
downgrades a signed-in user to shared memory. Rate limits and error shapes
matter here too.

Please don't probe mainnet accounts you don't own, exfiltrate real caregiver
data, or run load against the shared deployment. Keep tests local
(`MEMWAL_MODE` unset) or against your own namespaces.
