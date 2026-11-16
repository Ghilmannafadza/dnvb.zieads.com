/*
  DNVB: public page a creator lands on after using a connect link (/api/auth/tiktok/invite/:token).
  No login: it only says whether the TikTok account joined the workspace.
*/
import DnvbLogo from '../components/DnvbLogo';

const TEXT: Record<string, { title: string; body: string; ok?: boolean }> = {
  connected: { ok: true, title: 'Your TikTok account is connected', body: 'Thank you. The team can now see your account statistics and schedule videos with you. You can close this page.' },
  denied: { title: 'Connection cancelled', body: 'Nothing was shared. Open the link again if you want to connect after all.' },
  not_found: { title: 'This link does not work', body: 'Ask the team for a new connect link.' },
  revoked: { title: 'This link was switched off', body: 'Ask the team for a new connect link.' },
  expired: { title: 'This link has expired', body: 'Connect links are valid for a limited time. Ask the team for a new one.' },
  used: { title: 'This link was already used', body: 'Each link connects a set number of accounts. Ask the team for a new one.' },
  limit_reached: { title: 'The workspace is full', body: 'The team has reached the number of TikTok accounts on its plan. Let them know.' },
  error: { title: 'Something went wrong', body: 'The connection did not finish. Open the link again in a moment.' },
};

export default function ConnectTikTokPage() {
  const p = new URLSearchParams(window.location.search);
  const key = p.get('connected') ? 'connected' : p.get('status') || (p.get('error') || '').replace(/^tiktok_/, '') || 'error';
  const t = TEXT[key] || TEXT.error;
  const who = p.get('account');
  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, background: '#fff', fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ maxWidth: 420, width: '100%', textAlign: 'center', display: 'grid', gap: 18, justifyItems: 'center' }}>
        <DnvbLogo height={26} />
        <div aria-hidden="true" style={{ width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', background: t.ok ? '#FDEEF5' : '#f4f4f4', color: t.ok ? '#E8478C' : '#666', fontSize: 26, fontWeight: 700 }}>
          {t.ok ? '✓' : '!'}
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#101820', letterSpacing: '-0.01em' }}>{t.title}</h1>
        {who && t.ok && <p style={{ margin: 0, fontWeight: 600, color: '#101820' }}>@{who}</p>}
        <p style={{ margin: 0, color: '#585E63', lineHeight: 1.6 }}>{t.body}</p>
      </div>
    </main>
  );
}
