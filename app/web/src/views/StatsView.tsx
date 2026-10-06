import React from 'react';
import { ApiError, getUsage, type UsageResponse } from '../api';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, Skeleton } from '../ui';
import './StatsView.css';

export default function StatsView({ userId }: { userId: string }) {
  void userId;
  const [data, setData] = React.useState<UsageResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getUsage();
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
      <div className="st-wrap" aria-busy="true">
        <Skeleton style={{ height: 28, width: '45%' }} />
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 120 }} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger">
        <p style={{ margin: 0 }}>Could not load usage: {error}. Counts below may be unavailable — retry before reporting them.</p>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </Alert>
    );
  }

  if (!data) {
    return <Empty title="No usage data">No usage recorded yet — usage appears after memories are stored.</Empty>;
  }

  return (
    <div className="st-wrap">
      <h2 className="st-title">Usage</h2>
      <p className="st-hint">Per-user memory and turn counts with blob receipts. Qualifying users meet the minimum memories requirement.</p>
      <Alert variant={data.meetsRequirement ? 'ok' : 'warn'}>
        {data.meetsRequirement ? 'Requirement MET' : 'Requirement NOT MET'} — {data.qualifyingUsers} qualifying users
        (needs {data.requirement.distinctUsers} users × {data.requirement.memoriesPerUser} memories).
      </Alert>

      {data.users.length === 0 ? (
        <Empty title="No users yet">No users have stored memories yet — stats appear after the first save.</Empty>
      ) : (
        <div className="st-grid">
          {data.users.map((u) => (
            <Card key={u.userId}>
              <CardHeader>
                <CardTitle>{u.userId}</CardTitle>
                <CardDescription>
                  {u.memories} memories · {u.turns} turns
                  {u.firstSeen ? <> · since {u.firstSeen}</> : null}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="st-badges">
                  <Badge variant={u.meetsMinimum ? 'ok' : 'warn'}>
                    {u.meetsMinimum ? 'meets minimum' : 'below minimum'}
                  </Badge>
                  <Badge variant="default">{u.memories} memories</Badge>
                  <Badge variant="default">{u.turns} turns</Badge>
                </div>
                {u.blobs.length === 0 ? (
                  <p className="st-muted">No blobs recorded.</p>
                ) : (
                  <ul className="st-blobs">
                    {u.blobs.map((b) => (
                      <li key={b.blobId} className="st-blob">
                        <code className="mono">{b.blobId}</code>
                        <span className="st-blob-text">{b.text}</span>{' '}
                        {b.link ? (
                          <a href={b.link} target="_blank" rel="noreferrer">walruscan</a>
                        ) : (
                          <span className="st-muted">local demo id</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <p className="st-muted">Generated {data.generatedAt} · mode {data.mode} · Confirm with your doctor — this is not medical advice.</p>
    </div>
  );
}
