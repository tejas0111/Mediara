import React from 'react';
import { ApiError, clean, getExport, getSummary, shortBlob, walruscan, type SummaryResponse } from '../api';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Empty, Skeleton } from '../ui';
import './PrintView.css';

function FactRow({ text, blobId, allergy }: { text: string; blobId: string | null; allergy?: boolean }) {
  const short = shortBlob(blobId);
  const link = walruscan(blobId);
  return (
    <li className={allergy ? 'pr-item pr-allergy-item' : 'pr-item'}>
      <span>{allergy ? <>&ldquo;{clean(text)}&rdquo;</> : clean(text)}</span>
      {short ? (
        <>
          {' '}<code className="mono">{short}</code>
          {link ? (
            <>
              {' '}<a href={link} target="_blank" rel="noreferrer">walruscan</a>
            </>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export default function PrintView({ userId }: { userId: string }) {
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
      <div className="pr-wrap" aria-busy="true">
        <Skeleton style={{ height: 28, width: '45%' }} />
        <Skeleton style={{ height: 200 }} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger">
        <p style={{ margin: 0 }}>Could not load the emergency card for {userId}: {error}. Do not print from this state — retry first.</p>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </Alert>
    );
  }

  if (!data) {
    return <Empty title="No emergency summary">Nothing stored for {userId} yet — add allergies and medications in chat first.</Empty>;
  }

  const stale = data.stale || !data.allergiesKnown;

  const renderList = (items: string[]) => (
    <ul className="pr-list">
      {items.map((t, i) => (
        <FactRow key={i} text={t} blobId={blobOf(t)} />
      ))}
    </ul>
  );

  return (
    <div className="pr-wrap">
      <p className="eyebrow">Emergency</p>
      <div className="pr-toolbar no-print">
        <Button variant="primary" onClick={() => window.print()}>Print emergency card</Button>
        <span className="pr-toolbar-hint">Allergies print first and large; blob receipts print with every fact.</span>
      </div>

      {stale ? (
        <Alert variant="warn">
          UNKNOWN — this emergency card may be incomplete ({data.stale ? 'stale data' : 'allergy history unconfirmed'}). Verify with the patient or carer.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="pr-big">Emergency card — {data.user}</CardTitle>
        </CardHeader>
        <CardContent>
          <section className="pr-allergies" aria-label="Allergies">
            <h2 className="pr-allergy-h">
              ALLERGIES <Badge variant="danger">critical</Badge>
            </h2>
            {data.allergies.length > 0 ? (
              <ul className="pr-list pr-allergy-list">
                {data.allergies.map((t, i) => (
                  <FactRow key={i} text={t} blobId={blobOf(t)} allergy />
                ))}
              </ul>
            ) : stale ? (
              <p className="pr-unknown">UNKNOWN — allergy history may be incomplete. Assume nothing is safe.</p>
            ) : (
              <p className="pr-muted">No known allergies on record.</p>
            )}
          </section>

          <section aria-label="Medications">
            <h3 className="pr-h">Medications</h3>
            {data.medications.length > 0 ? (
              renderList(data.medications)
            ) : stale ? (
              <p className="pr-unknown">UNKNOWN — medication list may be incomplete.</p>
            ) : (
              <p className="pr-muted">No current medications on record.</p>
            )}
          </section>

          {data.routine.length > 0 ? (
            <section aria-label="Routine">
              <h3 className="pr-h">Daily routine</h3>
              {renderList(data.routine)}
            </section>
          ) : null}

          {data.familyAndCare.length > 0 ? (
            <section aria-label="Contacts">
              <h3 className="pr-h">Family &amp; care contacts</h3>
              {renderList(data.familyAndCare)}
            </section>
          ) : null}

          <p className="pr-blobids">
            Blobs on record: {data.blobCount} · {data.disclaimer} · Generated {data.generatedAt}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
