import { useState } from 'react';
import { ApiError, chat } from '../api';
import { ChatResponse, shortBlob } from '../chat';
import { Button, Card, CardContent, CardHeader, CardTitle, ScopeBadge, ShieldIcon } from '../ui';
import './CompareView.css';

const SIDES = ['demo-day1', 'demo-day7', 'demo-mom'] as const;

interface SideResult {
  res?: ChatResponse;
  err?: string;
}

/**
 * Before/after, live: the same question against two memory namespaces —
 * an empty one versus a taught one. Memory is what changes the answer.
 */
export default function CompareView() {
  const [left, setLeft] = useState<string>('demo-day1');
  const [right, setRight] = useState<string>('demo-day7');
  const [question, setQuestion] = useState('Can she take ibuprofen for her headache?');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ a: SideResult; b: SideResult } | null>(null);

  const run = async () => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setResults(null);
    const ask = async (u: string): Promise<SideResult> => {
      try {
        return { res: await chat(u, question.trim()) };
      } catch (e) {
        return { err: e instanceof ApiError ? e.message : 'Unavailable' };
      }
    };
    const [a, b] = await Promise.all([ask(left), ask(right)]);
    setResults({ a, b });
    setBusy(false);
  };

  const column = (label: string, r: SideResult | undefined) => (
    <Card className="cmp-col">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <ScopeBadge scope="demo" />
      </CardHeader>
      <CardContent>
        {!r && <p className="view-empty">Waiting…</p>}
        {r?.err && <p className="view-empty">{r.err}</p>}
        {r?.res && (
          <>
            {/^STOP\b/.test(r.res.reply) && (
              <div className="cmp-verdict stop">
                <ShieldIcon /> STOP
              </div>
            )}
            {/^CAUTION\b/.test(r.res.reply) && (
              <div className="cmp-verdict caution">CAUTION</div>
            )}
            <p className="cmp-reply">
              {r.res.reply.replace(/^(STOP|CAUTION)\s*[—–-]\s*/, '')}
            </p>
            {(r.res.recalledMeta?.length ?? 0) > 0 && (
              <div className="cmp-sources">
                Recalled ({r.res.recalledMeta!.length}):
                <ul>
                  {r.res.recalledMeta!.map((m, i) => (
                    <li key={i}>
                      {m.text}
                      {m.blobId && <code className="blob">{shortBlob(m.blobId)}</code>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="cmp-wrap">
      <h2 className="cmp-title">Demo Day 1 vs Day 7 — shared premade data</h2>
      <p className="view-note">
        <ScopeBadge scope="demo" /> Premade shared profile — nothing here is
        yours. One question, two memories. Day 1 knows nothing; Day 7 has been
        taught. The difference in the answer is the product.
      </p>

      <div className="cmp-controls">
        <select value={left} onChange={(e) => setLeft(e.target.value)} aria-label="Left memory">
          {SIDES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="cmp-vs">vs</span>
        <select value={right} onChange={(e) => setRight(e.target.value)} aria-label="Right memory">
          {SIDES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="cmp-ask">
        <input
          className="input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Question"
        />
        <Button variant="primary" onClick={run} disabled={busy}>
          {busy ? 'Asking…' : 'Ask both'}
        </Button>
      </div>

      {results && (
        <div className="cmp-cols">
          {column(left, results.a)}
          {column(right, results.b)}
        </div>
      )}
    </div>
  );
}
