import { useCallback, useEffect, useState } from 'react';
import { exportMemory, ExportFact } from '../api';
import { shortBlob } from '../chat';
import { Button, ExternalIcon, ScopeBadge, isDemoNamespace } from '../ui';
import './MemoryView.css';

/**
 * Every stored fact with its Walrus blob id. The server redacts fact text for
 * anyone who isn't the owner — counts stay public, text stays private.
 * Export reuses the same /api/export payload (same redaction), so the file
 * never contains text the viewer couldn't already see here.
 */
export default function MemoryView({
  user,
  mainnet,
}: {
  user: string;
  mainnet: boolean;
}) {
  const [facts, setFacts] = useState<ExportFact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expBusy, setExpBusy] = useState(false);
  const [expFailed, setExpFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const d = await exportMemory(user);
      setFacts(d.facts ?? d.memories ?? []);
    } catch {
      setFacts(null);
      setFailed(true);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  /** Download the /api/export payload as mediara-memories-<user>.json. */
  const exportJson = async () => {
    setExpBusy(true);
    setExpFailed(false);
    try {
      const d = await exportMemory(user);
      const list = d.facts ?? d.memories ?? [];
      const blob = new Blob(
        [
          JSON.stringify(
            {
              user: d.user ?? user,
              exportedAt: new Date().toISOString(),
              facts: list.map((f) => ({
                text: f.text,
                ...(f.blobId ? { blobId: f.blobId } : {}),
                ...(f.createdAt ? { createdAt: f.createdAt } : {}),
              })),
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const safe = user.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 64) || 'user';
      const a = document.createElement('a');
      a.href = url;
      a.download = `mediara-memories-${safe}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExpFailed(true);
    } finally {
      setExpBusy(false);
    }
  };

  return (
    <div className="mem-wrap">
      <div className="mem-head">
        <ScopeBadge user={user} />
        <span className="mem-count" role="status">
          {facts === null
            ? 'Loading…'
            : `${facts.length} ${facts.length === 1 ? 'memory' : 'memories'}`}
        </span>
        <Button
          onClick={exportJson}
          disabled={expBusy || facts === null || facts.length === 0}
        >
          {expBusy ? 'Exporting…' : 'Export memories'}
        </Button>
      </div>

      <p className="view-note">
        {isDemoNamespace(user)
          ? 'Premade shared profile — nothing here is yours.'
          : 'Only your own care record is shown here.'}{' '}
        Everything remembered for <code>{user}</code> — each fact is a
        Seal-encrypted Walrus blob, cited by id. Strangers see counts, never
        text.
      </p>

      {expFailed && (
        <div className="view-empty" role="status">
          Export didn't finish — try again shortly.
        </div>
      )}

      {failed && (
        <div className="view-empty" role="status">
          Memory couldn't be read right now — try again shortly.
        </div>
      )}

      {!failed && facts && facts.length === 0 && (
        <div className="view-empty">
          Nothing stored yet. Teach a medication, an allergy, or a routine in
          Chat and it will appear here with its receipt.
        </div>
      )}

      {facts && facts.length > 0 && (
        <ul className="fact-list">
          {facts.map((f, i) => (
            <li key={f.blobId ?? i} className="fact">
              <span className="fact-text">{f.text}</span>
              {f.blobId && (
                <span className="fact-meta">
                  blob <code>{shortBlob(f.blobId)}</code>
                  {mainnet && (
                    <a
                      href={`https://walruscan.com/blob/${f.blobId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      walruscan <ExternalIcon />
                    </a>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
