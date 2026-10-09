import { useCallback, useEffect, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { usage, Usage } from '../api';
import { Badge, ScopeBadge } from '../ui';
import './StatsView.css';

/**
 * Shorten a namespace/user id for display so a stranger's full id or wallet
 * address never renders. 0x addresses keep both ends (`0x1234…abcd`
 * style: first 6 + … + last 4); anything else is truncated to ≤12 chars.
 */
export function shortUserId(id?: string | null): string {
  if (id == null || id === '') return '—';
  const s = String(id);
  if (/^0x/i.test(s) && s.length > 10) {
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
  }
  if (s.length <= 12) return s;
  return `${s.slice(0, 11)}…`;
}

export interface StatsViewProps {
  currentUser?: string;
  userId?: string;
  walletAddress?: string | null;
}

/**
 * Real-use evidence: per-user memory counts straight from /api/usage.
 * The hackathon bar is at least 3 users with at least 10 memories each.
 * Privacy: rows show the shortened id, counts, and requirement badges only.
 * A stranger's full id/address and firstSeen/lastSeen never render — only
 * the viewer's own row (matched case-insensitively via prop or connected
 * wallet address) gets a "you" badge and may show its own timestamps.
 */
export default function StatsView({
  currentUser,
  userId,
  walletAddress,
}: StatsViewProps = {}) {
  const account = useCurrentAccount();
  const [data, setData] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await usage());
    } catch {
      setData(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const users = data?.users ?? [];
  const qualifying = users.filter((u) => (u.memories ?? 0) >= 10).length;
  const barMet = users.length >= 3 && qualifying >= 3;

  const selfRaw = currentUser ?? userId ?? '';
  const walletRaw = walletAddress ?? account?.address ?? '';
  const selfNorm = selfRaw.trim().toLowerCase();
  const walletNorm = walletRaw.trim().toLowerCase();
  const isOwn = (raw: string): boolean => {
    const n = raw.trim().toLowerCase();
    if (!n) return false;
    return (
      (selfNorm !== '' && n === selfNorm) ||
      (walletNorm !== '' && n === walletNorm)
    );
  };

  return (
    <div className="st-wrap">
      <p className="view-note">
        Live usage, judgeable: each row is one memory namespace. Demo rows are
        premade shared data — nothing there is yours; other rows are personal
        vaults. Blob texts are
        redacted to non-owners — counts are public, contents are not. Ids are
        shortened — your own row carries a you badge.
      </p>

      {failed && (
        <div className="view-empty" role="status">
          Usage numbers are unreachable right now.
        </div>
      )}

      {data && (
        <>
          <div className={`st-bar ${barMet ? 'met' : ''}`}>
            {barMet
              ? 'Real-use bar met: 3+ users with 10+ memories each.'
              : `Real-use bar: ${users.length} user(s), ${qualifying} with 10+ memories — need 3 and 3.`}
          </div>

          <table className="st-table">
            <thead>
              <tr>
                <th>Namespace</th>
                <th>Scope</th>
                <th>Memories</th>
                <th>Turns</th>
                <th>Guard stops</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const raw = String(u.namespace ?? u.user ?? u.id ?? '');
                const own = isOwn(raw);
                const seen =
                  own && (u.firstSeen || u.lastSeen)
                    ? [u.firstSeen, u.lastSeen].filter(Boolean).join(' → ')
                    : '';
                return (
                  <tr key={u.id ?? u.user ?? u.namespace ?? i}>
                    <td>
                      <code>{raw ? shortUserId(raw) : '—'}</code>{' '}
                      {own && <Badge tone="ok">you</Badge>}
                      {seen && <div className="st-seen">{seen}</div>}
                    </td>
                    <td>
                      <ScopeBadge
                        user={String(u.namespace ?? u.user ?? u.id ?? '')}
                      />
                    </td>
                    <td>{u.memories ?? '—'}</td>
                    <td>{u.turns ?? '—'}</td>
                    <td>{u.guards ?? '—'}</td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5}>No usage recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// Keep the per-row scope badges: demo namespaces render Shared demo,
// personal vaults render Personal vault — counts stay public either way.
