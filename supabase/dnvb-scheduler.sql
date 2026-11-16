-- DNVB scheduler: Supabase calls dnvb.zieads.com every minute so scheduled posts go out on time.
-- Vercel Hobby only runs cron jobs once a day, which is why scheduled posts were left waiting.
--
-- Before running: replace PASTE_CRON_SECRET_HERE (two places below) with the exact value of
-- CRON_SECRET in Vercel (at least 16 characters). Run the whole file once in Supabase > SQL Editor.
-- Running it again is safe: it updates the secret and recreates the jobs.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The secret lives in Supabase Vault, never in the job text
do $$
begin
  if exists (select 1 from vault.secrets where name = 'zieads_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'zieads_cron_secret'), 'PASTE_CRON_SECRET_HERE');
  else
    perform vault.create_secret('PASTE_CRON_SECRET_HERE', 'zieads_cron_secret');
  end if;
end $$;

-- Calls one ZieAds cron endpoint with the secret
create or replace function public.zieads_call_cron(path text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select net.http_post(
    url := 'https://dnvb.zieads.com' || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'zieads_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$$;
revoke all on function public.zieads_call_cron(text) from public, anon, authenticated;

-- Remove older copies of these jobs, then schedule them
select cron.unschedule(jobid) from cron.job where jobname in ('zieads-publish-scheduled', 'zieads-scheduled-agents', 'zieads-heartbeat', 'dnvb-tiktok-sync', 'dnvb-tiktok-tokens');

-- Every minute: publish posts that are due
select cron.schedule('zieads-publish-scheduled', '* * * * *', $$ select public.zieads_call_cron('/api/v3/cron/publish-scheduled') $$);
-- Every 15 minutes: scheduled agents
select cron.schedule('zieads-scheduled-agents', '*/15 * * * *', $$ select public.zieads_call_cron('/api/v3/cron/scheduled-agents') $$);
-- Every hour: heartbeat (TikTok tokens and sync, Guardian checks, briefings)
select cron.schedule('zieads-heartbeat', '7 * * * *', $$ select public.zieads_call_cron('/api/v3/jobs/run') $$);

-- Check that it works (run a few minutes later). status_code 200 means the server accepted the call;
-- 401 means the secret here does not match CRON_SECRET in Vercel.
-- select id, status_code, left(content::text, 200) as body, created from net._http_response order by created desc limit 10;

-- DNVB: every 20 minutes sync the TikTok accounts that waited longest (up to 150 per run, the rest next run)
select cron.schedule('dnvb-tiktok-sync', '*/20 * * * *', $$ select public.zieads_call_cron('/api/tiktok/cron/sync') $$);
-- DNVB: every 3 hours refresh TikTok tokens that end within 26 hours
select cron.schedule('dnvb-tiktok-tokens', '13 */3 * * *', $$ select public.zieads_call_cron('/api/tiktok/cron/refresh-tokens') $$);
