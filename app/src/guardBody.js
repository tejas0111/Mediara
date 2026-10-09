// Guard body serialisation — ONE shared definition for both guard ledgers.
// usage.js (GuardProof, JSON) and db.js (SqliteGuards, SQLite) MUST hash and
// verify byte-identical bodies, so mixed chains verify identically. Callers
// slice fact/message to 500 chars BEFORE hashing (record() passes the sliced
// values in); `ns` rides along only when present, so pre-ns rows keep their
// exact historical bodies (chain intact across the upgrade). Zero deps.
export function guardBody({ userId, kind, substance, withSubstance, severity, reason, fact, blobId, message, ns, prev }) {
  const base = { userId, kind, substance, withSubstance, severity, reason, fact, blobId, message, prev };
  if (ns != null) return JSON.stringify({ ...base, ns });
  return JSON.stringify(base);
}
