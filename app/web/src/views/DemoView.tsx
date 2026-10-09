import { useEffect, useState } from 'react';
import ChatView, { ChatViewProps } from '../ChatView';
import { dashboard } from '../api';
import { ScopeBadge } from '../ui';
import './DemoView.css';

const DEMO_USER = 'demo-mom';

/**
 * Demo chat — the shared, read-only household (demo-mom). Every conversation
 * here runs against premade memory; teaching attempts are redirected by the
 * server. This wrapper fixes the demo flag so App can route it like any view.
 * The shared-demo used/cap readiness line lives here (demo area), not in
 * account/dashboard-personal contexts.
 */
export default function DemoView(props: Omit<ChatViewProps, 'demo'>) {
  const [used, setUsed] = useState<number | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    dashboard(DEMO_USER)
      .then((d) => {
        if (!live) return;
        const demoUsed =
          d?.demo && typeof d.demo.used === 'number' ? d.demo.used : null;
        const demoCap =
          d?.demo && typeof d.demo.cap === 'number' ? d.demo.cap : null;
        // Fallback: the demo namespace's own budget line carries the same
        // used/cap shape when the shared-demo block has no counters.
        const fb = d?.personal?.budget;
        const fbUsed = typeof fb?.used === 'number' ? fb.used : null;
        const fbCap = typeof fb?.cap === 'number' ? fb.cap : null;
        if (demoUsed != null) {
          setUsed(demoUsed);
          setCap(demoCap);
          setUnavailable(false);
        } else if (fbUsed != null) {
          setUsed(fbUsed);
          setCap(fbCap);
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      })
      .catch(() => {
        if (live) setUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="demo-outer">
      <p className="view-note demo-cap" role="status">
        <ScopeBadge scope="demo" />{' '}
        {unavailable || used == null ? (
          'Shared demo capacity unavailable.'
        ) : (
          <>
            Shared demo messages used {used}/{cap ?? '—'}. The walkthrough
            stays open while this number is below the cap.
          </>
        )}
      </p>
      <ChatView {...props} demo />
    </div>
  );
}
