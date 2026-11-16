# dnvb.zieads.com: DNVB TikTok Hub

One dashboard to run **100+ TikTok accounts** from one workspace. Built on the ZieAds codebase
(same Composer, Calendar, AI Analyst, AI Agent, Analytics, Competitor Hunt), with TikTok as the only connector.

## What is different from ZieAds
- **Many TikTok accounts per workspace.** `social_connections` is unique per `(user_id, platform, platform_user_id)`.
  Every account has its own token, sync, numbers and posts. Code: `server/tiktok/accounts.ts`.
- **TikTok Accounts page** (`/accounts`): totals, 30 day trends, search, group filter, sort, pagination,
  bulk sync, bulk group, bulk disconnect, "Compose for selected", and a drawer per account (label, group, tags, recent videos).
- **Connect TikTok** (`/connections`): add accounts (TikTok always shows the account picker, `disable_auto_auth=1`),
  and **connect links** that creators open on their own phone (`/api/auth/tiktok/invite/:token`, result page `/connect/tiktok`).
- **Composer**: account picker with search, group filter and select all; caption per account; **stagger** a schedule over many accounts.
  Queue slots are per account. Direct Post when `video.publish` is granted, inbox draft with `video.upload`, reminder otherwise.
- **Sync built for a fleet**: concurrency pool, oldest accounts first, time budget per run (resumes next run), token refresh 26 hours ahead.
- **Plan limits**: `tiktokAccounts` in `server/creditConfig.ts` (Free 5, Starter 30, Pro 150, Agency unlimited). Override all with `DNVB_MAX_TIKTOK_ACCOUNTS`.
- **One page landing** in the dnvbindonesia.com style (`src/pages/LandingPage.tsx`); all calls to action go to the dashboard.

## Fleet API (`server/routes/api-tiktok.ts`, mounted at `/api/tiktok`)
`GET /accounts`, `PATCH /accounts`, `POST /accounts/sync`, `POST /accounts/disconnect`, `GET /accounts/:id/videos`,
`GET /summary`, `GET|POST /invites`, `DELETE /invites/:id`, cron `GET|POST /cron/sync`, `/cron/refresh-tokens`.

## Setup
1. **Supabase**: create a new project, open SQL Editor and run `supabase/dnvb-setup.sql` once.
   For on-time publishing and frequent TikTok sync, set `CRON_SECRET`, then run `supabase/dnvb-scheduler.sql`
   (replace `PASTE_CRON_SECRET_HERE` first). Existing database? Run only `supabase/migrations/20261116_dnvb_multi_tiktok.sql`.
2. **TikTok app** (developers.tiktok.com): Login Kit with redirect URI `https://dnvb.zieads.com/api/auth/tiktok/callback`,
   scopes `user.info.basic, user.info.profile, user.info.stats, video.list` (+ `video.upload`, `video.publish` after approval).
   Verify the domain dnvb.zieads.com in the TikTok portal (the old `public/tiktok*.txt` file belongs to zieads.com).
3. **Vercel**: new project from this repo, domain `dnvb.zieads.com`, env vars from `.env.example`.
4. Local: `npm install`, copy `.env.example` to `.env`, `npm run dev`. Checks: `npm run lint`, `npm test`, `npm run build`.

Writing rule from ZieAds still applies: no em dash or en dash anywhere (`npm run build` checks it).
