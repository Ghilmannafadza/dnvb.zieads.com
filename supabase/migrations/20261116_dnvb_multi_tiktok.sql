-- ============================================================
-- DNVB (dnvb.zieads.com): many TikTok accounts in one workspace.
-- Safe to run more than once. Run after setup-new-project.sql,
-- RUN_ALL_2026_11.sql and 20261111_publish_scheduler.sql
-- (supabase/dnvb-setup.sql already contains all of them in order).
-- ============================================================

-- ─── 1. One connection per TikTok account (open_id), not one per platform ───
ALTER TABLE public.social_connections DROP CONSTRAINT IF EXISTS social_connections_user_id_platform_key;
DO $$ BEGIN
  ALTER TABLE public.social_connections
    ADD CONSTRAINT social_connections_user_platform_account_key UNIQUE (user_id, platform, platform_user_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Organising a fleet of 100+ accounts: a label, a group and free tags per account
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS account_label TEXT;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS account_group TEXT;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_social_connections_user_platform ON public.social_connections(user_id, platform, is_active);
CREATE INDEX IF NOT EXISTS idx_social_connections_sync_due ON public.social_connections(platform, is_active, last_synced_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_social_connections_group ON public.social_connections(user_id, account_group);

-- ─── 2. Daily account snapshots are per account ───
DROP INDEX IF EXISTS public.idx_account_insights_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_insights_unique_acct
  ON public.account_insights_daily(user_id, platform, platform_account_id, snapshot_date);

-- ─── 3. Video insights know which account they belong to ───
ALTER TABLE public.post_insights_cache ADD COLUMN IF NOT EXISTS platform_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_post_insights_account ON public.post_insights_cache(user_id, platform, platform_account_id);

-- ─── 4. Scheduled posts: fast lookups per account ───
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_account ON public.scheduled_posts(user_id, platform_account_id, scheduled_for);

-- ─── 5. Connect links: send a link to a creator, they connect their own TikTok to your workspace ───
CREATE TABLE IF NOT EXISTS public.tiktok_connect_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  account_group TEXT,
  max_uses INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tiktok_invites_user ON public.tiktok_connect_invites(user_id, created_at DESC);
ALTER TABLE public.tiktok_connect_invites ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tiktok_invites_owner ON public.tiktok_connect_invites FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The OAuth handshake remembers which invite started it
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS invite_id UUID;
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS reconnect_account TEXT;
