import React from 'react';
import { ApiError, clean, getExport, getSeedStatus, shortBlob, walruscan, type ExportResponse, type SeedStatus } from '../api';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, Skeleton } from '../ui';
import './DemoView.css';

const QUESTION = 'What meds does mom take?';
const BEFORE_NS = 'demo-day1';
const AFTER_TRY = 'demo-day7';
const AFTER_FALLBACK = 'demo-mom';

function FactList({ facts }: { facts: ExportResponse['facts'] }) {
  if (facts.length === 0) {
    return <Empty title="No facts yet">Nothing stored under this namespace.</Empty>;
  }
  return (
    <ul className="demo-list">
      {facts.map((f, i) => {
        const short = shortBlob(f.blob_id);
        const link = walruscan(f.blob_id);
        return (
          <li key={i} className="demo-fact">
            <span>{clean(f.text)}</span>
            {short ? (
              <span className="demo-cite">
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

export default function DemoView({ userId }: { userId: string }) {
  void userId;
  const [before, setBefore] = React.useState<ExportResponse | null>(null);
  const [after, setAfter] = React.useState<ExportResponse | null>(null);
  const [afterNs, setAfterNs] = React.useState<string>(AFTER_TRY);
  const [seed, setSeed] = React.useState<SeedStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await getExport(BEFORE_NS);
      setBefore(b);
      let a = await getExport(AFTER_TRY);
      let ns = AFTER_TRY;
      if (a.facts.length === 0) {
        a = await getExport(AFTER_FALLBACK);
        ns = AFTER_FALLBACK;
      }
      setAfter(a);
      setAfterNs(ns);
      try {
        setSeed(await getSeedStatus(ns));
      } catch {
        setSeed(null);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'request failed');
      setBefore(null);
      setAfter(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="demo-wrap" aria-busy="true">
        <Skeleton style={{ height: 24, width: '45%' }} />
        <Skeleton style={{ height: 160 }} />
        <Skeleton style={{ height: 160 }} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger">
        <p style={{ margin: 0 }}>Could not load the demo: {error}. Retry before presenting this view.</p>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </Alert>
    );
  }

  if (!before || !after) {
    return <Empty title="No demo data">Demo namespaces are empty — seed demo data, then reload this view.</Empty>;
  }

  return (
    <div className="demo-wrap">
      <div className="demo-top">
        <h2 className="demo-title">Demo: a week of memory</h2>
        {seed ? (
          <Badge variant={seed.meetsMinimum ? 'ok' : 'warn'}>
            {afterNs} {seed.meetsMinimum ? 'meets minimum' : 'below minimum'}
          </Badge>
        ) : null}
      </div>
      <p className="demo-hint">
        The same fixed question is answered before and after a week of remembered facts.
        Both sides cite their Walrus blob receipts.
      </p>
      <p className="demo-q">Fixed question: &ldquo;{QUESTION}&rdquo;</p>
      <p className="demo-q demo-ns">
        Showing <code className="mono">{afterNs}</code> for AFTER
        {afterNs === AFTER_FALLBACK ? ` (fell back from ${AFTER_TRY}, which was empty)` : ''}.
      </p>

      <div className="demo-grid">
        <Card>
          <CardHeader>
            <CardTitle>BEFORE — <span className="mono">{BEFORE_NS}</span></CardTitle>
            <CardDescription>Namespace {BEFORE_NS} · Blob count: {before.blobCount} · {before.facts.length} facts · {before.mode}</CardDescription>
          </CardHeader>
          <CardContent>
            <FactList facts={before.facts} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>AFTER — <span className="mono">{afterNs}</span></CardTitle>
            <CardDescription>Namespace {afterNs} · Blob count: {after.blobCount} · {after.facts.length} facts · {after.mode}</CardDescription>
          </CardHeader>
          <CardContent>
            <FactList facts={after.facts} />
          </CardContent>
        </Card>
      </div>
      <p className="demo-foot">Confirm with your doctor — this is not medical advice.</p>
    </div>
  );
}
