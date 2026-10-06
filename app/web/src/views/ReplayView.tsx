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
  const [playing, setPlaying] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setShown(0);
    setPlaying(false);
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

  React.useEffect(() => {
    if (!playing || done) return;
    if (reducedMotion()) {
      setShown(n);
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setShown((s) => Math.min(s + 1, n)), 420);
    return () => window.clearTimeout(t);
  }, [playing, shown, done, n]);

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
        <p style={{ margin: 0 }}>{error}</p>
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
    return <Empty title="No facts to replay" action={<Button size="sm" onClick={load}>Retry</Button>} />;
  }

  const facts: ExportResponse['facts'] = data.facts;
  const pct = Math.round((shown / facts.length) * 100);
  const allergyFact = facts.find((f) => /allerg|penicillin/i.test(f.text)) ?? facts[0];
  const stopShort = shortBlob(allergyFact.blob_id);
  const stopLink = walruscan(allergyFact.blob_id);

  function play() {
    if (done) setShown(0);
    if (reducedMotion()) {
      setShown(facts.length);
      setPlaying(false);
    } else {
      setPlaying(true);
    }
  }

  return (
    <div className="replay-wrap">
      <div className="replay-top">
        <h2 className="replay-title">Replay — {data.user}</h2>
        <Badge variant={data.mode === 'mainnet' ? 'mainnet' : 'local'}>{data.mode}</Badge>
        <div className="replay-controls">
          <Button variant="primary" size="sm" onClick={play} disabled={playing}>
            {done ? 'Replay again' : playing ? 'Playing…' : 'Play'}
          </Button>
          <Button size="sm" onClick={() => { setPlaying(false); setShown(0); }}>Reset</Button>
        </div>
      </div>

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
        Showing {shown} of {facts.length} facts · {facts.length} total
        {shown > 0 ? ` · up to Day ${dayFor(Math.max(shown - 1, 0), facts.length)}` : ''}
      </p>

      <ol className="replay">
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
              <p>Question: &ldquo;{STOP_QUESTION}&rdquo;</p>
              <p>No — ibuprofen is refused. Allergy on record: &ldquo;{clean(allergyFact.text)}&rdquo;</p>
              {stopShort ? (
                <p className="replay-cite">
                  Source blob <code className="mono">{stopShort}</code>
                  {stopLink ? (
                    <>
                      {' '}<a href={stopLink} target="_blank" rel="noreferrer">walruscan</a>
                    </>
                  ) : null}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
