import React from 'react';
import { ApiError, clean, getGuardProof, shortBlob, walruscan, type GuardProofResponse } from '../api';
import { navigate } from '../chat';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, Skeleton } from '../ui';
import './GuardProofView.css';

export default function GuardProofView({ userId }: { userId: string }) {
  void userId;
  const [data, setData] = React.useState<GuardProofResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getGuardProof();
      setData(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'request failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="gp-wrap" aria-busy="true">
        <Skeleton style={{ height: 24, width: '40%' }} />
        <Skeleton style={{ height: 140 }} />
        <Skeleton style={{ height: 140 }} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger">
        <p style={{ margin: 0 }}>Could not load guard proof: {error}. The chain status below may be unavailable — retry before relying on it.</p>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </Alert>
    );
  }

  if (!data) {
    return (
      <Empty
        title="No guard data"
        action={<Button size="sm" variant="primary" onClick={() => navigate('chat')}>Ask a question in chat</Button>}
      >
        No safety blocks recorded yet — the guard fires when a risky question matches a remembered fact.
      </Empty>
    );
  }

  const entries = [...data.entries].sort((x, y) => y.n - x.n);

  return (
    <div className="gp-wrap">
      <p className="eyebrow">Safety</p>
      <div className="gp-top">
        <h2 className="gp-title">Guard proof</h2>
        {data.verify.ok ? (
          <Badge variant="ok">Chain intact · {data.count} entries</Badge>
        ) : (
          <Badge variant="danger">BROKEN at #{data.verify.brokenAt ?? '?'}</Badge>
        )}
      </div>
      <p className="gp-hint">
        Public ledger — no sign-in needed. Every STOP the guard fired, newest first — each entry
        quotes the fact that triggered it and cites the blob behind it.
      </p>
      {!data.verify.ok ? (
        <Alert variant="danger">
          Chain verification failed at entry #{data.verify.brokenAt ?? '?'}. Treat entries below as unverified until the chain is repaired.
        </Alert>
      ) : null}

      {entries.length === 0 ? (
        <Empty title="No guard has fired yet">No guard has fired yet — ask a blocked question in chat.</Empty>
      ) : (
        <div className="gp-list">
          {entries.map((e) => {
            const short = shortBlob(e.blobId);
            const link = walruscan(e.blobId);
            return (
              <Card key={e.n}>
                <CardHeader>
                  <CardTitle>
                    #{e.n} · {e.kind}
                  </CardTitle>
                  <CardDescription>
                    <span className="gp-badges">
                      <Badge variant={e.severity === 'high' || e.severity === 'critical' ? 'danger' : 'warn'}>
                        {clean(e.severity)}
                      </Badge>
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="gp-line">
                    <strong>Substance:</strong> {clean(e.substance)}
                    {e.withSubstance ? <> with {clean(e.withSubstance)}</> : null}
                  </p>
                  <p className="gp-line"><strong>Reason:</strong> {clean(e.reason)}</p>
                  <blockquote className="gp-quote">&ldquo;{clean(e.fact)}&rdquo;</blockquote>
                  {short ? (
                    <p className="gp-line gp-cite">
                      Source blob <code className="mono">{short}</code>
                      {link ? (
                        <>
                          {' '}<a href={link} target="_blank" rel="noreferrer">walruscan</a>
                        </>
                      ) : null}
                    </p>
                  ) : (
                    <p className="gp-line gp-cite">Source blob unavailable (local record)</p>
                  )}
                  <blockquote className="gp-quote gp-msg">&ldquo;{clean(e.message)}&rdquo;</blockquote>
                  <p className="gp-line gp-cite gp-hash">
                    Hash chain <code className="mono">{String(e.prev ?? '').slice(0, 12)}…</code>
                    {' → '}<code className="mono">{String(e.hash ?? '').slice(0, 12)}…</code>
                  </p>
                  <p className="gp-time">Entry #{e.n} · {e.at} · user {e.userId}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
