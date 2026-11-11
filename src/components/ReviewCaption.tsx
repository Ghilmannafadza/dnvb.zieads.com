/*
  Review mode: an English caption bar for Meta App Review screencasts.
  Turn on with ?review=facebook, ?review=instagram or ?review=threads on any ZieAds page; turn off with ?review=off.
  The bar follows the page and the button that was clicked, and names the permission each step uses, so the
  recording needs no editing afterwards. Only the person who turns it on sees it (stored in this browser).
*/
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

type Platform = 'facebook' | 'instagram' | 'threads';
type Script = {
  name: string;
  login: string;
  all: string[];
  basic: string;
  publish: string;
  read: string;
  reply: string;
  insights: string | null;
};

const SCRIPTS: Record<Platform, Script> = {
  facebook: {
    name: 'Facebook Page',
    login: 'Facebook Login for Business',
    all: ['pages_show_list', 'business_management', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_engagement', 'pages_manage_metadata', 'read_insights'],
    basic: 'pages_show_list and business_management: ZieAds lists the Pages this person manages so they can pick one',
    publish: 'pages_manage_posts',
    read: 'pages_read_user_content and pages_manage_metadata (comments arrive by webhook)',
    reply: 'pages_manage_engagement',
    insights: 'read_insights and pages_read_engagement',
  },
  instagram: {
    name: 'Instagram',
    login: 'Instagram Login',
    all: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_insights'],
    basic: 'instagram_business_basic: ZieAds shows the connected account name, picture and posts',
    publish: 'instagram_business_content_publish',
    read: 'instagram_business_manage_comments',
    reply: 'instagram_business_manage_comments',
    insights: 'instagram_business_manage_insights',
  },
  threads: {
    name: 'Threads',
    login: 'Threads Login on threads.net',
    all: ['threads_basic', 'threads_content_publish', 'threads_read_replies', 'threads_manage_replies'],
    basic: 'threads_basic: ZieAds shows the connected profile name, picture and posts',
    publish: 'threads_content_publish',
    read: 'threads_read_replies',
    reply: 'threads_manage_replies',
    insights: null,
  },
};

const KEY = 'zieads_review_mode';
const isPlatform = (v: string | null): v is Platform => v === 'facebook' || v === 'instagram' || v === 'threads';

type Caption = { step: string; text: string };

function routeCaption(path: string, search: string, s: Script): Caption | null {
  const q = new URLSearchParams(search);
  if (path.startsWith('/sign-in')) return { step: 'Step 1', text: 'The tester signs in to ZieAds with the test account from the review notes.' };
  if (path === '/connections') {
    if (q.get('connected')) return { step: 'Step 3', text: `Back in ZieAds: ${s.name} is connected after the user granted ${s.all.join(', ')}. ${s.basic}.` };
    if (q.get('error')) return { step: 'Note', text: `The user cancelled the ${s.login} screen, so nothing was connected.` };
    return { step: 'Step 2', text: `Connections page. Click "Connect" on ${s.name} to start ${s.login}.` };
  }
  if (path === '/composer') return { step: 'Step 4', text: `Composer: write a caption, add a photo or video, select the ${s.name} account and press "Publish now" (${s.publish}).` };
  if (path === '/calendar') return { step: 'Step 4', text: `Calendar: the published post is listed with its live ${s.name} link. Open it to show the post on ${s.name}.` };
  if (path === '/comments') return { step: 'Step 5', text: `Comments inbox: comments on the ${s.name} posts appear here (${s.read}). Type a reply and press "Reply".` };
  if (path === '/analytics') {
    return s.insights
      ? { step: 'Step 6', text: `Analytics: reach, engagement and followers for the connected ${s.name} account (${s.insights}).` }
      : { step: 'Step 6', text: `${s.name} analytics are not part of this review. Next: Connections, then "Disconnect".` };
  }
  return null;
}

function clickCaption(label: string, path: string, s: Script): Caption | null {
  const t = label.trim().toLowerCase();
  if (!t) return null;
  if (path === '/connections' && /^(connect|reconnect)\b/.test(t)) return { step: 'Step 2', text: `Opening ${s.login}. The user logs in and allows: ${s.all.join(', ')}.` };
  if (/switch page|use this page|select page/.test(t)) return { step: 'Step 3', text: `${s.basic}.` };
  if (/^publish now|^post now/.test(t)) return { step: 'Step 4', text: `${s.publish}: ZieAds publishes this post to ${s.name} now. Next, open the post on ${s.name}.` };
  if (/^schedule/.test(t)) return { step: 'Step 4', text: `${s.publish}: the post is scheduled and ZieAds publishes it to ${s.name} at that time.` };
  if (path === '/comments' && /^(reply|send)$/.test(t)) return { step: 'Step 5', text: `${s.reply}: the reply is posted on ${s.name} as the account. Next, show the reply on ${s.name}.` };
  if (/^disconnect$/.test(t)) return { step: 'Step 7', text: `Disconnect: ZieAds removes the access token and deletes the ${s.name} data it stored.` };
  return null;
}

export default function ReviewCaption() {
  const location = useLocation();
  const [mode, setMode] = useState<Platform | null>(() => {
    try {
      const v = localStorage.getItem(KEY);
      return isPlatform(v) ? v : null;
    } catch {
      return null;
    }
  });
  const [caption, setCaption] = useState<Caption | null>(null);

  // ?review=<platform> turns it on, ?review=off turns it off
  useEffect(() => {
    const v = new URLSearchParams(location.search).get('review');
    if (v === null) return;
    const next = isPlatform(v) ? v : null;
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      /* private window: works for this page only */
    }
    setMode(next);
  }, [location.search]);

  useEffect(() => {
    if (!mode) return;
    setCaption(routeCaption(location.pathname, location.search, SCRIPTS[mode]));
  }, [mode, location.pathname, location.search]);

  useEffect(() => {
    if (!mode) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('button, a, [role="button"]') as HTMLElement | null;
      // Choosing an option (a radio card such as "Publish now" in the schedule list) is not the action itself
      if (!el || el.getAttribute('role') === 'radio' || el.querySelector('input[type="radio"]')) return;
      const c = clickCaption(el.innerText || el.getAttribute('aria-label') || '', window.location.pathname, SCRIPTS[mode]);
      if (c) setCaption(c);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [mode]);

  if (!mode || !caption) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        width: 'min(920px, calc(100vw - 32px))',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 12,
        background: '#111111',
        color: '#ffffff',
        boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
        font: '500 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        pointerEvents: 'none',
      }}
    >
      <span style={{ flex: 'none', marginTop: 2, padding: '2px 8px', borderRadius: 6, background: '#F26522', fontSize: 12.5, fontWeight: 700, letterSpacing: '0.02em' }}>{caption.step}</span>
      <span key={caption.text} style={{ animation: 'zrcIn 0.25s ease-out' }}>
        {caption.text}
      </span>
      {/* Purpose of the animation: a new caption fades in so the viewer notices the step changed */}
      <style>{'@keyframes zrcIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){[aria-live] span{animation:none!important}}'}</style>
    </div>
  );
}
