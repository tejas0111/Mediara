import React from 'react';
import { ApiError, clean, getExport, shortBlob, walruscan, type ExportResponse } from '../api';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Empty, Skeleton, cn } from '../ui';
import './ReplayView.css';

/** Proportional day label across a 90-day arc. */
export const dayFor = (i: number, n: number): number =>
  n <= 1 ? 90 : Math.round(1 + (89 * i) / (n - 1));

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

const STOP_QUESTION = 'Can she take ibuprofen for her headache?';

export default function ReplayView({ userId }: { userId: string }) {
  const [data, setData] = React.useState<ExportResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [shown, setShown] = React.useState(0);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setShown(0);
    try {
      setData(await getExport(userId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'request failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const n = data?.facts.length ?? 0;
  const done = n > 0 && shown >= n;
  // Reduced-motion users get the same instant result — there is no timed
  // stepping to suppress, so this view is calm by construction.
  const calm = reducedMotion();

  if (loading) {
    return (
      <div className="replay-wrap" aria-busy="true">
        <Skeleton style={{ height: 24, width: '40%' }} />
        <Skeleton style={{ height: 160 }} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger">
        <p style={{ margin: 0 }}>Could not load replay for {userId}: {error}. The timeline below may be incomplete — retry first.</p>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </Alert>
    );
  }

  if (!data) {
    return <Empty title="No replay data" />;
  }

  if (data.facts.length === 0) {
    return <Empty title="No facts to replay">Nothing stored for {userId} yet — add facts in chat, then replay their history.</Empty>;
  }

  const facts: ExportResponse['facts'] = data.facts;
  const pct = Math.round((shown / facts.length) * 100);
  const allergyMatch = facts.find((f) => /allerg|penicillin/i.test(f.text));
  const allergyFact = allergyMatch ?? facts[0];
  const stopShort = shortBlob(allergyFact.blob_id);
  const stopLink = walruscan(allergyFact.blob_id);

  function play() {
    if (done) setShown(0);
    // Instant reveal: the full history appears at once — no simulated
    // stepping, no timers. Day labels stay proportional via dayFor.
    setShown(facts.length);
  }

  return (
    <div className="replay-wrap">
      <p className="eyebrow">History</p>
      <div className="replay-top">
        <h2 className="replay-title">Replay — {data.user}</h2>
        <Badge variant={data.mode === 'mainnet' ? 'mainnet' : 'local'}>{data.mode}</Badge>
        <div className="replay-controls">
          <Button variant="primary" size="sm" onClick={play}>
            {done ? 'Replay again' : shown > 0 ? 'Show all' : 'Play'}
          </Button>
          <Button size="sm" onClick={() => { setShown(0); }}>Reset</Button>
        </div>
      </div>
      <p className="replay-hint">
        Watch how remembered facts accumulated — each step is a fact saved from a chat turn,
        with its blob receipt — then see the guard refuse a risky question on the final day.
      </p>

      <div
        className="replay-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={facts.length}
        aria-valuenow={shown}
        aria-label="Replay progress"
      >
        <div className="replay-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="replay-caption">
        Showing {shown} of {facts.length} facts
        {shown > 0 ? ` · up to Day ${dayFor(Math.max(shown - 1, 0), facts.length)} of 90` : ' · press Play to begin'}
      </p>

      <ol className={calm ? 'replay replay-calm' : 'replay'}>
        {facts.map((f, i) => {
          const visible = i < shown;
          const short = shortBlob(f.blob_id);
          const link = walruscan(f.blob_id);
          return (
            <li
              key={i}
              className={cn('replay-item', visible && 'is-shown')}
              aria-hidden={!visible ? 'true' : undefined}
            >
              <span className="replay-day">Day {dayFor(i, facts.length)}</span>
              <span className="replay-text">{clean(f.text)}</span>
              {short ? (
                <span className="replay-cite">
                  <code className="mono">{short}</code>
                  {link ? (
                    <>
                      {' '}<a href={link} target="_blank" rel="noreferrer">walruscan</a>
                    </>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      {done ? (
        <div className="replay-stop" role="alert">
          <Card>
            <CardHeader>
              <CardTitle>STOP — final day refusal</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="replay-stop-q">Question: &ldquo;{STOP_QUESTION}&rdquo;</p>
              <p className="replay-stop-a">No — ibuprofen is refused. {allergyMatch ? <>Allergy on record: &ldquo;{clean(allergyFact.text)}&rdquo;</> : <>On record: &ldquo;{clean(allergyFact.text)}&rdquo;</>}</p>
              {stopShort ? (
                <p className="replay-cite">
                  Source blob <code className="mono">{stopShort}</code>
                  {stopLink ? (
                    <>
                      {' '}<a href={stopLink} target="_blank" rel="noreferrer">walruscan</a>
                    </>
                  ) : null}
                  {' '}<a href="#/proof">guard proof</a>
                </p>
              ) : (
                <p className="replay-cite"><a href="#/proof">guard proof</a></p>
              )}
              <p className="replay-stop-note">Confirm with your doctor — this is not medical advice.</p>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
