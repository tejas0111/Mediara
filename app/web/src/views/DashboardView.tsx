import React from 'react';
import { ApiError, getDashboard, walletStatus, type DashboardResponse } from '../api';
import { navigate } from '../chat';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '../ui';
import './DashboardView.css';

const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—');

function QuickLinks() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick links</CardTitle>
        <CardDescription>Jump to the views that need no summary</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="dash-links">
          <Button size="sm" onClick={() => navigate('memory')}>Memory</Button>
          <Button size="sm" onClick={() => navigate('replay')}>Replay</Button>
          <Button size="sm" onClick={() => navigate('proof')}>Guard proof</Button>
          <Button size="sm" onClick={() => navigate('print')}>Print</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardView({ userId }: { userId: string }) {
  const [data, setData] = React.useState<DashboardResponse | null>(null);
  const [vaultLive, setVaultLive] = React.useState<{ signedIn: boolean; onboarded: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getDashboard(userId);
      setData(d ?? null);
      if (!d) setError('The dashboard endpoint returned nothing usable.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'request failed');
      setData(null);
    }
    try {
      const w = await walletStatus();
      setVaultLive({ signedIn: !!w.signedIn, onboarded: !!w.onboarded });
    } catch {
      setVaultLive(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="dash-wrap" aria-busy="true">
        <Skeleton style={{ height: 24, width: '40%' }} />
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 120 }} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="dash-wrap">
        <p className="eyebrow">Dashboard</p>
        <h2 className="dash-title">Dashboard — {userId}</h2>
        <Alert variant="warn">
          <p style={{ margin: 0 }}>
            Dashboard unavailable{error ? `: ${error}` : '.'} The summary endpoint did not respond —
            nothing below is hidden, the numbers simply could not be loaded.
          </p>
          <div style={{ marginTop: 10 }}>
            <Button size="sm" variant="primary" onClick={() => void load()}>Retry</Button>
          </div>
        </Alert>
        <QuickLinks />
      </div>
    );
  }

  const personal = data.personal ?? null;
  const budget = personal?.budget ?? null;
  const vault = data.vault ?? vaultLive ?? null;
  const demo = data.demo ?? null;
  const mode = data.mode === 'mainnet' ? 'mainnet' : 'local';
  const cap = typeof budget?.cap === 'number' && budget.cap > 0 ? budget.cap : null;
  const used = typeof budget?.used === 'number' && budget.used >= 0 ? budget.used : null;
  const pct = cap !== null && used !== null ? Math.min(100, Math.round((used / cap) * 100)) : null;

  return (
    <div className="dash-wrap">
      <p className="eyebrow">Dashboard</p>
      <div className="dash-top">
        <h2 className="dash-title">Dashboard — {data.user || userId}</h2>
        <Badge variant={mode}>{data.mode || 'local'}</Badge>
        {personal?.stale ? <Badge variant="warn">stale</Badge> : <Badge variant="ok">updated</Badge>}
        <Button size="sm" onClick={() => void load()}>Retry</Button>
      </div>
      <p className="dash-hint">
        Live from the dashboard endpoint; — means unavailable, Retry above.
      </p>

      <div className="dash-grid">
        <Card>
          <CardHeader>
            <CardTitle>My memories</CardTitle>
            <CardDescription>Facts stored under your namespace</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="dash-num">{num(personal?.memories)}</p>
            <Button size="sm" onClick={() => navigate('memory')}>Open Memory</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>My turns</CardTitle>
            <CardDescription>Answered chat turns on record</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="dash-num">{num(personal?.turns)}</p>
            <Button size="sm" onClick={() => navigate('chat')}>Open Chat</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Budget</CardTitle>
            <CardDescription>
              {budget?.reset ? `Resets ${budget.reset}` : 'Anonymous usage budget'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="dash-num">
              {used !== null && cap !== null ? `${used}/${cap} used` : '—'}
            </p>
            {pct !== null ? (
              <div
                className="dash-meter"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={cap as number}
                aria-valuenow={used as number}
                aria-label="Anonymous chat budget used"
              >
                <div className="dash-fill" style={{ width: `${pct}%` }} />
              </div>
            ) : (
              <p className="dash-muted">Budget state unknown — sign in for a personal quota.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guard hits</CardTitle>
            <CardDescription>Safety refusals on your history</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="dash-num">{num(personal?.guardHits)}</p>
            <Button size="sm" onClick={() => navigate('proof')}>Open Guard proof</Button>
          </CardContent>
        </Card>
      </div>

      <div className="dash-grid">
        <Card>
          <CardHeader>
            <CardTitle>Vault</CardTitle>
            <CardDescription>Wallet sign-in + private memory vault</CardDescription>
          </CardHeader>
          <CardContent>
            {vault ? (
              <div className="dash-row">
                <Badge variant={vault.signedIn ? 'ok' : 'warn'}>
                  {vault.signedIn ? 'signed in' : 'not signed in'}
                </Badge>
                <Badge variant={vault.onboarded ? 'ok' : 'default'}>
                  {vault.onboarded ? 'Vault ready' : 'vault not set up'}
                </Badge>
              </div>
            ) : (
              <p className="dash-muted">Vault state unknown — the wallet endpoint did not respond.</p>
            )}
            {vault && vault.signedIn && vault.onboarded ? (
              personal?.stale ? (
                <p className="dash-muted">Saving to your vault when memory is reachable.</p>
              ) : (
                <p className="dash-muted">Your chats save to your own memory vault.</p>
              )
            ) : (
              <Button size="sm" variant="primary" onClick={() => navigate('wallet')}>
                {vault?.signedIn ? 'Set up vault' : 'Sign in'}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shared demo</CardTitle>
            <CardDescription>Premade memory anyone can read</CardDescription>
          </CardHeader>
          <CardContent>
            {demo ? (
              <div className="dash-row">
                <Badge variant={demo.ready ? 'ok' : 'warn'}>
                  {demo.ready ? 'demo-mom ready' : 'demo-mom empty'}
                </Badge>
                <span className="dash-muted">{num(demo.blobCount)} blobs</span>
              </div>
            ) : (
              <p className="dash-muted">Demo state unknown — the dashboard did not report it.</p>
            )}
            <Button size="sm" variant="primary" onClick={() => navigate('demo')}>Open demo chat</Button>
          </CardContent>
        </Card>
      </div>

      <QuickLinks />
    </div>
  );
}
