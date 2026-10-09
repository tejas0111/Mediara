import { useCallback, useEffect, useState } from 'react';
import { dashboard, DashboardData, walletStatus, WalletStatus } from '../api';
import { formatResetIn } from '../chat';
import './DashboardView.css';
import { Badge, Card, CardContent, CardHeader, CardTitle, ScopeBadge, ShieldIcon } from '../ui';

const num = (v: number | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';

/**
 * Honest numbers only: every figure comes from /api/dashboard (or the wallet
 * session); anything the server can't vouch for renders as —, never zero.
 * `personalOnly` hides the shared-demo readiness card for account-personal
 * contexts — the full view (route) keeps it; the Demo area owns the copy.
 */
export default function DashboardView({
  userId,
  personalOnly,
}: {
  userId: string;
  personalOnly?: boolean;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await dashboard(userId));
    } catch {
      setData(null);
      setFailed(true);
    }
    try {
      setStatus(await walletStatus());
    } catch {
      setStatus(null);
    }
  }, [userId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const p = data?.personal;
  const demoCap = data?.demo;
  const vaultReady =
    !!status?.signedIn &&
    !!status?.onboarded &&
    !status?.needsRelink &&
    !status?.pendingPhase;

  return (
    <div className="dash-wrap">
      {failed && (
        <div className="dash-note" role="status">
          Live numbers are unreachable right now — nothing below is estimated.
        </div>
      )}

      <div className="dash-grid">
        <Card>
          <CardHeader>
            <CardTitle>Your activity</CardTitle>
            <ScopeBadge user={userId} />
          </CardHeader>
          <CardContent>
            <div className="stat-sub">Only your own care record is shown here.</div>
            <div className="stat-row">
              <span>Turns this window</span>
              <b>{num(p?.turns)}</b>
            </div>
            <div className="stat-row">
              <span>Facts in memory</span>
              <b>{num(p?.memories)}</b>
            </div>
            <div className="stat-row">
              <span>Guard stops</span>
              <b>{num(p?.guardStops)}</b>
            </div>
            {p?.budget && (
              <div className="stat-row">
                <span>Messages used</span>
                <b>
                  {p.budget.used}/{p.budget.cap}
                </b>
              </div>
            )}
            {p?.budget?.resetAt && (
              <div className="stat-sub">
                Resets in {formatResetIn(p.budget.resetAt, p.budget.resetInHrs)}
              </div>
            )}
          </CardContent>
        </Card>

        {!personalOnly && (
          <Card>
            <CardHeader>
              <CardTitle>Demo readiness</CardTitle>
              <ScopeBadge scope="demo" />
            </CardHeader>
            <CardContent>
              <div className="stat-sub">Premade shared profile — nothing here is yours.</div>
              {demoCap && typeof demoCap.used === 'number' ? (
                <>
                  <div className="stat-row">
                    <span>Shared demo messages used</span>
                    <b>
                      {demoCap.used}/{typeof demoCap.cap === 'number' ? demoCap.cap : '—'}
                    </b>
                  </div>
                  <div className="stat-sub">
                    The walkthrough stays open while this number is below the cap.
                  </div>
                </>
              ) : (
                <div className="stat-sub">Shared demo capacity unavailable.</div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Private vault</CardTitle>
            <ScopeBadge scope="personal" />
          </CardHeader>
          <CardContent>
            {vaultReady ? (
              <div className="vault-line">
                <ShieldIcon />
                <b>Vault ready</b>
                <Badge tone="ok">live</Badge>
              </div>
            ) : (
              <>
                <div className="stat-sub">
                  {status?.signedIn
                    ? 'Signed in — finish setup on the Wallet page to unlock private memory.'
                    : 'Sign in with a Sui wallet to unlock private memory.'}
                </div>
                <a className="dash-cta" href="#/wallet">
                  Go to Wallet
                </a>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {(p?.memoriesCapped || p?.guardStale) && (
        <div className="dash-flags">
          {p?.memoriesCapped && (
            <div className="dash-note">
              Showing the most recent recalled facts — the full count lives in
              Stats.
            </div>
          )}
          {p?.guardStale && (
            <div className="dash-note">
              The guard receipt count is stale — re-check shortly rather than
              trusting a zero.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
