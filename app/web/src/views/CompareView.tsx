import React from 'react';
import { ApiError, clean, getExport, shortBlob, walruscan, type ExportFact, type ExportResponse } from '../api';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, FieldLabel, Input, Skeleton } from '../ui';
import './CompareView.css';

const norm = (t: string) => clean(t).trim().toLowerCase();

function FactList({ facts }: { facts: ExportFact[] }) {
  if (facts.length === 0) return <Empty title="No facts" />;
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
  void userId;
  const [aId, setAId] = React.useState('demo-mom');
  const [bId, setBId] = React.useState('demo-day7');
  const [a, setA] = React.useState<ExportResponse | null>(null);
  const [b, setB] = React.useState<ExportResponse | null>(null);
  const [compared, setCompared] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const compare = React.useCallback(async (x: string, y: string) => {
    setLoading(true);
    setError(null);
    try {
      const [ra, rb] = await Promise.all([getExport(x.trim() || 'demo-mom'), getExport(y.trim() || 'demo-day7')]);
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
      <h2 className="cmp-title">Compare namespaces</h2>
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

      {loading && !compared ? (
        <div aria-busy="true">
          <Skeleton style={{ height: 120 }} />
          <Skeleton style={{ height: 120 }} />
        </div>
      ) : null}

      {error ? (
        <Alert variant="danger">
          <p style={{ margin: 0 }}>{error}</p>
          <div style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => compare(aId, bId)}>Retry</Button>
          </div>
        </Alert>
      ) : null}

      {compared && !loading && a && b ? (
        <>
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
                <CardTitle>{a.user} ({a.facts.length})</CardTitle>
                <CardDescription>Blob count: {a.blobCount} · unique: {uniqueA.length}</CardDescription>
              </CardHeader>
              <CardContent>
                <FactList facts={a.facts} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{b.user} ({b.facts.length})</CardTitle>
                <CardDescription>Blob count: {b.blobCount} · unique: {uniqueB.length}</CardDescription>
              </CardHeader>
              <CardContent>
                <FactList facts={b.facts} />
              </CardContent>
            </Card>
          </div>
        </>
      ) : compared && !loading && (!a || !b) && !error ? (
        <Empty title="No comparison data" />
      ) : null}
    </div>
  );
}
