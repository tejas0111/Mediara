import React from 'react';
import { ApiError, clean, getExport, getSummary, shortBlob, walruscan, type SummaryResponse } from '../api';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, Skeleton } from '../ui';
import './MemoryView.css';

function FactRow({ text, blobId, allergy }: { text: string; blobId: string | null; allergy?: boolean }) {
  const short = shortBlob(blobId);
  const link = walruscan(blobId);
  return (
    <li className={allergy ? 'mem-fact mem-allergy' : 'mem-fact'}>
      <span className="mem-fact-text">{allergy ? <>&ldquo;{clean(text)}&rdquo;</> : clean(text)}</span>
      {short ? (
        <span className="mem-cite">
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
}

function Section({
  title,
  items,
  blobOf,
  stale,
  allergy,
  emptyUnknown,
  emptyNone,
  badge,
}: {
  title: string;
  items: string[];
  blobOf: (t: string) => string | null;
  stale: boolean;
  allergy?: boolean;
  emptyUnknown: string;
  emptyNone: string;
  badge?: React.ReactNode;
}) {
  return (
    <section className="mem-section" aria-label={title}>
      <h3 className="mem-h">{title}{badge}</h3>
      {items.length > 0 ? (
        <ul className="mem-list">
          {items.map((t, i) => (
            <FactRow key={i} text={t} blobId={blobOf(t)} allergy={allergy} />
          ))}
        </ul>
      ) : stale ? (
        <p className="mem-unknown">{emptyUnknown}</p>
      ) : (
        <p className="mem-muted">{emptyNone}</p>
      )}
    </section>
  );
}

export default function MemoryView({ userId }: { userId: string }) {
  const [data, setData] = React.useState<SummaryResponse | null>(null);
  const [blobOf, setBlobOf] = React.useState<(t: string) => string | null>(() => () => null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, e] = await Promise.all([getSummary(userId), getExport(userId)]);
      const m = new Map<string, string | null>();
      for (const f of e.facts) {
        if (!m.has(f.text)) m.set(f.text, f.blob_id);
        const c = clean(f.text);
        if (!m.has(c)) m.set(c, f.blob_id);
      }
      setBlobOf(() => (t: string) => m.get(t) ?? m.get(clean(t)) ?? null);
      setData(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'request failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="mem-wrap" aria-busy="true">
        <Skeleton style={{ height: 24, width: '40%' }} />
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 120 }} />
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
    return <Empty title="No memory yet" />;
  }

  const stale = data.stale || !data.allergiesKnown;
  const mode = data.mode === 'mainnet' ? 'mainnet' : 'local';

  return (
    <div className="mem-wrap">
      <div className="mem-top">
        <h2 className="mem-title">Memory — {data.user}</h2>
        <Badge variant={mode}>{data.mode}</Badge>
        {stale ? <Badge variant="warn">stale</Badge> : <Badge variant="ok">fresh</Badge>}
        {!data.allergiesKnown ? <Badge variant="danger">allergies unconfirmed</Badge> : null}
      </div>

      {stale ? (
        <Alert variant="warn">
          {data.stale
            ? 'Stale data — this memory may be incomplete. Verify with the patient or carer.'
            : 'Allergy history unconfirmed — assume nothing is safe until checked.'}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Current medications</CardTitle>
          <CardDescription>{data.medications.length} on record</CardDescription>
        </CardHeader>
        <CardContent>
          <Section
            title="Current medications"
            items={data.medications}
            blobOf={blobOf}
            stale={stale}
            emptyUnknown="UNKNOWN — medication list may be incomplete."
            emptyNone="No current medications on record."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Allergies</CardTitle>
          <CardDescription>Critical — quoted verbatim with blob receipts</CardDescription>
        </CardHeader>
        <CardContent>
          <Section
            title="Allergies"
            items={data.allergies}
            blobOf={blobOf}
            stale={stale}
            allergy
            emptyUnknown="UNKNOWN — allergy history may be incomplete. Assume nothing is safe."
            emptyNone="No known allergies on record."
            badge={<Badge variant="danger">critical</Badge>}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stopped</CardTitle>
        </CardHeader>
        <CardContent>
          <Section
            title="Stopped"
            items={data.stopped}
            blobOf={blobOf}
            stale={stale}
            emptyUnknown="UNKNOWN — stopped list may be incomplete."
            emptyNone="No stopped medications on record."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Daily routine</CardTitle>
        </CardHeader>
        <CardContent>
          <Section
            title="Daily routine"
            items={data.routine}
            blobOf={blobOf}
            stale={stale}
            emptyUnknown="UNKNOWN — routine may be incomplete."
            emptyNone="No routine on record."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Family &amp; care</CardTitle>
        </CardHeader>
        <CardContent>
          <Section
            title="Family & care"
            items={data.familyAndCare}
            blobOf={blobOf}
            stale={stale}
            emptyUnknown="UNKNOWN — care contacts may be incomplete."
            emptyNone="No family or care contacts on record."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unclassified</CardTitle>
        </CardHeader>
        <CardContent>
          <Section
            title="Unclassified"
            items={data.unclassified}
            blobOf={blobOf}
            stale={stale}
            emptyUnknown="UNKNOWN — unclassified notes may be incomplete."
            emptyNone="Nothing unclassified."
          />
          <p className="mem-foot">{data.disclaimer} · Generated {data.generatedAt} · Blobs on record: {data.blobCount}</p>
        </CardContent>
      </Card>
    </div>
  );
}
