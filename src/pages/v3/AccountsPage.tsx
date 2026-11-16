/*
  DNVB: TikTok Accounts, the fleet view. One workspace runs 100+ TikTok accounts from this page:
  totals, search, filters, groups, sort, bulk sync, bulk group, bulk disconnect, and "Compose for selected"
  which opens the Composer with those accounts already picked.
  Data: GET /api/tiktok/accounts and /api/tiktok/summary (server/routes/api-tiktok.ts).
*/
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle, ExternalLink, PenTool, Plus, RefreshCw, Search, Tag, Trash2, X } from 'lucide-react';
import V3Layout from '../../components/v3/V3Layout';
import { Button, Card, EmptyState, LoadingState, PageBody, PageHeader, Pill, StatCard } from '../../components/v3/ui';
import SocialIcon from '../../components/v3/SocialIcon';
import { api } from '../../lib/api';
import { useDemoMode } from '../../lib/demoStore';
import { refreshConnections } from '../../lib/connectionsStore';
import './accounts.css';

export interface FleetAccount {
  id: string;
  connection_id: string;
  open_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  label: string | null;
  group: string | null;
  tags: string[];
  status: string;
  last_error: string | null;
  sync_error: string | null;
  connected_at: string;
  last_synced_at: string | null;
  token_expires_at: string | null;
  scopes: string;
  can_publish: boolean;
  followers: number;
  followers_7d_change: number | null;
  likes: number;
  videos: number;
  views_30d: number;
  engagement_30d: number;
  posts_30d: number;
  scheduled: number;
  last_posted_at: string | null;
}

type StatusFilter = 'all' | 'live' | 'attention' | 'idle';
type SortKey = 'followers' | 'views' | 'growth' | 'last_post' | 'name' | 'newest';
const PAGE = 50;

const nf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (n: number) => (n >= 10000 ? nf.format(n) : n.toLocaleString());
const ago = (iso?: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const handleOf = (a: FleetAccount) => `@${(a.username || a.display_name || a.open_id.slice(-6)).replace(/^@/, '')}`;
const nameOf = (a: FleetAccount) => a.label || a.display_name || handleOf(a);
const needsAttention = (a: FleetAccount) => a.status !== 'live' || !!a.sync_error;
const isIdle = (a: FleetAccount) => !a.last_posted_at || Date.now() - new Date(a.last_posted_at).getTime() > 14 * 86400000;

const DEMO: FleetAccount[] = Array.from({ length: 12 }, (_, i) => ({
  id: `demo_${i}`,
  connection_id: `demo_${i}`,
  open_id: `demo_open_${i}`,
  username: ['glowup.id', 'skinlab.daily', 'ootd.jkt', 'dapur.mama', 'gadget.murah', 'kopi.senja'][i % 6] + (i > 5 ? i : ''),
  display_name: '',
  avatar_url: '',
  label: null,
  group: ['Skincare', 'Fashion', 'Food', null][i % 4],
  tags: [],
  status: i === 4 ? 'needs_reconnect' : 'live',
  last_error: null,
  sync_error: null,
  connected_at: new Date(Date.now() - i * 86400000).toISOString(),
  last_synced_at: new Date(Date.now() - i * 900000).toISOString(),
  token_expires_at: null,
  scopes: 'video.list,user.info.stats',
  can_publish: i % 3 !== 0,
  followers: 2000 + ((i * 7919) % 90000),
  followers_7d_change: ((i * 37) % 900) - 120,
  likes: 0,
  videos: 20 + i * 3,
  views_30d: 10000 + ((i * 104729) % 900000),
  engagement_30d: 900 + i * 210,
  posts_30d: (i * 5) % 31,
  scheduled: i % 4,
  last_posted_at: i === 7 ? null : new Date(Date.now() - i * 2 * 86400000).toISOString(),
}));

export default function AccountsPage() {
  const navigate = useNavigate();
  const demo = useDemoMode();
  const [accounts, setAccounts] = useState<FleetAccount[]>([]);
  const [limit, setLimit] = useState<number>(0);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('followers');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [groupInput, setGroupInput] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string[] | null>(null);
  const [drawer, setDrawer] = useState<FleetAccount | null>(null);

  const load = async () => {
    if (demo.isActive) {
      setAccounts(DEMO);
      setLimit(150);
      setSummary(null);
      setLoading(false);
      return;
    }
    try {
      const [a, s] = await Promise.all([api('/api/tiktok/accounts'), api('/api/tiktok/summary').catch(() => null)]);
      setAccounts(a.accounts || []);
      setLimit(a.limit);
      setSummary(s);
    } catch (e: any) {
      setBanner({ tone: 'bad', text: `Could not load the accounts: ${e.message}` });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo.isActive]);

  const groups = useMemo(() => [...new Set(accounts.map((a) => a.group).filter(Boolean))].sort() as string[], [accounts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^@/, '');
    let list = accounts.filter((a) => {
      if (group === '__none' ? a.group : group !== 'all' && a.group !== group) return false;
      if (status === 'live' && needsAttention(a)) return false;
      if (status === 'attention' && !needsAttention(a)) return false;
      if (status === 'idle' && !isIdle(a)) return false;
      if (!needle) return true;
      return [a.username, a.display_name, a.label, a.group, ...(a.tags || [])].some((v) => (v || '').toLowerCase().includes(needle));
    });
    const by: Record<SortKey, (a: FleetAccount, b: FleetAccount) => number> = {
      followers: (a, b) => b.followers - a.followers,
      views: (a, b) => b.views_30d - a.views_30d,
      growth: (a, b) => (b.followers_7d_change || 0) - (a.followers_7d_change || 0),
      last_post: (a, b) => (b.last_posted_at || '').localeCompare(a.last_posted_at || ''),
      name: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      newest: (a, b) => b.connected_at.localeCompare(a.connected_at),
    };
    list = [...list].sort(by[sort]);
    return list;
  }, [accounts, q, group, status, sort]);

  useEffect(() => setPage(0), [q, group, status, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const rows = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleAllPage = () =>
    setSelected((s) => {
      const n = new Set(s);
      rows.forEach((r) => (allOnPage ? n.delete(r.id) : n.add(r.id)));
      return n;
    });
  const selectAllFiltered = () => setSelected(new Set(filtered.map((a) => a.id)));

  const guardDemo = () => {
    if (demo.isActive) {
      setBanner({ tone: 'bad', text: 'Demo mode: exit demo to change real accounts.' });
      return true;
    }
    return false;
  };

  const sync = async (ids?: string[]) => {
    if (guardDemo()) return;
    setBusy(ids?.length === 1 ? `sync:${ids[0]}` : 'sync');
    try {
      const r = await api('/api/tiktok/accounts/sync', { body: { account_ids: ids || [] } });
      setBanner({ tone: r.failed ? 'bad' : 'good', text: `${r.synced} account${r.synced === 1 ? '' : 's'} synced${r.failed ? `, ${r.failed} failed (see the status column)` : ''}.` });
      await load();
    } catch (e: any) {
      setBanner({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const setGroupFor = async (ids: string[], value: string) => {
    if (guardDemo()) return;
    setBusy('group');
    try {
      await api('/api/tiktok/accounts', { method: 'PATCH', body: { account_ids: ids, group: value.trim() || null } });
      setGroupInput(null);
      setBanner({ tone: 'good', text: value.trim() ? `${ids.length} account${ids.length > 1 ? 's' : ''} moved to ${value.trim()}.` : 'Group removed.' });
      await load();
    } catch (e: any) {
      setBanner({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (ids: string[]) => {
    if (guardDemo()) return;
    setBusy('disconnect');
    try {
      await api('/api/tiktok/accounts/disconnect', { body: { account_ids: ids } });
      setConfirmDisconnect(null);
      setSelected(new Set());
      setDrawer(null);
      setBanner({ tone: 'good', text: `${ids.length} account${ids.length > 1 ? 's' : ''} disconnected and the stored data deleted.` });
      await load();
      refreshConnections();
    } catch (e: any) {
      setBanner({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const reconnect = async (a: FleetAccount) => {
    if (guardDemo()) return;
    try {
      const j = await api<{ url: string }>('/api/auth/tiktok/connect', { body: { reconnect: a.open_id } });
      window.location.href = j.url;
    } catch (e: any) {
      setBanner({ tone: 'bad', text: e.message });
    }
  };

  const compose = (ids: string[]) => navigate(`/composer?accounts=${encodeURIComponent(ids.join(','))}`);

  const t = summary?.totals;
  const unlimited = limit === -1 || limit >= 99999;
  const totals = t || {
    followers: accounts.reduce((s, a) => s + a.followers, 0),
    followers_7d_change: accounts.reduce((s, a) => s + (a.followers_7d_change || 0), 0),
    views_30d: accounts.reduce((s, a) => s + a.views_30d, 0),
    posts_30d: accounts.reduce((s, a) => s + a.posts_30d, 0),
    scheduled: accounts.reduce((s, a) => s + a.scheduled, 0),
    needs_attention: accounts.filter(needsAttention).length,
    idle_14d: accounts.filter(isIdle).length,
  };
  const selectedIds = [...selected];

  return (
    <V3Layout>
      <PageHeader
        title="TikTok accounts"
        subtitle={`${accounts.length} account${accounts.length === 1 ? '' : 's'} in this workspace${unlimited ? '' : `, room for ${Math.max(0, limit - accounts.length)} more on your plan`}.`}
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw size={15} />} loading={busy === 'sync'} onClick={() => sync()} disabled={!accounts.length}>
              Sync all
            </Button>
            <Button icon={<Plus size={15} />} onClick={() => navigate('/connections')}>
              Add account
            </Button>
          </>
        }
      />
      <PageBody wide>
        {banner && (
          <div className={`zac-banner tone-${banner.tone}`} role="status">
            {banner.tone === 'good' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            <span>{banner.text}</span>
            <button type="button" className="zd-icon-btn" onClick={() => setBanner(null)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {loading ? (
          <LoadingState text="Loading your TikTok accounts" />
        ) : !accounts.length ? (
          <EmptyState
            icon={<SocialIcon platform="tiktok" size={28} />}
            title="No TikTok accounts yet"
            body="Connect your first TikTok account, or send connect links to your creators. Each account gets its own numbers, calendar and publishing."
            action={
              <Button icon={<Plus size={15} />} onClick={() => navigate('/connections')}>
                Connect TikTok
              </Button>
            }
          />
        ) : (
          <>
            <div className="zac-stats">
              <StatCard label="Accounts" value={accounts.length} hint={unlimited ? 'Unlimited plan' : `of ${limit} on your plan`} />
              <StatCard label="Total followers" value={totals.followers} hint={`${totals.followers_7d_change >= 0 ? '+' : ''}${fmt(totals.followers_7d_change)} in 7 days`} hintTone={totals.followers_7d_change >= 0 ? 'good' : 'bad'} />
              <StatCard label="Views, 30 days" value={totals.views_30d} hint={`${fmt(totals.posts_30d)} videos posted`} />
              <StatCard label="Scheduled" value={totals.scheduled} hint="posts waiting to go out" />
              <StatCard label="Need attention" value={totals.needs_attention} hint={`${totals.idle_14d} idle for 14+ days`} hintTone={totals.needs_attention ? 'bad' : 'muted'} />
            </div>

            {summary?.trend && (
              <div className="zac-trends">
                <Card className="zac-trend">
                  <div className="zac-trend-head">
                    <span className="zd-eyebrow">Followers, all accounts</span>
                    <strong>{fmt(summary.trend.followers.at(-1)?.value || 0)}</strong>
                  </div>
                  <Spark points={summary.trend.followers.map((p: any) => p.value)} />
                </Card>
                <Card className="zac-trend">
                  <div className="zac-trend-head">
                    <span className="zd-eyebrow">Views of new videos per day</span>
                    <strong>{fmt(summary.trend.views.reduce((s: number, p: any) => s + p.value, 0))}</strong>
                  </div>
                  <Spark points={summary.trend.views.map((p: any) => p.value)} bars />
                </Card>
              </div>
            )}

            <Card padding={0} className="zac-table-card">
              <div className="zac-toolbar">
                <label className="zac-search">
                  <Search size={15} />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search handle, label, group or tag" aria-label="Search accounts" />
                </label>
                <select className="zd-select zac-select" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
                  <option value="all">All groups</option>
                  {groups.map((g) => (
                    <option key={g} value={g}>
                      {g} ({accounts.filter((a) => a.group === g).length})
                    </option>
                  ))}
                  <option value="__none">No group</option>
                </select>
                <select className="zd-select zac-select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
                  <option value="all">Every status</option>
                  <option value="live">Live</option>
                  <option value="attention">Needs attention</option>
                  <option value="idle">Idle 14+ days</option>
                </select>
                <select className="zd-select zac-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
                  <option value="followers">Most followers</option>
                  <option value="views">Most views (30d)</option>
                  <option value="growth">Fastest growth (7d)</option>
                  <option value="last_post">Posted most recently</option>
                  <option value="name">Name A-Z</option>
                  <option value="newest">Newest connected</option>
                </select>
                <span className="zac-count">{filtered.length} shown</span>
              </div>

              {selected.size > 0 && (
                <div className="zac-bulk" role="toolbar" aria-label="Bulk actions">
                  <strong>{selected.size} selected</strong>
                  {selected.size < filtered.length && (
                    <button type="button" className="zd-link" onClick={selectAllFiltered}>
                      Select all {filtered.length}
                    </button>
                  )}
                  <span className="zac-bulk-sp" />
                  <Button size="sm" icon={<PenTool size={14} />} onClick={() => compose(selectedIds)}>
                    Compose for {selected.size}
                  </Button>
                  <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} loading={busy === 'sync'} onClick={() => sync(selectedIds)}>
                    Sync
                  </Button>
                  {groupInput === null ? (
                    <Button size="sm" variant="secondary" icon={<Tag size={14} />} onClick={() => setGroupInput('')}>
                      Set group
                    </Button>
                  ) : (
                    <span className="zac-group-edit">
                      <input className="zd-input" list="zac-groups" autoFocus value={groupInput} placeholder="Group name" onChange={(e) => setGroupInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setGroupFor(selectedIds, groupInput)} />
                      <datalist id="zac-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
                      <Button size="sm" loading={busy === 'group'} onClick={() => setGroupFor(selectedIds, groupInput)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setGroupInput(null)}>
                        Cancel
                      </Button>
                    </span>
                  )}
                  <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDisconnect(selectedIds)}>
                    Disconnect
                  </Button>
                  <button type="button" className="zd-icon-btn" onClick={() => setSelected(new Set())} aria-label="Clear selection">
                    <X size={14} />
                  </button>
                </div>
              )}

              <div className="zac-table-wrap">
                <table className="zac-table">
                  <thead>
                    <tr>
                      <th className="zac-cb">
                        <input type="checkbox" checked={allOnPage} onChange={toggleAllPage} aria-label="Select every account on this page" />
                      </th>
                      <th>Account</th>
                      <th>Group</th>
                      <th className="num">Followers</th>
                      <th className="num">7 days</th>
                      <th className="num">Views 30d</th>
                      <th className="num">Videos 30d</th>
                      <th className="num">Queued</th>
                      <th>Last post</th>
                      <th>Status</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const attention = needsAttention(a);
                      return (
                        <tr key={a.id} className={selected.has(a.id) ? 'is-selected' : ''}>
                          <td className="zac-cb">
                            <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Select ${handleOf(a)}`} />
                          </td>
                          <td>
                            <button type="button" className="zac-acct" onClick={() => setDrawer(a)}>
                              <Avatar a={a} />
                              <span className="zac-acct-text">
                                <strong>{nameOf(a)}</strong>
                                <small>{handleOf(a)}</small>
                              </span>
                            </button>
                          </td>
                          <td>{a.group ? <span className="zac-group">{a.group}</span> : <span className="zac-muted">-</span>}</td>
                          <td className="num">{fmt(a.followers)}</td>
                          <td className={`num ${a.followers_7d_change == null ? 'zac-muted' : a.followers_7d_change >= 0 ? 'zac-up' : 'zac-down'}`}>
                            {a.followers_7d_change == null ? '-' : `${a.followers_7d_change >= 0 ? '+' : ''}${fmt(a.followers_7d_change)}`}
                          </td>
                          <td className="num">{fmt(a.views_30d)}</td>
                          <td className="num">{a.posts_30d}</td>
                          <td className="num">{a.scheduled || <span className="zac-muted">0</span>}</td>
                          <td className={isIdle(a) ? 'zac-warn-text' : ''}>{ago(a.last_posted_at)}</td>
                          <td>
                            <Pill tone={attention ? (a.status === 'live' ? 'warn' : 'bad') : 'good'}>{a.status === 'needs_reconnect' || a.status === 'revoked' ? 'Reconnect' : a.sync_error ? 'Sync error' : 'Live'}</Pill>
                            <div className="zac-sub">synced {ago(a.last_synced_at)}</div>
                          </td>
                          <td className="zac-actions">
                            {a.status === 'needs_reconnect' || a.status === 'revoked' ? (
                              <Button size="sm" variant="soft" onClick={() => reconnect(a)}>
                                Reconnect
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} aria-label={`Sync ${handleOf(a)}`} loading={busy === `sync:${a.id}`} onClick={() => sync([a.id])} />
                            )}
                            <Button size="sm" variant="ghost" icon={<PenTool size={14} />} aria-label={`Compose for ${handleOf(a)}`} onClick={() => compose([a.id])} />
                          </td>
                        </tr>
                      );
                    })}
                    {!rows.length && (
                      <tr>
                        <td colSpan={11} className="zac-none">
                          No account matches these filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="zac-pager">
                  <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <span>
                    Page {page + 1} of {pages}
                  </span>
                  <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              )}
            </Card>
          </>
        )}
      </PageBody>

      {confirmDisconnect && (
        <div className="zac-overlay" role="dialog" aria-modal="true" aria-label="Disconnect accounts">
          <Card className="zac-modal" padding={24}>
            <h3>
              Disconnect {confirmDisconnect.length} account{confirmDisconnect.length > 1 ? 's' : ''}?
            </h3>
            <p>Their stored videos, numbers and unpublished posts are deleted. Published TikTok videos stay on TikTok. You can connect them again later.</p>
            <div className="zac-modal-actions">
              <Button variant="ghost" onClick={() => setConfirmDisconnect(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy === 'disconnect'} onClick={() => disconnect(confirmDisconnect)}>
                Disconnect
              </Button>
            </div>
          </Card>
        </div>
      )}

      {drawer && (
        <AccountDrawer
          account={drawer}
          groups={groups}
          demo={demo.isActive}
          onClose={() => setDrawer(null)}
          onSaved={async (text) => {
            setBanner({ tone: 'good', text });
            await load();
          }}
          onCompose={() => compose([drawer.id])}
          onReconnect={() => reconnect(drawer)}
          onDisconnect={() => setConfirmDisconnect([drawer.id])}
        />
      )}
    </V3Layout>
  );
}

function Avatar({ a, size = 34 }: { a: FleetAccount; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="zac-av" style={{ width: size, height: size }}>
      {a.avatar_url && !broken ? <img src={a.avatar_url} alt="" onError={() => setBroken(true)} /> : <span>{nameOf(a).replace(/^@/, '').slice(0, 1).toUpperCase()}</span>}
      <i>
        <SocialIcon platform="tiktok" size={12} />
      </i>
    </span>
  );
}

/** Tiny trend line or bars, no axes: the number next to it carries the meaning */
function Spark({ points, bars = false }: { points: number[]; bars?: boolean }) {
  const w = 300;
  const h = 56;
  const max = Math.max(1, ...points);
  const min = bars ? 0 : Math.min(...points);
  const span = Math.max(1, max - min);
  if (!points.length) return null;
  if (bars) {
    const bw = w / points.length;
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="zac-spark" preserveAspectRatio="none" aria-hidden="true">
        {points.map((p, i) => (
          <rect key={i} x={i * bw + 1} y={h - ((p - min) / span) * (h - 4)} width={Math.max(1, bw - 2)} height={((p - min) / span) * (h - 4)} rx={1.5} />
        ))}
      </svg>
    );
  }
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, points.length - 1)) * w},${h - 2 - ((p - min) / span) * (h - 6)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="zac-spark" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function AccountDrawer({
  account: a,
  groups,
  demo,
  onClose,
  onSaved,
  onCompose,
  onReconnect,
  onDisconnect,
}: {
  account: FleetAccount;
  groups: string[];
  demo: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
  onCompose: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const [label, setLabel] = useState(a.label || '');
  const [group, setGroup] = useState(a.group || '');
  const [tags, setTags] = useState((a.tags || []).join(', '));
  const [videos, setVideos] = useState<any[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (demo) return setVideos([]);
    api(`/api/tiktok/accounts/${a.id}/videos?limit=24`)
      .then((j) => setVideos(j.videos || []))
      .catch(() => setVideos([]));
  }, [a.id, demo]);

  const save = async () => {
    if (demo) return setErr('Demo mode: exit demo to edit real accounts.');
    setSaving(true);
    setErr('');
    try {
      await api('/api/tiktok/accounts', {
        method: 'PATCH',
        body: { account_ids: [a.id], label: label.trim() || null, group: group.trim() || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) },
      });
      onSaved(`${handleOf(a)} saved.`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="zac-overlay is-drawer" role="dialog" aria-modal="true" aria-label={`Account ${handleOf(a)}`} onClick={onClose}>
      <aside className="zac-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="zac-drawer-head">
          <Avatar a={a} size={46} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>{nameOf(a)}</h3>
            <a href={`https://www.tiktok.com/${handleOf(a)}`} target="_blank" rel="noreferrer" className="zac-ext">
              {handleOf(a)} <ExternalLink size={12} />
            </a>
          </div>
          <button type="button" className="zd-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="zac-drawer-stats">
          <div>
            <span>Followers</span>
            <strong>{fmt(a.followers)}</strong>
          </div>
          <div>
            <span>Views 30d</span>
            <strong>{fmt(a.views_30d)}</strong>
          </div>
          <div>
            <span>Videos 30d</span>
            <strong>{a.posts_30d}</strong>
          </div>
          <div>
            <span>Queued</span>
            <strong>{a.scheduled}</strong>
          </div>
        </div>

        {(a.last_error || a.sync_error) && (
          <div className="zac-banner tone-bad">
            <AlertTriangle size={16} />
            <span>{a.last_error || a.sync_error}</span>
          </div>
        )}
        <p className="zac-sub" style={{ margin: 0 }}>
          {a.can_publish ? 'Publishing allowed for this account.' : 'Publishing permission not granted yet: posts become reminders until TikTok approves the app.'} Synced {ago(a.last_synced_at)}.
        </p>

        <div className="zac-form">
          <label>
            <span>Label</span>
            <input className="zd-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Internal name, for example Store Bandung" />
          </label>
          <label>
            <span>Group</span>
            <input className="zd-input" list="zac-drawer-groups" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Skincare, Batch 3, Affiliate" />
            <datalist id="zac-drawer-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </label>
          <label>
            <span>Tags, comma separated</span>
            <input className="zd-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="female, 18-24, jakarta" />
          </label>
          {err && <p className="zac-err">{err}</p>}
          <div className="zac-modal-actions">
            <Button variant="secondary" onClick={onCompose} icon={<PenTool size={14} />}>
              Compose
            </Button>
            <Button loading={saving} onClick={save}>
              Save
            </Button>
          </div>
        </div>

        <div>
          <div className="zac-drawer-sec">Recent videos</div>
          {videos === null ? (
            <LoadingState inline text="Loading videos" />
          ) : !videos.length ? (
            <p className="zac-sub">No videos synced yet.</p>
          ) : (
            <div className="zac-videos">
              {videos.map((v) => (
                <a key={v.id} href={v.url || '#'} target="_blank" rel="noreferrer" className="zac-video" title={v.caption}>
                  {v.cover ? <img src={v.cover} alt="" loading="lazy" /> : <span />}
                  <small>{fmt(v.views)} views</small>
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="zac-drawer-foot">
          <Button variant="ghost" onClick={onReconnect} icon={<RefreshCw size={14} />}>
            Reconnect
          </Button>
          <Button variant="danger" onClick={onDisconnect} icon={<Trash2 size={14} />}>
            Disconnect
          </Button>
        </div>
      </aside>
    </div>
  );
}
