import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { exportMemory, ExportFact } from '../api';
import { Button, ScopeBadge, isDemoNamespace } from '../ui';
import './ReplayView.css';

/** Map a fact's position in the timeline onto a proportional day number. */
function dayFor(index: number, total: number): number {
  if (total <= 1) return 1;
  return Math.round(1 + (index / (total - 1)) * 89); // Day 1 .. Day 90
}

/**
 * Day 1 → Day 90 replay: the household's memory accumulating, one day at a
 * time. Facts stay aria-hidden until played. Honors prefers-reduced-motion by
 * showing the full timeline immediately.
 */
export default function ReplayView({ user }: { user: string }) {
  const [facts, setFacts] = useState<ExportFact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reducedMotion = useMemo(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const d = await exportMemory(user);
      const list = d.facts ?? d.memories ?? [];
      setFacts(list);
      setPos(reducedMotion ? list.length : 0);
    } catch {
      setFacts(null);
      setFailed(true);
    }
  }, [user, reducedMotion]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!playing || !facts) return;
    timer.current = setInterval(() => {
      setPos((p) => {
        if (p >= facts.length) {
          setPlaying(false);
          return p;
        }
        return p + 1;
      });
    }, 900);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, facts]);

  const total = facts?.length ?? 0;

  return (
    <div className="replay-wrap">
      <p className="view-note">
        <ScopeBadge user={user} />{' '}
        {isDemoNamespace(user)
          ? 'Premade shared profile — nothing here is yours.'
          : 'Only your own care record is shown here.'}{' '}
        Watch memory accumulate for <code>{user}</code> — and the day a guard
        stops a dangerous dose because of what it already knows.
      </p>

      {failed && (
        <div className="view-empty" role="status">
          The timeline couldn't be loaded right now.
        </div>
      )}

      {facts && total === 0 && (
        <div className="view-empty">No stored days to replay yet.</div>
      )}

      {facts && total > 0 && (
        <>
          <div className="replay-controls">
            <Button
              variant="primary"
              onClick={() => {
                if (pos >= total) setPos(0);
                setPlaying((p) => !p);
              }}
            >
              {playing ? 'Pause' : pos >= total ? 'Replay' : 'Play'}
            </Button>
            <Button
              onClick={() => {
                setPlaying(false);
                setPos(0);
              }}
            >
              Restart
            </Button>
            <span className="replay-day" aria-live="polite">
              Day {dayFor(Math.max(0, pos - 1), total)}
            </span>
            <span className="replay-count">
              {pos}/{total} facts
            </span>
          </div>

          <ol className="timeline">
            {facts.map((f, i) => {
              const shown = i < pos;
              return (
                <li
                  key={i}
                  className={`tl-item ${shown ? 'shown' : ''}`}
                  aria-hidden={!shown}
                >
                  <span className="tl-day">Day {dayFor(i, total)}</span>
                  <span className="tl-text">{shown ? f.text : '…'}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
