/*
  DNVB fleet API, mounted at /api/tiktok. Everything works on the active workspace (X-Workspace-Id).

    GET    /accounts                 every TikTok account with followers, views, status, group
    PATCH  /accounts                 label, group or tags for one or many accounts
    POST   /accounts/sync            sync some accounts (account_ids) or all of them
    POST   /accounts/disconnect      disconnect one or many accounts
    GET    /accounts/:id/videos      recent videos of one account
    GET    /summary                  fleet totals and a 30 day trend
    GET    /invites                  connect links
    POST   /invites                  make a connect link for creators
    DELETE /invites/:id              revoke a connect link

  Cron (Authorization: Bearer CRON_SECRET):
    /cron/sync            sync the accounts that waited longest (budgeted, resumes next run)
    /cron/refresh-tokens  refresh TikTok tokens that end within 26 hours
*/
import { Router } from "express";
import crypto from "crypto";
import { getUserIdFromRequest, supabaseAdmin } from "../supabaseServer.js";
import { isCronAuthorized } from "./api-jobs.js";
import {
  listFleet,
  tiktokAccountLimit,
  updateTikTokAccountMeta,
  syncTikTokAccounts,
  disconnectTikTokAccount,
  resolveOpenId,
  syncDueTikTokAccounts,
  refreshExpiringTikTokTokens,
} from "../tiktok/accounts.js";

export const tiktokRouter = Router();

async function requireAuth(req: any, res: any, next: any) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 1000) : []);
async function openIdsOf(userId: string, refs: string[]): Promise<string[]> {
  const out = await Promise.all(refs.map((r) => resolveOpenId(userId, r)));
  return [...new Set(out.filter(Boolean) as string[])];
}

tiktokRouter.get("/accounts", requireAuth, async (req: any, res) => {
  try {
    const [accounts, limit] = await Promise.all([listFleet(req.userId), tiktokAccountLimit(req.userId)]);
    const groups = [...new Set(accounts.map((a) => a.group).filter(Boolean))].sort() as string[];
    res.json({ success: true, accounts, used: accounts.length, limit, groups });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

tiktokRouter.patch("/accounts", requireAuth, async (req: any, res) => {
  const refs = ids(req.body?.account_ids);
  if (!refs.length) return res.status(400).json({ error: "Pick at least one account." });
  try {
    const openIds = await openIdsOf(req.userId, refs);
    const patch: any = {};
    if ("label" in (req.body || {})) patch.label = req.body.label;
    if ("group" in (req.body || {})) patch.group = req.body.group;
    if ("tags" in (req.body || {})) patch.tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    await updateTikTokAccountMeta(req.userId, openIds, patch);
    res.json({ success: true, updated: openIds.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

tiktokRouter.post("/accounts/sync", requireAuth, async (req: any, res) => {
  try {
    const refs = ids(req.body?.account_ids);
    const openIds = refs.length ? await openIdsOf(req.userId, refs) : undefined;
    const results = await syncTikTokAccounts(req.userId, openIds, 6);
    res.json({ success: true, synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

tiktokRouter.post("/accounts/disconnect", requireAuth, async (req: any, res) => {
  const refs = ids(req.body?.account_ids);
  if (!refs.length) return res.status(400).json({ error: "Pick at least one account." });
  try {
    const openIds = await openIdsOf(req.userId, refs);
    for (const o of openIds) await disconnectTikTokAccount(req.userId, o);
    res.json({ success: true, disconnected: openIds.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

tiktokRouter.get("/accounts/:id/videos", requireAuth, async (req: any, res) => {
  const openId = await resolveOpenId(req.userId, String(req.params.id));
  const { data, error } = await supabaseAdmin
    .from("post_insights_cache")
    .select("platform_media_id, video_views, likes, comments_count, shares, engagement, post_published_at, raw_response")
    .eq("user_id", req.userId)
    .eq("platform", "tiktok")
    .eq("platform_account_id", openId)
    .order("post_published_at", { ascending: false })
    .limit(Math.min(Number(req.query.limit) || 30, 100));
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    success: true,
    videos: (data || []).map((v: any) => ({
      id: v.platform_media_id,
      views: Number(v.video_views || 0),
      likes: Number(v.likes || 0),
      comments: Number(v.comments_count || 0),
      shares: Number(v.shares || 0),
      engagement: Number(v.engagement || 0),
      published_at: v.post_published_at,
      cover: v.raw_response?.cover_image_url || null,
      url: v.raw_response?.share_url || null,
      caption: v.raw_response?.video_description || v.raw_response?.title || "",
      duration: Number(v.raw_response?.duration || 0),
    })),
  });
});

tiktokRouter.get("/summary", requireAuth, async (req: any, res) => {
  try {
    const accounts = await listFleet(req.userId);
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: snaps } = await supabaseAdmin
      .from("account_insights_daily")
      .select("platform_account_id, snapshot_date, followers_count")
      .eq("user_id", req.userId)
      .eq("platform", "tiktok")
      .gte("snapshot_date", since)
      .limit(20000);
    const { data: vids } = await supabaseAdmin
      .from("post_insights_cache")
      .select("video_views, post_published_at")
      .eq("user_id", req.userId)
      .eq("platform", "tiktok")
      .gte("post_published_at", `${since}T00:00:00Z`)
      .limit(50000);
    // Followers per day: the last known value of every account carried forward
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const byAcct = new Map<string, Map<string, number>>();
    (snaps || []).forEach((s: any) => {
      if (!byAcct.has(s.platform_account_id)) byAcct.set(s.platform_account_id, new Map());
      byAcct.get(s.platform_account_id)!.set(s.snapshot_date, Number(s.followers_count || 0));
    });
    const followers = days.map((d) => {
      let total = 0;
      byAcct.forEach((m) => {
        let v = 0;
        for (const [day, n] of [...m.entries()].sort()) if (day <= d) v = n;
        total += v;
      });
      return { date: d, value: total };
    });
    const views = days.map((d) => ({ date: d, value: (vids || []).filter((v: any) => String(v.post_published_at).slice(0, 10) === d).reduce((a: number, v: any) => a + Number(v.video_views || 0), 0) }));
    res.json({
      success: true,
      totals: {
        accounts: accounts.length,
        live: accounts.filter((a) => a.status === "live").length,
        needs_attention: accounts.filter((a) => a.status !== "live" || a.sync_error).length,
        followers: accounts.reduce((a, x) => a + x.followers, 0),
        followers_7d_change: accounts.reduce((a, x) => a + (x.followers_7d_change || 0), 0),
        views_30d: accounts.reduce((a, x) => a + x.views_30d, 0),
        engagement_30d: accounts.reduce((a, x) => a + x.engagement_30d, 0),
        posts_30d: accounts.reduce((a, x) => a + x.posts_30d, 0),
        scheduled: accounts.reduce((a, x) => a + x.scheduled, 0),
        idle_14d: accounts.filter((a) => !a.last_posted_at || Date.now() - new Date(a.last_posted_at).getTime() > 14 * 86400000).length,
      },
      trend: { followers, views },
      top: [...accounts].sort((a, b) => b.views_30d - a.views_30d).slice(0, 5),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── Connect links ─── */

tiktokRouter.get("/invites", requireAuth, async (req: any, res) => {
  const { data, error } = await supabaseAdmin.from("tiktok_connect_invites").select("*").eq("user_id", req.userId).is("revoked_at", null).order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";
  res.json({ success: true, invites: (data || []).map((i: any) => ({ ...i, url: `${base}/api/auth/tiktok/invite/${i.token}`, active: i.used_count < i.max_uses && new Date(i.expires_at).getTime() > Date.now() })) });
});

tiktokRouter.post("/invites", requireAuth, async (req: any, res) => {
  const maxUses = Math.min(Math.max(Number(req.body?.max_uses) || 1, 1), 500);
  const days = Math.min(Math.max(Number(req.body?.expires_days) || 7, 1), 30);
  const token = crypto.randomBytes(18).toString("base64url");
  const { data, error } = await supabaseAdmin
    .from("tiktok_connect_invites")
    .insert({
      user_id: req.userId,
      token,
      label: req.body?.label ? String(req.body.label).slice(0, 60) : null,
      account_group: req.body?.group ? String(req.body.group).slice(0, 40) : null,
      max_uses: maxUses,
      expires_at: new Date(Date.now() + days * 86400000).toISOString(),
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";
  res.json({ success: true, invite: { ...data, url: `${base}/api/auth/tiktok/invite/${token}`, active: true } });
});

tiktokRouter.delete("/invites/:id", requireAuth, async (req: any, res) => {
  const { error } = await supabaseAdmin.from("tiktok_connect_invites").update({ revoked_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* ─── Cron ─── */

function cron(handler: (req: any, res: any) => Promise<any>) {
  return async (req: any, res: any) => {
    if (!isCronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "Unauthorized cron call" });
    try {
      await handler(req, res);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
}
const cronSync = cron(async (req, res) => res.json({ success: true, ...(await syncDueTikTokAccounts({ maxAccounts: Number(req.query.max) || 150 })) }));
const cronRefresh = cron(async (_req, res) => res.json({ success: true, ...(await refreshExpiringTikTokTokens()) }));
tiktokRouter.get("/cron/sync", cronSync);
tiktokRouter.post("/cron/sync", cronSync);
tiktokRouter.get("/cron/refresh-tokens", cronRefresh);
tiktokRouter.post("/cron/refresh-tokens", cronRefresh);
