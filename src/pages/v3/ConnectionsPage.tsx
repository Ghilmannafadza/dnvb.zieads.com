/*
  DNVB: Connect TikTok. TikTok is the only connector.
  - Add account: the team signs in to TikTok here (TikTok always shows the account screen, so the next account can be added).
  - Connect links: send a link to a creator, they sign in on their own phone, the account lands in this workspace.
  - TikTok Ads: read only, manual CSV import until API access is approved.
  The full list of connected accounts, with numbers and bulk actions, is on /accounts.
*/
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle, Copy, Download, Link2, Plus, Trash2, Upload, Users } from 'lucide-react';
import V3Layout from '../../components/v3/V3Layout';
import { Button, Card, CardTitle, LoadingState, PageBody, PageHeader, Pill } from '../../components/v3/ui';
import SocialIcon from '../../components/v3/SocialIcon';
import { useDemoMode } from '../../lib/demoStore';
import { api, authHeaders } from '../../lib/api';
import { refreshConnections } from '../../lib/connectionsStore';
import './connections.css';

type AdsId = 'tiktok_ads';

const ERROR_TEXT: Record<string, string> = {
  denied: 'You cancelled the connection. Nothing was changed.',
  csrf: 'The connection link expired. Try again.',
  invalid_callback: 'TikTok sent an incomplete response. Try again.',
  exchange_failed: 'the sign in did not finish.',
  limit_reached: 'this workspace is full on its plan. Upgrade or disconnect an account first.',
  wrong_account: 'you signed in to a different TikTok account than the one you wanted to reconnect.',
};

export function expiryInfo(iso?: string | null): { days: number; level: 'ok' | 'soon' | 'expired' } | null {
  if (!iso) return null;
  const days = Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
  return { days, level: days < 0 ? 'expired' : days <= 7 ? 'soon' : 'ok' };
}

interface Invite {
  id: string;
  url: string;
  label: string | null;
  account_group: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string;
  active: boolean;
}

export default function ConnectionsPage() {
  const demo = useDemoMode();
  const navigate = useNavigate();
  const [banner, setBanner] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string; action?: { label: string; to: string } } | null>(null);
  const [fleet, setFleet] = useState<{ used: number; limit: number; groups: string[] } | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [ads, setAds] = useState<any>({});
  const [importOpen, setImportOpen] = useState(false);
  const [form, setForm] = useState({ label: '', group: '', max_uses: 1, expires_days: 7 });
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    if (demo.isActive) {
      setFleet({ used: 3, limit: 150, groups: ['Skincare', 'Fashion'] });
      setLoading(false);
      return;
    }
    try {
      const [f, inv, adsStatus] = await Promise.all([
        api('/api/tiktok/accounts'),
        api('/api/tiktok/invites').catch(() => ({ invites: [] })),
        api('/api/v3/ads/status').catch(() => ({ platforms: {} })),
      ]);
      setFleet({ used: f.used, limit: f.limit, groups: f.groups || [] });
      setInvites(inv.invites || []);
      setAds(adsStatus.platforms?.tiktok_ads || {});
      refreshConnections();
    } catch (e: any) {
      setBanner({ tone: 'bad', text: `Could not load: ${e.message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo.isActive]);

  // Result of the TikTok round trip comes back as query parameters
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const connected = p.get('connected');
    const error = p.get('error');
    if (connected) {
      const who = p.get('account');
      setBanner({ tone: 'good', text: `${who ? `@${who}` : 'The TikTok account'} is connected and its first numbers are in. Add the next one, or open the fleet.`, action: { label: 'Open accounts', to: '/accounts' } });
    } else if (error) {
      const key = error.replace(/^tiktok_/, '');
      setBanner({ tone: 'bad', text: `TikTok: ${ERROR_TEXT[key] || `the connection failed (${key.replace(/_/g, ' ')}). Try again.`}` });
    }
    if (connected || error) window.history.replaceState({}, document.title, window.location.pathname);
  }, []);

  const connect = async () => {
    if (demo.isActive) return setBanner({ tone: 'warn', text: 'Exit demo mode to connect your own accounts.' });
    setBusy('connect');
    try {
      const j = await api<{ url: string }>('/api/auth/tiktok/connect', { body: {} });
      window.location.href = j.url;
    } catch (e: any) {
      setBusy(null);
      setBanner({ tone: 'bad', text: e.message });
    }
  };

  const createInvite = async () => {
    if (demo.isActive) return setBanner({ tone: 'warn', text: 'Exit demo mode to make connect links.' });
    setBusy('invite');
    try {
      const j = await api('/api/tiktok/invites', { body: { label: form.label || undefined, group: form.group || undefined, max_uses: form.max_uses, expires_days: form.expires_days } });
      setInvites((l) => [j.invite, ...l]);
      setForm({ ...form, label: '' });
      copy(j.invite.url, j.invite.id);
    } catch (e: any) {
      setBanner({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/tiktok/invites/${id}`, { method: 'DELETE' });
      setInvites((l) => l.filter((i) => i.id !== id));
    } catch (e: any) {
      setBanner({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    });
  };

  const unlimited = fleet && (fleet.limit === -1 || fleet.limit >= 99999);
  const full = fleet && !unlimited && fleet.used >= fleet.limit;

  return (
    <V3Layout>
      <PageHeader
        title="Connect TikTok"
        subtitle="TikTok is the only network here. Add as many TikTok accounts as your plan holds, then run them from one place."
        actions={
          <Button variant="secondary" icon={<Users size={15} />} onClick={() => navigate('/accounts')}>
            All accounts
          </Button>
        }
      />
      <PageBody>
        {banner && (
          <div className={`zcn-banner tone-${banner.tone}`} role="status">
            {banner.tone === 'good' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            <span>{banner.text}</span>
            {banner.action && (
              <Button size="sm" variant="secondary" onClick={() => navigate(banner.action!.to)}>
                {banner.action.label}
              </Button>
            )}
            <button type="button" className="zd-icon-btn" onClick={() => setBanner(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {loading ? (
          <LoadingState text="Loading" />
        ) : (
          <>
            <div className="zd-grid-2">
              <Card className="zcn-card is-on">
                <div className="zcn-head">
                  <span className="zcn-brand">
                    <SocialIcon platform="tiktok" size={26} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="zcn-name">Add a TikTok account</div>
                    <div className="zcn-type">Profile stats, videos, scheduling and publishing</div>
                  </div>
                  <span className="zcn-status">
                    <Pill tone={full ? 'warn' : 'good'}>
                      {fleet?.used || 0} / {unlimited ? 'unlimited' : fleet?.limit}
                    </Pill>
                  </span>
                </div>
                <ol className="zcn-steps">
                  <li>Click Add account. TikTok opens and always asks which account to use.</li>
                  <li>Sign in to the account you want to add and allow every permission.</li>
                  <li>You come back here. Repeat for the next account.</li>
                </ol>
                <p className="zcn-note">
                  Adding many accounts from one browser? Switch the account inside TikTok's sign in screen, or use a connect link below so each creator signs in on their own phone.
                </p>
                <div className="zcn-foot">
                  <Button full icon={<Plus size={15} />} loading={busy === 'connect'} disabled={!!full} onClick={connect}>
                    {full ? 'Plan is full' : 'Add account'}
                  </Button>
                </div>
              </Card>

              <Card className="zcn-card">
                <CardTitle icon={<Link2 size={16} />} sub="Creators open it on their phone, sign in to TikTok, and the account joins this workspace. No dnvb login needed.">
                  Connect link
                </CardTitle>
                <div className="zcn-form">
                  <label>
                    <span>Label (optional)</span>
                    <input className="zd-input" value={form.label} placeholder="Creator name or store" onChange={(e) => setForm({ ...form, label: e.target.value })} />
                  </label>
                  <label>
                    <span>Group (optional)</span>
                    <input className="zd-input" list="zcn-groups" value={form.group} placeholder="Skincare, Batch 3, Affiliate" onChange={(e) => setForm({ ...form, group: e.target.value })} />
                    <datalist id="zcn-groups">{(fleet?.groups || []).map((g) => <option key={g} value={g} />)}</datalist>
                  </label>
                  <div className="zcn-form-row">
                    <label>
                      <span>Accounts per link</span>
                      <input className="zd-input" type="number" min={1} max={500} value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: Math.max(1, Number(e.target.value) || 1) })} />
                    </label>
                    <label>
                      <span>Valid for (days)</span>
                      <input className="zd-input" type="number" min={1} max={30} value={form.expires_days} onChange={(e) => setForm({ ...form, expires_days: Math.min(30, Math.max(1, Number(e.target.value) || 7)) })} />
                    </label>
                  </div>
                </div>
                <div className="zcn-foot">
                  <Button full variant="soft" icon={<Link2 size={15} />} loading={busy === 'invite'} onClick={createInvite}>
                    Make link and copy
                  </Button>
                </div>
              </Card>
            </div>

            {invites.length > 0 && (
              <section>
                <div className="zcn-group-head">
                  <h2>Connect links</h2>
                  <span className="zd-eyebrow">{invites.filter((i) => i.active).length} active</span>
                </div>
                <Card padding={0}>
                  <ul className="zcn-invites">
                    {invites.map((i) => (
                      <li key={i.id}>
                        <div className="zcn-invite-main">
                          <strong>{i.label || 'Connect link'}</strong>
                          <small>
                            {i.account_group ? `${i.account_group} · ` : ''}
                            {i.used_count}/{i.max_uses} used · until {new Date(i.expires_at).toLocaleDateString()}
                          </small>
                        </div>
                        <Pill tone={i.active ? 'good' : 'neutral'}>{i.active ? 'Active' : 'Done'}</Pill>
                        <Button size="sm" variant="ghost" icon={copied === i.id ? <CheckCircle size={14} /> : <Copy size={14} />} onClick={() => copy(i.url, i.id)}>
                          {copied === i.id ? 'Copied' : 'Copy'}
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} aria-label="Revoke link" loading={busy === i.id} onClick={() => revoke(i.id)} />
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            )}

            <section>
              <div className="zcn-group-head">
                <h2>TikTok Ads, read only</h2>
                <span className="zd-eyebrow">dnvb never changes campaigns or budgets.</span>
              </div>
              <Card className="zcn-card">
                <div className="zcn-head">
                  <span className="zcn-brand">
                    <SocialIcon platform="tiktok" size={26} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="zcn-name">TikTok Ads</div>
                    <div className="zcn-type">Spend, results and ROAS for the Ads Analyst</div>
                  </div>
                  <span className="zcn-status">
                    <Pill tone={ads.imported_rows ? 'good' : 'neutral'}>{ads.imported_rows ? 'Manual import' : 'Not connected'}</Pill>
                  </span>
                </div>
                <div className="zcn-foot">
                  <dl className="zcn-facts">
                    <dt>Imported</dt>
                    <dd>{ads.imported_rows ? `${ads.imported_rows} rows, ${ads.first_date} to ${ads.last_date}` : 'nothing yet'}</dd>
                  </dl>
                  <div className="zcn-actions-row">
                    <Button size="sm" variant="soft" icon={<Upload size={14} />} onClick={() => setImportOpen(true)}>
                      Manual import (CSV)
                    </Button>
                    <a className="zd-btn is-ghost is-sm" href="/api/v3/ads/template" download>
                      <Download size={14} />
                      <span className="zd-btn-text">Template</span>
                    </a>
                  </div>
                </div>
              </Card>
            </section>
          </>
        )}
      </PageBody>
      {importOpen && (
        <AdsImportModal
          platform="tiktok_ads"
          name="TikTok Ads"
          onClose={() => setImportOpen(false)}
          onDone={(n) => {
            setImportOpen(false);
            setBanner({ tone: 'good', text: `Imported ${n} rows. The Ads Analyst and Analytics now read them.` });
            load();
          }}
        />
      )}
    </V3Layout>
  );
}

function AdsImportModal({ platform, name, onClose, onDone }: { platform: AdsId; name: string; onClose: () => void; onDone: (n: number) => void }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<any | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const readFile = (f: File) => {
    setFileName(f.name);
    setErr('');
    setPreview(null);
    const r = new FileReader();
    r.onload = async () => {
      const text = String(r.result || '');
      setCsv(text);
      setBusy(true);
      try {
        const res = await fetch('/api/v3/ads/import', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ platform, csv: text, dry_run: true }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Could not read the file');
        setPreview(j);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
    };
    r.readAsText(f);
  };

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const j = await api('/api/v3/ads/import', { body: { platform, csv } });
      onDone(j.count);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div className="zcn-overlay" role="dialog" aria-modal="true" aria-label={`Manual import for ${name}`}>
      <Card className="zcn-modal is-wide" padding={26}>
        <div className="zcn-modal-head">
          <span className="zd-icon-dot">
            <Upload size={18} />
          </span>
          <div>
            <h3>Manual import: {name}</h3>
            <p>
              Export a daily report from {name} or fill in the <a href="/api/v3/ads/template" download>ZieAds template</a>. Columns: date, campaign, spend, plus impressions, clicks, conversions and revenue if you have them. Importing the same days again replaces them.
            </p>
          </div>
        </div>
        <label className={`zcn-drop ${fileName ? 'has-file' : ''}`}>
          <span className="zcn-drop-icon">
            <Upload size={20} />
          </span>
          <span>{fileName || 'Choose a CSV file'}</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
        </label>
        {busy && !preview && <LoadingState text="Reading the file" inline />}
        {preview && (
          <div className="zcn-preview">
            <p>
              <strong>{preview.count} rows</strong> ready. Spend {money(preview.totals.spend)}, {preview.totals.clicks.toLocaleString()} clicks, {money(preview.totals.conversions)} conversions, revenue {money(preview.totals.revenue)}.
            </p>
            {preview.errors?.length > 0 && (
              <p className="zcn-note">
                {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} skipped, first: line {preview.errors[0].line}, {preview.errors[0].message}
              </p>
            )}
            <div className="zcn-table-wrap">
              <table className="zcn-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Campaign</th>
                    <th>Spend</th>
                    <th>Clicks</th>
                    <th>Conv.</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((r: any) => (
                    <tr key={r.line}>
                      <td>{r.date}</td>
                      <td>{r.campaign}</td>
                      <td>{money(r.spend)}</td>
                      <td>{r.clicks}</td>
                      <td>{r.conversions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {err && <p className="zcn-note is-error">{err}</p>}
        <div className="zcn-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!preview || busy} loading={busy && !!preview}>
            Import {preview ? `${preview.count} rows` : ''}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Connect window for networks that need one value first (Bluesky handle, Mastodon server), or the manual fallback */
