import { useCallback, useEffect, useState } from 'react';
import { guardProof, GuardProof, GuardProofEntry } from '../api';
import { shortBlob } from '../chat';
import { Badge, ExternalIcon, ScopeBadge, ShieldIcon, WarnIcon } from '../ui';
import './GuardProofView.css';

/**
 * Public guard ledger — no sign-in. Every STOP/CAUTION ever fired, chained by
 * hash; the chain re-verifies on every load and the result is shown as-is.
 */
export default function GuardProofView({ mainnet }: { mainnet: boolean }) {
  const [data, setData] = useState<GuardProof | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await guardProof());
    } catch {
      setData(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const entries: GuardProofEntry[] = data?.entries ?? data?.ledger ?? [];
  const verified = data?.verify?.ok ?? data?.ok;

  return (
    <div className="gp-wrap">
      <div className="gp-head">
        <p className="view-note">
          <ScopeBadge scope="public" /> Global public record — same for
          everyone, not tied to your vault. Every safety stop, publicly
          receipted and hash-chained. Edit one row
          and the chain breaks — this page re-verifies it on every view.
        </p>
        {verified !== undefined && (
          <Badge tone={verified ? 'ok' : 'danger'}>
            {verified ? 'Chain verified' : 'Chain broken'}
          </Badge>
        )}
      </div>

      {failed && (
        <div className="view-empty" role="status">
          The ledger couldn't be read right now.
        </div>
      )}

      {!failed && entries.length === 0 && (
        <div className="view-empty">
          No guard receipts yet — ask the demo about ibuprofen to fire one.
        </div>
      )}

      <ol className="gp-list">
        {entries.map((e, i) => {
          const stop = (e.verdict ?? '').toUpperCase() === 'STOP';
          return (
            <li key={e.id ?? e.hash ?? i} className="gp-row">
              <span className={`gp-verdict ${stop ? 'stop' : 'caution'}`}>
                {stop ? <ShieldIcon /> : <WarnIcon />}
                {stop ? 'STOP' : 'CAUTION'}
              </span>
              <div className="gp-body">
                {e.reason && <div className="gp-reason">{e.reason}</div>}
                {(e.factText ?? e.text) && (
                  <blockquote className="gp-fact">“{e.factText ?? e.text}”</blockquote>
                )}
                <div className="gp-meta">
                  {e.blobId && (
                    <span>
                      blob <code>{shortBlob(e.blobId)}</code>
                      {mainnet && (
                        <a
                          href={`https://walruscan.com/blob/${e.blobId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          walruscan <ExternalIcon />
                        </a>
                      )}
                    </span>
                  )}
                  {e.ts && <span>{new Date(e.ts).toLocaleString()}</span>}
                </div>
              </div>
              <div className="gp-chain" title="hash → previous hash">
                <code>{shortBlob(e.hash)}</code>
                <span aria-hidden="true">→</span>
                <code>{shortBlob(e.prevHash ?? e.prev)}</code>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
