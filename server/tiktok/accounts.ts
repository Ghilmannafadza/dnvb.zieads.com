/*
  DNVB: the TikTok fleet. One workspace holds many TikTok accounts (100+).
  Every TikTok account is one row in social_connections keyed by (user_id, 'tiktok', open_id),
  mirrored in connected_accounts (the id the Composer, Calendar and Analytics use).

  This module is the one place that:
    - saves a TikTok connection after OAuth (saveTikTokConnection)
    - finds the right account for a request or a post (getTikTokConnection)
    - refreshes tokens (TikTok access tokens live 24 hours, refresh tokens 365 days)
    - syncs profile stats and videos per account, with a small concurrency pool so 100+ accounts
      fit inside one serverless run (syncTikTokAccounts, syncDueTikTokAccounts)
    - lists the fleet with the numbers the Accounts dashboard shows (listFleet)
*/
import { supabaseAdmin, getEffectivePlan } from "../supabaseServer.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { PLAN_LIMITS } from "../creditConfig.js";
import { logActivity } from "../activity.js";

const API = "https://open.tiktokapis.com/v2";

export interface TikTokConn {
  id: string; // social_connections.id
  userId: string;
  openId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string;
  label: string | null;
  group: string | null;
}

/* ─── Limits ─────────────────────────────────────────────────────────────── */

/** TikTok accounts a plan can hold. -1 is unlimited. DNVB_MAX_TIKTOK_ACCOUNTS overrides every plan. */
export async function tiktokAccountLimit(userId: string): Promise<number> {
  const override = Number(process.env.DNVB_MAX_TIKTOK_ACCOUNTS || "");
  if (Number.isFinite(override) && override !== 0) return override;
  const plan = await getEffectivePlan(userId);
  return (PLAN_LIMITS as any)[plan]?.tiktokAccounts ?? 5;
}

export async function countTikTokAccounts(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("social_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("platform", "tiktok")
    .eq("is_active", true);
  return count || 0;
}

/** True when one more account fits the plan (reconnecting an existing account always fits) */
export async function canAddTikTokAccount(userId: string, openId?: string): Promise<{ ok: boolean; limit: number; used: number }> {
  const [limit, used] = await Promise.all([tiktokAccountLimit(userId), countTikTokAccounts(userId)]);
  if (openId) {
    const { data } = await supabaseAdmin.from("social_connections").select("id").eq("user_id", userId).eq("platform", "tiktok").eq("platform_user_id", openId).eq("is_active", true).maybeSingle();
    if (data) return { ok: true, limit, used };
  }
  return { ok: limit === -1 || used < limit, limit, used };
}

/* ─── Loading ────────────────────────────────────────────────────────────── */

function toConn(row: any): TikTokConn | null {
  try {
    return {
      id: row.id,
      userId: row.user_id,
      openId: row.platform_user_id,
      username: row.platform_username || "",
      displayName: row.platform_display_name || "",
      avatarUrl: row.platform_avatar_url || "",
      token: decrypt(row.access_token),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
      expiresAt: row.token_expires_at || null,
      scopes: row.scopes_granted || "",
      label: row.account_label || null,
      group: row.account_group || null,
    };
  } catch (e: any) {
    console.error(`[TikTok] could not decrypt connection ${row?.id}: ${e.message}`);
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The open_id behind any account reference the app passes around:
 * a connected_accounts.id (Composer, Calendar), a social_connections.id (Accounts page) or the open_id itself.
 */
export async function resolveOpenId(userId: string, ref?: string | null): Promise<string | null> {
  if (!ref) return null;
  if (!UUID_RE.test(ref)) return ref;
  const { data: ca } = await supabaseAdmin.from("connected_accounts").select("platform_account_id").eq("id", ref).eq("user_id", userId).maybeSingle();
  if (ca?.platform_account_id) return ca.platform_account_id;
  const { data: sc } = await supabaseAdmin.from("social_connections").select("platform_user_id").eq("id", ref).eq("user_id", userId).maybeSingle();
  return sc?.platform_user_id || ref;
}

/**
 * One TikTok account of a user. With no reference it returns the first connected account,
 * so single-account code paths keep working.
 */
export async function getTikTokConnection(userId: string, ref?: string | null): Promise<TikTokConn | null> {
  const openId = await resolveOpenId(userId, ref);
  let q = supabaseAdmin.from("social_connections").select("*").eq("user_id", userId).eq("platform", "tiktok").eq("is_active", true);
  if (openId) q = q.eq("platform_user_id", openId);
  const { data } = await q.order("connected_at", { ascending: true }).limit(1);
  const row = data?.[0];
  if (!row) return null;
  const conn = toConn(row);
  return conn ? ensureFreshToken(conn) : null;
}

export async function listTikTokConnections(userId: string, openIds?: string[]): Promise<TikTokConn[]> {
  let q = supabaseAdmin.from("social_connections").select("*").eq("user_id", userId).eq("platform", "tiktok").eq("is_active", true);
  if (openIds?.length) q = q.in("platform_user_id", openIds);
  const { data } = await q.order("connected_at", { ascending: true });
  return (data || []).map(toConn).filter(Boolean) as TikTokConn[];
}

/* ─── Saving ─────────────────────────────────────────────────────────────── */

export interface SaveTikTok {
  openId: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresInSec?: number | null;
  refreshExpiresInSec?: number | null;
  scopes?: string;
  label?: string | null;
  group?: string | null;
  via?: "dashboard" | "invite";
}

/** Insert or update one TikTok account and its connected_accounts mirror. Returns the connected_accounts id. */
export async function saveTikTokConnection(userId: string, s: SaveTikTok): Promise<string | null> {
  const now = new Date().toISOString();
  const handle = s.username ? (s.username.startsWith("@") ? s.username : `@${s.username}`) : s.displayName || `tiktok_${s.openId.slice(-6)}`;
  const row: Record<string, unknown> = {
    user_id: userId,
    platform: "tiktok",
    platform_user_id: s.openId,
    platform_username: s.username || "",
    platform_display_name: s.displayName || s.username || "",
    platform_avatar_url: s.avatarUrl || "",
    access_token: encrypt(s.accessToken),
    refresh_token: s.refreshToken ? encrypt(s.refreshToken) : null,
    token_expires_at: new Date(Date.now() + (s.expiresInSec || 86400) * 1000).toISOString(),
    scopes_granted: s.scopes || "",
    status: "live",
    last_error_message: null,
    is_active: true,
    connected_at: now,
    last_refreshed_at: now,
    updated_at: now,
    metadata: { refresh_expires_at: s.refreshExpiresInSec ? new Date(Date.now() + s.refreshExpiresInSec * 1000).toISOString() : null, connected_via: s.via || "dashboard" },
  };
  // Only set label and group when given, so a reconnect keeps what the team typed
  if (s.label) row.account_label = s.label;
  if (s.group) row.account_group = s.group;
  const { error } = await supabaseAdmin.from("social_connections").upsert(row, { onConflict: "user_id,platform,platform_user_id" });
  if (error) throw new Error(`Could not save the TikTok account: ${error.message}`);

  const { data: ca } = await supabaseAdmin
    .from("connected_accounts")
    .upsert(
      {
        user_id: userId,
        platform: "tiktok",
        platform_account_id: s.openId,
        account_handle: handle,
        connection_method: "oauth",
        is_active: true,
        connected_at: now,
        metadata: { is_real_oauth: true, display_name: s.displayName || "", avatar_url: s.avatarUrl || "" },
      },
      { onConflict: "user_id,platform,platform_account_id" }
    )
    .select("id")
    .maybeSingle();
  await logActivity(userId, "user", "connection.connected", "platform", "tiktok", { handle, open_id: s.openId, via: s.via || "dashboard" });
  return ca?.id || null;
}

export async function updateTikTokAccountMeta(userId: string, openIds: string[], patch: { label?: string | null; group?: string | null; tags?: string[] }) {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) update.account_label = patch.label ? String(patch.label).trim().slice(0, 60) : null;
  if (patch.group !== undefined) update.account_group = patch.group ? String(patch.group).trim().slice(0, 40) : null;
  if (patch.tags !== undefined) update.tags = (patch.tags || []).map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 12);
  const { error } = await supabaseAdmin.from("social_connections").update(update).eq("user_id", userId).eq("platform", "tiktok").in("platform_user_id", openIds);
  if (error) throw new Error(error.message);
}

/** Disconnect one TikTok account and remove what was stored from it. Other accounts stay untouched. */
export async function disconnectTikTokAccount(userId: string, openId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const conn = await listTikTokConnections(userId, [openId]);
  // Best effort: tell TikTok to revoke the token
  if (conn[0]?.token && process.env.TIKTOK_CLIENT_KEY) {
    const body = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || "", client_secret: process.env.TIKTOK_CLIENT_SECRET || "", token: conn[0].token });
    await fetch(`${API}/oauth/revoke/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }).catch(() => undefined);
  }
  const { data: ca } = await supabaseAdmin.from("connected_accounts").select("id").eq("user_id", userId).eq("platform", "tiktok").eq("platform_account_id", openId).maybeSingle();
  const del = async (table: string, apply: (q: any) => any) => {
    try {
      const { count, error } = await apply(supabaseAdmin.from(table).delete({ count: "exact" }));
      out[table] = error ? 0 : count || 0;
    } catch {
      out[table] = 0;
    }
  };
  if (ca?.id) {
    await del("social_posts", (q) => q.eq("account_id", ca.id));
    await del("scheduled_posts", (q) => q.eq("user_id", userId).eq("platform", "tiktok").in("status", ["draft", "in_review", "approved", "scheduled", "failed", "needs_action"]).in("platform_account_id", [ca.id, openId]));
  }
  await del("post_insights_cache", (q) => q.eq("user_id", userId).eq("platform", "tiktok").eq("platform_account_id", openId));
  await del("account_insights_daily", (q) => q.eq("user_id", userId).eq("platform", "tiktok").eq("platform_account_id", openId));
  await del("connected_accounts", (q) => q.eq("user_id", userId).eq("platform", "tiktok").eq("platform_account_id", openId));
  await del("social_connections", (q) => q.eq("user_id", userId).eq("platform", "tiktok").eq("platform_user_id", openId));
  await logActivity(userId, "user", "connection.disconnected", "platform", "tiktok", { open_id: openId, deleted: out });
  return out;
}

/* ─── Tokens ─────────────────────────────────────────────────────────────── */

async function markError(id: string, message: string, needsReconnect: boolean) {
  await supabaseAdmin
    .from("social_connections")
    .update({ status: needsReconnect ? "needs_reconnect" : "error", last_error_message: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", id);
}

/** Refresh the access token. TikTok rotates the refresh token, so both are stored again. */
export async function refreshTikTokToken(c: TikTokConn): Promise<TikTokConn> {
  if (!c.refreshToken) throw new Error("No refresh token stored. Reconnect this account.");
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || "",
    client_secret: process.env.TIKTOK_CLIENT_SECRET || "",
    grant_type: "refresh_token",
    refresh_token: c.refreshToken,
  });
  const r = await fetch(`${API}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = `TikTok refused the token refresh: ${j.error_description || j.error || r.status}`;
    await markError(c.id, msg, true);
    throw new Error(msg);
  }
  c.token = j.access_token;
  if (j.refresh_token) c.refreshToken = j.refresh_token;
  c.expiresAt = new Date(Date.now() + (j.expires_in || 86400) * 1000).toISOString();
  await supabaseAdmin
    .from("social_connections")
    .update({
      access_token: encrypt(c.token),
      refresh_token: c.refreshToken ? encrypt(c.refreshToken) : null,
      token_expires_at: c.expiresAt,
      status: "live",
      last_error_message: null,
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", c.id);
  return c;
}

/** Refresh when under 30 minutes are left. A failed refresh returns the old token (the call will report the error). */
export async function ensureFreshToken(c: TikTokConn): Promise<TikTokConn> {
  if (c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() > 30 * 60000) return c;
  try {
    return await refreshTikTokToken(c);
  } catch (e: any) {
    console.warn(`[TikTok] refresh failed for ${c.username || c.openId}: ${e.message}`);
    return c;
  }
}

/* ─── Sync ───────────────────────────────────────────────────────────────── */

const VIDEO_FIELDS = "id,create_time,cover_image_url,share_url,video_description,duration,title,view_count,like_count,comment_count,share_count";

async function tiktokGet(c: TikTokConn, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.error && j.error.code && j.error.code !== "ok")) {
    const code = j.error?.code || r.status;
    const err: any = new Error(`TikTok ${path} failed (${code}): ${j.error?.message || ""}`.trim());
    err.reconnect = code === "access_token_invalid" || code === "scope_not_authorized" || r.status === 401;
    throw err;
  }
  return j.data || {};
}

export interface SyncResult {
  open_id: string;
  username: string;
  ok: boolean;
  videos?: number;
  followers?: number;
  error?: string;
}

/** Sync one account: profile stats into account_insights_daily, up to 60 recent videos into the caches */
export async function syncTikTokAccount(conn: TikTokConn): Promise<SyncResult> {
  const c = await ensureFreshToken(conn);
  const res: SyncResult = { open_id: c.openId, username: c.username, ok: false };
  try {
    const hasStats = /user\.info\.stats/.test(c.scopes) || !c.scopes;
    const fields = ["open_id", "display_name", "avatar_url", ...(/user\.info\.profile/.test(c.scopes) ? ["username", "bio_description", "profile_deep_link", "is_verified"] : []), ...(hasStats ? ["follower_count", "following_count", "likes_count", "video_count"] : [])];
    const user = (await tiktokGet(c, `/user/info/?fields=${fields.join(",")}`)).user || {};
    const today = new Date().toISOString().slice(0, 10);
    await supabaseAdmin.from("account_insights_daily").upsert(
      {
        user_id: c.userId,
        platform: "tiktok",
        platform_account_id: c.openId,
        snapshot_date: today,
        followers_count: Number(user.follower_count || 0),
        following_count: Number(user.following_count || 0),
        media_count: Number(user.video_count || 0),
        impressions_daily: 0,
        reach_daily: 0,
        profile_views_daily: 0,
        website_clicks_daily: 0,
        raw_response: user,
      },
      { onConflict: "user_id,platform,platform_account_id,snapshot_date" }
    );
    res.followers = Number(user.follower_count || 0);

    // Profile details can change (new avatar, new handle)
    const profilePatch: Record<string, unknown> = {};
    if (user.avatar_url) profilePatch.platform_avatar_url = user.avatar_url;
    if (user.display_name) profilePatch.platform_display_name = user.display_name;
    if (user.username) profilePatch.platform_username = user.username;

    // Videos: up to 3 pages of 20
    const videos: any[] = [];
    if (/video\.list/.test(c.scopes) || !c.scopes) {
      let cursor: number | undefined;
      for (let page = 0; page < 3; page++) {
        const d = await tiktokGet(c, `/video/list/?fields=${VIDEO_FIELDS}`, { method: "POST", body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }) });
        videos.push(...(d.videos || []));
        if (!d.has_more || !d.cursor) break;
        cursor = d.cursor;
      }
    }

    const nowIso = new Date().toISOString();
    if (videos.length) {
      await supabaseAdmin.from("post_insights_cache").upsert(
        videos.map((v) => ({
          user_id: c.userId,
          platform: "tiktok",
          platform_account_id: c.openId,
          platform_media_id: String(v.id),
          impressions: Number(v.view_count || 0),
          reach: Number(v.view_count || 0),
          engagement: Number(v.like_count || 0) + Number(v.comment_count || 0) + Number(v.share_count || 0),
          likes: Number(v.like_count || 0),
          comments_count: Number(v.comment_count || 0),
          shares: Number(v.share_count || 0),
          video_views: Number(v.view_count || 0),
          raw_response: v,
          post_published_at: new Date(Number(v.create_time || 0) * 1000).toISOString(),
          fetched_at: nowIso,
        })),
        { onConflict: "user_id,platform,platform_media_id" }
      );
      const { data: ca } = await supabaseAdmin.from("connected_accounts").select("id").eq("user_id", c.userId).eq("platform", "tiktok").eq("platform_account_id", c.openId).maybeSingle();
      if (ca?.id) {
        await supabaseAdmin.from("social_posts").upsert(
          videos.map((v) => ({
            account_id: ca.id,
            user_id: c.userId,
            platform: "tiktok",
            platform_post_id: String(v.id),
            content_text: v.video_description || v.title || "",
            media_type: "video",
            media_urls: v.cover_image_url ? [v.cover_image_url] : [],
            posted_at: new Date(Number(v.create_time || 0) * 1000).toISOString(),
            post_url: v.share_url || null,
            raw_metrics: {
              permalink: v.share_url || "",
              views: Number(v.view_count || 0),
              likes: Number(v.like_count || 0),
              comments: Number(v.comment_count || 0),
              shares: Number(v.share_count || 0),
              duration: Number(v.duration || 0),
            },
            fetched_at: nowIso,
          })),
          { onConflict: "account_id,platform_post_id" }
        );
        await supabaseAdmin.from("connected_accounts").update({ last_synced_at: nowIso, sync_status: "ok", sync_error_message: null }).eq("id", ca.id);
      }
    }
    await supabaseAdmin
      .from("social_connections")
      .update({ ...profilePatch, last_synced_at: nowIso, sync_error: null, status: "live", last_error_message: null, updated_at: nowIso })
      .eq("id", c.id);
    res.ok = true;
    res.videos = videos.length;
  } catch (e: any) {
    res.error = e.message;
    await supabaseAdmin.from("social_connections").update({ sync_error: String(e.message).slice(0, 500), last_synced_at: new Date().toISOString() }).eq("id", c.id);
    if (e.reconnect) await markError(c.id, e.message, true);
  }
  return res;
}

/** Run tasks with at most `size` in flight */
export async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Sync many accounts of one user (all of them when openIds is empty) */
export async function syncTikTokAccounts(userId: string, openIds?: string[], concurrency = 5): Promise<SyncResult[]> {
  const conns = await listTikTokConnections(userId, openIds);
  return pool(conns, concurrency, syncTikTokAccount);
}

/**
 * Cron: sync the accounts that waited longest, across every user, inside a time budget.
 * With 100+ accounts per workspace one run does not have to finish everything: the next run picks up the rest.
 */
export async function syncDueTikTokAccounts(opts: { maxAccounts?: number; staleMinutes?: number; budgetMs?: number } = {}) {
  const maxAccounts = opts.maxAccounts ?? 150;
  const staleBefore = new Date(Date.now() - (opts.staleMinutes ?? 180) * 60000).toISOString();
  const deadline = Date.now() + (opts.budgetMs ?? 240000);
  const { data } = await supabaseAdmin
    .from("social_connections")
    .select("*")
    .eq("platform", "tiktok")
    .eq("is_active", true)
    .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(maxAccounts);
  const conns = (data || []).map(toConn).filter(Boolean) as TikTokConn[];
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  await pool(conns, 6, async (c) => {
    if (Date.now() > deadline) {
      skipped++;
      return null;
    }
    const r = await syncTikTokAccount(c);
    r.ok ? synced++ : failed++;
    return r;
  });
  return { candidates: conns.length, synced, failed, skipped };
}

/**
 * Cron: refresh every TikTok token that ends within `hours` (default 26, so a once a day cron keeps
 * every account fresh). Refresh tokens live 365 days, so an expired access token can still be renewed.
 */
export async function refreshExpiringTikTokTokens(hours = 26): Promise<{ refreshed: number; failed: number }> {
  const soon = new Date(Date.now() + hours * 3600000).toISOString();
  const { data } = await supabaseAdmin.from("social_connections").select("*").eq("platform", "tiktok").eq("is_active", true).lte("token_expires_at", soon).limit(1000);
  const conns = (data || []).map(toConn).filter(Boolean) as TikTokConn[];
  let refreshed = 0;
  let failed = 0;
  await pool(conns, 8, async (c) => {
    try {
      await refreshTikTokToken(c);
      refreshed++;
    } catch {
      failed++;
    }
  });
  return { refreshed, failed };
}

/* ─── Fleet view ─────────────────────────────────────────────────────────── */

export interface FleetAccount {
  id: string; // connected_accounts.id (what the Composer and Calendar use)
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
  refresh_expires_at: string | null;
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

/** Every TikTok account of a workspace with its latest numbers, in a handful of queries */
export async function listFleet(userId: string): Promise<FleetAccount[]> {
  const { data: rows } = await supabaseAdmin
    .from("social_connections")
    .select("id, platform_user_id, platform_username, platform_display_name, platform_avatar_url, account_label, account_group, tags, status, last_error_message, sync_error, connected_at, last_synced_at, token_expires_at, scopes_granted, metadata")
    .eq("user_id", userId)
    .eq("platform", "tiktok")
    .eq("is_active", true)
    .order("connected_at", { ascending: true });
  const list = rows || [];
  if (!list.length) return [];
  const openIds = list.map((r: any) => r.platform_user_id);
  const since7 = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();

  const [{ data: cas }, { data: snaps }, { data: vids }, { data: sched }] = await Promise.all([
    supabaseAdmin.from("connected_accounts").select("id, platform_account_id").eq("user_id", userId).eq("platform", "tiktok").in("platform_account_id", openIds),
    supabaseAdmin.from("account_insights_daily").select("platform_account_id, snapshot_date, followers_count, media_count, raw_response").eq("user_id", userId).eq("platform", "tiktok").gte("snapshot_date", since7).order("snapshot_date", { ascending: true }).limit(5000),
    supabaseAdmin.from("post_insights_cache").select("platform_account_id, video_views, engagement, post_published_at").eq("user_id", userId).eq("platform", "tiktok").gte("post_published_at", since30).limit(20000),
    supabaseAdmin.from("scheduled_posts").select("platform_account_id, status").eq("user_id", userId).eq("platform", "tiktok").in("status", ["scheduled", "approved", "in_review"]).limit(20000),
  ]);
  const caByOpen = new Map((cas || []).map((c: any) => [c.platform_account_id, c.id]));
  const openByCa = new Map((cas || []).map((c: any) => [c.id, c.platform_account_id]));

  return list.map((r: any) => {
    const open = r.platform_user_id;
    const s = (snaps || []).filter((x: any) => x.platform_account_id === open);
    const last = s[s.length - 1];
    const first = s[0];
    const v = (vids || []).filter((x: any) => x.platform_account_id === open);
    const lastPosted = v.reduce((m: string | null, x: any) => (!m || x.post_published_at > m ? x.post_published_at : m), null as string | null);
    const scheduled = (sched || []).filter((x: any) => x.platform_account_id === open || openByCa.get(x.platform_account_id) === open).length;
    const scopes = r.scopes_granted || "";
    return {
      id: caByOpen.get(open) || r.id,
      connection_id: r.id,
      open_id: open,
      username: r.platform_username || "",
      display_name: r.platform_display_name || "",
      avatar_url: r.platform_avatar_url || "",
      label: r.account_label || null,
      group: r.account_group || null,
      tags: r.tags || [],
      status: r.status || "live",
      last_error: r.last_error_message || null,
      sync_error: r.sync_error || null,
      connected_at: r.connected_at,
      last_synced_at: r.last_synced_at || null,
      token_expires_at: r.token_expires_at || null,
      refresh_expires_at: r.metadata?.refresh_expires_at || null,
      scopes,
      can_publish: /video\.publish|video\.upload/.test(scopes),
      followers: Number(last?.followers_count || 0),
      followers_7d_change: last && first && first !== last ? Number(last.followers_count || 0) - Number(first.followers_count || 0) : null,
      likes: Number(last?.raw_response?.likes_count || 0),
      videos: Number(last?.media_count || 0),
      views_30d: v.reduce((a: number, x: any) => a + Number(x.video_views || 0), 0),
      engagement_30d: v.reduce((a: number, x: any) => a + Number(x.engagement || 0), 0),
      posts_30d: v.length,
      scheduled,
      last_posted_at: lastPosted,
    };
  });
}

/* ─── Connect links (invites) ────────────────────────────────────────────── */

export async function findInvite(token: string) {
  const { data } = await supabaseAdmin.from("tiktok_connect_invites").select("*").eq("token", token).maybeSingle();
  if (!data) return { invite: null, reason: "not_found" as const };
  if (data.revoked_at) return { invite: null, reason: "revoked" as const };
  if (new Date(data.expires_at).getTime() < Date.now()) return { invite: null, reason: "expired" as const };
  if (data.used_count >= data.max_uses) return { invite: null, reason: "used" as const };
  return { invite: data, reason: null };
}
