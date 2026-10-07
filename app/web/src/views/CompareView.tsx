import React from 'react';
import { ApiError, clean, getExport, shortBlob, walruscan, type ExportFact, type ExportResponse } from '../api';
import { navigate } from '../chat';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, FieldLabel, Input, Skeleton } from '../ui';
import './CompareView.css';

const norm = (t: string) => clean(t).trim().toLowerCase();

function FactList({ facts }: { facts: ExportFact[] }) {
  if (facts.length === 0) {
    return (
      <Empty
        title="No facts"
        action={<Button size="sm" variant="primary" onClick={() => navigate('chat')}>Teach a fact in chat</Button>}
      >
        Nothing stored under these namespaces yet.
      </Empty>
    );
  }
  return (
    <ul className="cmp-list">
      {facts.map((f, i) => {
        const short = shortBlob(f.blob_id);
        const link = walruscan(f.blob_id);
        return (
          <li key={i} className="cmp-fact">
            <span>{clean(f.text)}</span>
            {short ? (
              <span className="cmp-cite">
                {' '}<code className="mono">{short}</code>
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
    </ul>
  );
}

export default function CompareView({ userId }: { userId: string }) {
  const [aId, setAId] = React.useState(userId || 'demo-mom');
  const [bId, setBId] = React.useState('demo-mom');
  const [a, setA] = React.useState<ExportResponse | null>(null);
  const [b, setB] = React.useState<ExportResponse | null>(null);
  const [compared, setCompared] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  // The left box follows the signed-in user; switching account re-points it.
  React.useEffect(() => {
    setAId(userId || 'demo-mom');
  }, [userId]);

  const compare = React.useCallback(async (x: string, y: string) => {
    const nx = x.trim();
    const ny = y.trim();
    if (!nx || !ny) {
      setError('Type two namespace names to compare — for example your user id and demo-mom.');
      setA(null);
      setB(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [ra, rb] = await Promise.all([getExport(nx), getExport(ny)]);
      setA(ra);
      setB(rb);
      setCompared(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'request failed');
      setA(null);
      setB(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    compare(aId, bId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setA2 = new Set((a?.facts ?? []).map((f) => norm(f.text)));
  const setB2 = new Set((b?.facts ?? []).map((f) => norm(f.text)));
  const shared = (a?.facts ?? []).filter((f) => setB2.has(norm(f.text)));
  const uniqueA = (a?.facts ?? []).filter((f) => !setB2.has(norm(f.text)));
  const uniqueB = (b?.facts ?? []).filter((f) => !setA2.has(norm(f.text)));

  return (
    <div className="cmp-wrap">
      <p className="eyebrow">Namespaces</p>
      <h2 className="cmp-title">Compare namespaces</h2>
      <p className="cmp-hint">
        Compare two memory namespaces side by side. Shared facts and per-namespace facts each cite their blob receipts.
      </p>
      <p className="cmp-hint">
        In plain words: the project needs at least 3 people with 10 memories each.
        Type your user id on the left and demo-mom on the right to check your side —
        nothing from one side should appear on the other.
      </p>
      <form
        className="cmp-form"
        onSubmit={(e) => {
          e.preventDefault();
          compare(aId, bId);
        }}
      >
        <div className="cmp-field">
          <FieldLabel htmlFor="cmp-a">Namespace A</FieldLabel>
          <Input id="cmp-a" value={aId} onChange={(e) => setAId(e.target.value)} placeholder="demo-mom" />
        </div>
        <div className="cmp-field">
          <FieldLabel htmlFor="cmp-b">Namespace B</FieldLabel>
          <Input id="cmp-b" value={bId} onChange={(e) => setBId(e.target.value)} placeholder="demo-day7" />
        </div>
        <div className="cmp-actions">
          <Button type="submit" variant="primary" disabled={loading}>
            {loading ? 'Comparing…' : 'Compare'}
          </Button>
        </div>
      </form>
      <p className="cmp-hint cmp-hint-sm">Tip: namespaces are per user — your id is already in the left box. Both boxes need a name; empty input is an error, not a silent default.</p>

      {loading && !compared ? (
        <div aria-busy="true">
          <Skeleton style={{ height: 120 }} />
          <Skeleton style={{ height: 120 }} />
        </div>
      ) : null}

      {error ? (
        <Alert variant="danger">
          <p style={{ margin: 0 }}>Could not compare these namespaces: {error}. Check the names and retry.</p>
          <div style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => compare(aId, bId)}>Retry</Button>
          </div>
        </Alert>
      ) : null}

      {compared && !loading && a && b ? (
        <>
          <p className="cmp-hint">Ready: {a.facts.length + b.facts.length} memories stored across both namespaces.</p>
          <div className="cmp-counts">
            <Badge variant="default">Shared: {shared.length}</Badge>
            <Badge variant="default">Only in {a.user}: {uniqueA.length}</Badge>
            <Badge variant="default">Only in {b.user}: {uniqueB.length}</Badge>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Shared facts ({shared.length})</CardTitle>
              <CardDescription>Facts present in both namespaces</CardDescription>
            </CardHeader>
            <CardContent>
              <FactList facts={shared} />
            </CardContent>
          </Card>

          <div className="cmp-grid">
            <Card>
              <CardHeader>
                <CardTitle><span className="mono">{a.user}</span> ({a.facts.length})</CardTitle>
                <CardDescription>Namespace {a.user} · Blob count: {a.blobCount} · unique: {uniqueA.length} · {a.mode}</CardDescription>
              </CardHeader>
              <CardContent>
                <FactList facts={a.facts} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle><span className="mono">{b.user}</span> ({b.facts.length})</CardTitle>
                <CardDescription>Namespace {b.user} · Blob count: {b.blobCount} · unique: {uniqueB.length} · {b.mode}</CardDescription>
              </CardHeader>
              <CardContent>
                <FactList facts={b.facts} />
              </CardContent>
            </Card>
          </div>
        </>
      ) : compared && !loading && (!a || !b) && !error ? (
        <Empty
          title="No comparison data"
          action={<Button size="sm" variant="primary" onClick={() => compare(aId, bId)}>Retry</Button>}
        >
          Both namespaces came back empty — check the names and retry.
        </Empty>
      ) : null}
    </div>
  );
}
