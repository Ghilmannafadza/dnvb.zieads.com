import { Router } from "express";
import crypto from "crypto";
import { getUserIdFromRequest, supabaseAdmin } from "../supabaseServer.js";
import { encrypt } from "../utils/crypto.js";
import { refreshExpiringTokens } from "../utils/tokenRefresh.js";
import { syncAll } from "../utils/sync-instagram.js";
import { syncTikTokInsightsForUser } from "../utils/sync-tiktok.js";
import { FACEBOOK_SCOPES, GRAPH_VERSION } from "../utils/facebookApi.js";
import { handleFacebookCallback, selectFacebookPage, listFacebookPages } from "../facebook/connect.js";
import { deletePlatformData, handlePlatformDeletion, parseMetaSignedRequest } from "../dataDeletion.js";
import { logActivity } from "../activity.js";
import { saveTikTokConnection, canAddTikTokAccount, syncTikTokAccounts, disconnectTikTokAccount, findInvite, resolveOpenId } from "../tiktok/accounts.js";

export const authRouter = Router();

async function requireAuth(req: any, res: any, next: any) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

/**
 * 1. Initiate connection (OAuth Connect)
 * Supports both GET redirects and POST json URL retrieval.
 */
/* DNVB: TikTok is the only connector. The other callbacks below stay for reference but cannot be started. */
export const CONNECT_PLATFORMS = ["instagram", "facebook", "tiktok", "linkedin"] as const;
const ENABLED_CONNECT = new Set(["tiktok"]);
type ConnectPlatform = (typeof CONNECT_PLATFORMS)[number];

const ENV_REQUIRED: Record<ConnectPlatform, string> = {
  instagram: "INSTAGRAM_APP_ID",
  facebook: "FACEBOOK_APP_ID",
  tiktok: "TIKTOK_CLIENT_KEY",
  linkedin: "LINKEDIN_CLIENT_ID",
};

/** Builds the platform consent URL and stores the CSRF state. Exported for tests. */
export function buildAuthUrl(platform: ConnectPlatform, state: string, redirectBase: string, codeChallenge?: string): string {
  const cb = (p: string) => encodeURIComponent(`${redirectBase}/api/auth/${p}/callback`);
  if (platform === "instagram") {
    return `https://www.instagram.com/oauth/authorize?client_id=${process.env.INSTAGRAM_APP_ID}&redirect_uri=${cb("instagram")}&scope=instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_insights,instagram_business_content_publish&response_type=code&state=${state}`;
  }
  if (platform === "facebook") {
    // Facebook Login for Business: a config_id bundles the permissions set in the Meta dashboard
    const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID;
    const auth = configId ? `config_id=${encodeURIComponent(configId)}` : `scope=${FACEBOOK_SCOPES.join(",")}`;
    return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${cb("facebook")}&state=${state}&response_type=code&${auth}`;
  }
  if (platform === "tiktok") {
    const scopes = process.env.TIKTOK_SCOPES || "user.info.basic,user.info.profile,user.info.stats,video.list";
    // disable_auto_auth=1: TikTok always shows the account screen, so the next account can be added
    // without the browser silently reusing the account that was connected last
    return `https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=${scopes}&response_type=code&redirect_uri=${cb("tiktok")}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&disable_auto_auth=1`;
  }
  return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${cb("linkedin")}&state=${state}&scope=openid%20profile%20email%20w_member_social`;
}

interface ConnectOptions {
  inviteId?: string | null;
  reconnect?: string | null;
}

async function startConnect(platform: string, userId: string, opts: ConnectOptions = {}): Promise<{ url?: string; error?: string; status?: number }> {
  if (!(CONNECT_PLATFORMS as readonly string[]).includes(platform) || !ENABLED_CONNECT.has(platform)) return { error: "Only TikTok accounts can be connected here.", status: 400 };
  const p = platform as ConnectPlatform;
  if (!process.env[ENV_REQUIRED[p]]) return { error: `${ENV_REQUIRED[p]} environment variable is missing on the server.`, status: 500 };
  if (p === "tiktok" && !opts.reconnect) {
    const room = await canAddTikTokAccount(userId);
    if (!room.ok) return { error: `This workspace holds ${room.used} of ${room.limit} TikTok accounts on its plan. Upgrade or disconnect an account first.`, status: 403 };
  }
  const redirectBase = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";
  const state = crypto.randomBytes(16).toString("hex");
  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;
  if (p === "tiktok") {
    // PKCE for TikTok
    codeVerifier = crypto.randomBytes(32).toString("hex");
    codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  }
  const row: Record<string, unknown> = { state, user_id: userId, platform: p, code_verifier: codeVerifier || null };
  if (opts.inviteId) row.invite_id = opts.inviteId;
  if (opts.reconnect) row.reconnect_account = opts.reconnect;
  const { error: insertErr } = await supabaseAdmin.from("oauth_states").insert(row);
  if (insertErr) {
    console.error("[OAuth] Database insert failed for oauth_states:", insertErr.message);
    return { error: "Failed to initialize secure connection handshake", status: 500 };
  }
  return { url: buildAuthUrl(p, state, redirectBase, codeChallenge) };
}

authRouter.get("/:platform/connect", async (req, res) => {
  const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized: Missing authentication token" });
  // Same rules as every API call, including the active workspace (?workspace=)
  req.headers.authorization = `Bearer ${token}`;
  const userId = await getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized: Invalid session" });
  const reconnect = req.query.reconnect ? await resolveOpenId(userId, String(req.query.reconnect)) : null;
  const r = await startConnect(req.params.platform, userId, { reconnect });
  if (!r.url) {
    const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";
    if (r.status === 403) return res.redirect(`${base}/connections?error=tiktok_limit_reached`);
    return res.status(r.status || 500).json({ error: r.error });
  }
  return res.redirect(r.url);
});

/* DNVB connect link: a creator opens /api/auth/tiktok/invite/:token, signs in to TikTok,
   and the account lands in the workspace that made the link. No ZieAds login needed. */
authRouter.get("/tiktok/invite/:token", async (req, res) => {
  const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";
  const { invite, reason } = await findInvite(String(req.params.token));
  if (!invite) return res.redirect(`${base}/connect/tiktok?status=${reason}`);
  const r = await startConnect("tiktok", invite.user_id, { inviteId: invite.id });
  if (!r.url) return res.redirect(`${base}/connect/tiktok?status=${r.status === 403 ? "limit_reached" : "error"}`);
  return res.redirect(r.url);
});

authRouter.post("/:platform/connect", requireAuth, async (req: any, res) => {
  const reconnect = req.body?.reconnect ? await resolveOpenId(req.userId, String(req.body.reconnect)) : null;
  const r = await startConnect(req.params.platform, req.userId, { reconnect });
  if (!r.url) return res.status(r.status || 500).json({ error: r.error });
  return res.json({ url: r.url });
});

/**
 * 2. OAuth Callback Handlers
 */

// Facebook Pages (spec P0-2)
authRouter.get("/facebook/callback", handleFacebookCallback);

authRouter.get("/facebook/pages", requireAuth, async (req: any, res) => {
  res.json({ success: true, ...(await listFacebookPages(req.userId)) });
});

authRouter.post("/facebook/pages/select", requireAuth, async (req: any, res) => {
  try {
    const page = await selectFacebookPage(req.userId, String(req.body?.page_id || ""));
    res.json({ success: true, page });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// A. Instagram Callback
authRouter.get("/instagram/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const redirectBase = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";

  if (error) {
    return res.redirect(`${redirectBase}/connections?error=instagram_denied`);
  }

  if (!code || !state) {
    return res.redirect(`${redirectBase}/connections?error=instagram_invalid_callback`);
  }

  try {
    // Verify CSRF state
    const { data: stateData, error: dbErr } = await supabaseAdmin
      .from("oauth_states")
      .select("*")
      .eq("state", state)
      .eq("platform", "instagram")
      .single();

    if (dbErr || !stateData) {
      console.warn("[OAuth] Instagram state verification failed or mismatch.");
      return res.redirect(`${redirectBase}/connections?error=instagram_csrf`);
    }

    // Delete state record immediately
    await supabaseAdmin.from("oauth_states").delete().eq("state", state);

    // Exchange short-lived code
    const tokenExchangeUrl = "https://api.instagram.com/oauth/access_token";
    const bodyParams = new URLSearchParams();
    bodyParams.append("client_id", process.env.INSTAGRAM_APP_ID || "");
    bodyParams.append("client_secret", process.env.INSTAGRAM_APP_SECRET || "");
    bodyParams.append("grant_type", "authorization_code");
    bodyParams.append("redirect_uri", `${redirectBase}/api/auth/instagram/callback`);
    bodyParams.append("code", code as string);

    const tokenRes = await fetch(tokenExchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[OAuth] Instagram short-lived token exchange failed:", errText);
      return res.redirect(`${redirectBase}/connections?error=instagram_exchange_failed`);
    }

    const shortLivedData = await tokenRes.json();
    const shortLivedToken = shortLivedData.access_token;

    // Capture the permissions Instagram ACTUALLY granted (returned as an array or a
    // comma-separated string on the Business Login token response). Storing the real
    // grant - instead of a hard-coded string - makes silently-missing scopes (e.g. a
    // user unchecking "manage comments" on the consent screen) visible in the DB.
    const grantedPermissions: string = Array.isArray(shortLivedData.permissions)
      ? shortLivedData.permissions.join(",")
      : (typeof shortLivedData.permissions === "string" && shortLivedData.permissions.length > 0
          ? shortLivedData.permissions
          : "");
    console.log(`[OAuth] Instagram granted permissions: ${grantedPermissions || "<not reported>"}`);

    // Exchange short-lived token for long-lived (60 days) token
    const longLivedUrl = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${
      process.env.INSTAGRAM_APP_SECRET
    }&access_token=${shortLivedToken}`;

    const longLivedRes = await fetch(longLivedUrl);
    if (!longLivedRes.ok) {
      const errText = await longLivedRes.text();
      console.error("[OAuth] Instagram long-lived token exchange failed:", errText);
      return res.redirect(`${redirectBase}/connections?error=instagram_longlived_failed`);
    }

    const longLivedData = await longLivedRes.json();
    const longLivedToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in || 5184000; // default 60 days in seconds

    // Get user profile details
    const profileUrl = `https://graph.instagram.com/me?fields=user_id,username,name,account_type,profile_picture_url&access_token=${longLivedToken}`;
    const profileRes = await fetch(profileUrl);
    
    let platformUsername = "";
    let platformDisplayName = "";
    let platformAvatarUrl = "";
    let platformAccountType = "";
    let platformUserId = shortLivedData.user_id || "";

    if (profileRes.ok) {
      const profileData = await profileRes.json();
      platformUserId = profileData.user_id || platformUserId;
      platformUsername = profileData.username || "";
      platformDisplayName = profileData.name || "";
      platformAvatarUrl = profileData.profile_picture_url || "";
      platformAccountType = profileData.account_type || "";
    }

    // Encrypt token
    const encryptedAccess = encrypt(longLivedToken);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Save / Upsert social connection record
    const { error: upsertErr } = await supabaseAdmin.from("social_connections").upsert({
      user_id: stateData.user_id,
      platform: "instagram",
      platform_user_id: String(platformUserId),
      platform_username: platformUsername,
      platform_display_name: platformDisplayName,
      platform_avatar_url: platformAvatarUrl,
      platform_account_type: platformAccountType,
      access_token: encryptedAccess,
      token_expires_at: expiresAt,
      scopes_granted: grantedPermissions || "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_insights,instagram_business_content_publish",
      is_active: true,
      last_refreshed_at: new Date().toISOString(),
    }, { onConflict: "user_id,platform,platform_user_id" });

    if (upsertErr) {
      console.error("[OAuth] Failed to upsert Instagram connection details:", upsertErr.message);
      return res.redirect(`${redirectBase}/connections?error=instagram_db_save_failed`);
    }

    // Mirror connection in connected_accounts for general feature compatibility
    const { data: connData, error: connErr } = await supabaseAdmin.from("connected_accounts").upsert({
      user_id: stateData.user_id,
      platform: "instagram",
      platform_account_id: String(platformUserId),
      account_handle: `@${platformUsername}`,
      connection_method: "oauth",
      is_active: true,
      connected_at: new Date().toISOString(),
      metadata: { is_real_oauth: true }
    }, { onConflict: "user_id,platform,platform_account_id" }).select();

    if (!connErr && connData && connData.length > 0) {
      await syncAll(stateData.user_id);
    }

    // CRITICAL STEP that is easy to miss: registering a webhook callback URL in the Meta App
    // Dashboard only configures the APP. Instagram will not actually send events for a
    // specific IG account until that account is explicitly subscribed via the
    // `{ig-user-id}/subscribed_apps` edge, using THAT account's own access token. Without
    // this call, the dashboard webhook config looks "done" but zero events ever arrive - 
    // which is exactly the symptom reported (comments never reach the inbox). Best-effort:
    // never block the OAuth redirect on this.
    try {
      const subRes = await fetch(
        `https://graph.instagram.com/v21.0/${platformUserId}/subscribed_apps?subscribed_fields=comments&access_token=${encodeURIComponent(longLivedToken)}`,
        { method: "POST" }
      );
      const subBody = await subRes.json().catch(() => ({}));
      if (subRes.ok) {
        console.log(`[OAuth] Instagram webhook subscription registered for account ${platformUserId}:`, JSON.stringify(subBody));
      } else {
        console.error(`[OAuth] Instagram webhook subscription FAILED for account ${platformUserId}:`, JSON.stringify(subBody));
      }
    } catch (subErr: any) {
      console.error(`[OAuth] Instagram webhook subscription request failed:`, subErr.message);
    }

    return res.redirect(`${redirectBase}/connections?connected=instagram`);
  } catch (err: any) {
    console.error("[OAuth] Unexpected Instagram callback error:", err);
    return res.redirect(`${redirectBase}/connections?error=instagram_callback_failed`);
  }
});

// B. TikTok Callback (DNVB: adds or refreshes one of many TikTok accounts)
authRouter.get("/tiktok/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const redirectBase = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";
  // Invited creators go back to the public thank-you page, the team goes back to Accounts
  let back = (q: string) => `${redirectBase}/connections?${q}`;

  if (!state) return res.redirect(back("error=tiktok_invalid_callback"));

  try {
    const { data: stateData, error: dbErr } = await supabaseAdmin.from("oauth_states").select("*").eq("state", state).eq("platform", "tiktok").single();
    if (dbErr || !stateData) {
      console.warn("[OAuth] TikTok state verification failed.");
      return res.redirect(back("error=tiktok_csrf"));
    }
    await supabaseAdmin.from("oauth_states").delete().eq("state", state);
    if (stateData.invite_id) back = (q: string) => `${redirectBase}/connect/tiktok?${q}`;
    if (error) return res.redirect(back("error=tiktok_denied"));
    if (!code) return res.redirect(back("error=tiktok_invalid_callback"));

    // Exchange the code (PKCE)
    const bodyParams = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY || "",
      client_secret: process.env.TIKTOK_CLIENT_SECRET || "",
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: `${redirectBase}/api/auth/tiktok/callback`,
      code_verifier: stateData.code_verifier || "",
    });
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: bodyParams.toString() });
    const tokenData: any = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[OAuth] TikTok token exchange failed:", JSON.stringify(tokenData));
      return res.redirect(back("error=tiktok_exchange_failed"));
    }
    const openId = String(tokenData.open_id || "");
    if (!openId) return res.redirect(back("error=tiktok_invalid_callback"));

    // A reconnect must be the same account the team clicked
    if (stateData.reconnect_account && stateData.reconnect_account !== openId) {
      return res.redirect(back("error=tiktok_wrong_account"));
    }
    const room = await canAddTikTokAccount(stateData.user_id, openId);
    if (!room.ok) return res.redirect(back("error=tiktok_limit_reached"));

    // Profile, asking only for fields the granted scopes allow
    const granted = String(tokenData.scope || "user.info.basic").split(/[ ,]+/);
    const fields = ["open_id", "union_id", "display_name", "avatar_url"];
    if (granted.includes("user.info.profile")) fields.push("username", "bio_description");
    if (granted.includes("user.info.stats")) fields.push("follower_count");
    let user: any = {};
    const profileRes = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${fields.join(",")}`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    if (profileRes.ok) user = (await profileRes.json())?.data?.user || {};
    else console.error("[OAuth] TikTok profile fetch failed:", profileRes.status, await profileRes.text());

    let invite: any = null;
    if (stateData.invite_id) {
      const { data } = await supabaseAdmin.from("tiktok_connect_invites").select("*").eq("id", stateData.invite_id).maybeSingle();
      invite = data;
    }

    await saveTikTokConnection(stateData.user_id, {
      openId,
      username: user.username || user.display_name || `user_${openId.slice(-6)}`,
      displayName: user.display_name || `TikTok ${openId.slice(-6)}`,
      avatarUrl: user.avatar_url || "",
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresInSec: tokenData.expires_in || 86400,
      refreshExpiresInSec: tokenData.refresh_expires_in || null,
      scopes: tokenData.scope || "",
      label: invite?.label || null,
      group: invite?.account_group || null,
      via: invite ? "invite" : "dashboard",
    });
    if (invite) await supabaseAdmin.from("tiktok_connect_invites").update({ used_count: (invite.used_count || 0) + 1 }).eq("id", invite.id);

    // First numbers for this account only; the cron does the rest of the fleet
    await syncTikTokAccounts(stateData.user_id, [openId]).catch((e) => console.error("[OAuth] first TikTok sync failed:", e.message));

    const handle = encodeURIComponent(user.username || user.display_name || "");
    return res.redirect(back(`connected=tiktok&account=${handle}`));
  } catch (err: any) {
    console.error("[OAuth] Unexpected TikTok callback error:", err);
    return res.redirect(back("error=tiktok_callback_failed"));
  }
});

// C. LinkedIn Callback
authRouter.get("/linkedin/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const redirectBase = process.env.OAUTH_REDIRECT_BASE_URL || "https://dnvb.zieads.com";

  if (error) {
    return res.redirect(`${redirectBase}/connections?error=linkedin_denied`);
  }

  if (!code || !state) {
    return res.redirect(`${redirectBase}/connections?error=linkedin_invalid_callback`);
  }

  try {
    // Verify state
    const { data: stateData, error: dbErr } = await supabaseAdmin
      .from("oauth_states")
      .select("*")
      .eq("state", state)
      .eq("platform", "linkedin")
      .single();

    if (dbErr || !stateData) {
      console.warn("[OAuth] LinkedIn state verification mismatch.");
      return res.redirect(`${redirectBase}/connections?error=linkedin_csrf`);
    }

    // Delete state
    await supabaseAdmin.from("oauth_states").delete().eq("state", state);

    // Exchange LinkedIn code
    const tokenUrl = "https://www.linkedin.com/oauth/v2/accessToken";
    const bodyParams = new URLSearchParams();
    bodyParams.append("grant_type", "authorization_code");
    bodyParams.append("code", code as string);
    bodyParams.append("client_id", process.env.LINKEDIN_CLIENT_ID || "");
    bodyParams.append("client_secret", process.env.LINKEDIN_CLIENT_SECRET || "");
    bodyParams.append("redirect_uri", `${redirectBase}/api/auth/linkedin/callback`);

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[OAuth] LinkedIn token exchange failed:", errText);
      return res.redirect(`${redirectBase}/connections?error=linkedin_exchange_failed`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 5184000; // usually 60 days

    // Fetch user details using OpenID Connect endpoint
    const profileUrl = "https://api.linkedin.com/v2/userinfo";
    const profileRes = await fetch(profileUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let platformUserId = "";
    let platformDisplayName = "";
    let platformAvatarUrl = "";
    let platformUsername = "";

    if (profileRes.ok) {
      const profileData = await profileRes.json();
      platformUserId = profileData.sub || "";
      platformDisplayName = profileData.name || "";
      platformUsername = profileData.email || profileData.given_name || "";
      platformAvatarUrl = profileData.picture || "";
    }

    const encryptedAccess = encrypt(accessToken);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const { error: upsertErr } = await supabaseAdmin.from("social_connections").upsert({
      user_id: stateData.user_id,
      platform: "linkedin",
      platform_user_id: String(platformUserId),
      platform_username: platformUsername,
      platform_display_name: platformDisplayName,
      platform_avatar_url: platformAvatarUrl,
      access_token: encryptedAccess,
      token_expires_at: expiresAt,
      scopes_granted: tokenData.scope || "openid,profile,email,w_member_social",
      is_active: true,
      last_refreshed_at: new Date().toISOString(),
    }, { onConflict: "user_id,platform,platform_user_id" });

    if (upsertErr) {
      console.error("[OAuth] Failed to upsert LinkedIn connection:", upsertErr.message);
      return res.redirect(`${redirectBase}/connections?error=linkedin_db_save_failed`);
    }

    // Mirror connection in connected_accounts for general feature compatibility
    const { data: connData, error: connErr } = await supabaseAdmin.from("connected_accounts").upsert({
      user_id: stateData.user_id,
      platform: "linkedin",
      platform_account_id: String(platformUserId),
      account_handle: `@${platformUsername}`,
      connection_method: "oauth",
      is_active: true,
      connected_at: new Date().toISOString(),
      metadata: { is_real_oauth: true }
    }, { onConflict: "user_id,platform,platform_account_id" }).select();

    if (!connErr && connData && connData.length > 0) {
      const { count } = await supabaseAdmin
        .from("social_posts")
        .select("*", { count: "exact", head: true })
        .eq("account_id", connData[0].id);

      if (!count || count === 0) {
      }
    }

    return res.redirect(`${redirectBase}/connections?connected=linkedin`);
  } catch (err: any) {
    console.error("[OAuth] Unexpected LinkedIn callback error:", err);
    return res.redirect(`${redirectBase}/connections?error=linkedin_callback_failed`);
  }
});

/**
 * 3. Server-to-Server Webhook Decoders & Signed Requests
 */

/** Length-safe signed_request check (a forged or short signature is a 400, never a crash) */
function decodeMetaSignedRequest(signedRequest: string, appSecret: string): any {
  return parseMetaSignedRequest(signedRequest, appSecret);
}

// Meta Instagram Deauthorize Webhook
authRouter.post("/instagram/deauthorize", async (req, res) => {
  const signedRequest = req.body.signed_request;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;

  if (!signedRequest || !appSecret) {
    return res.status(400).json({ error: "Missing signed_request or app credentials" });
  }

  try {
    const data = decodeMetaSignedRequest(signedRequest, appSecret);
    if (!data || !data.user_id) {
      return res.status(400).json({ error: "Invalid signature or missing user_id" });
    }

    const platformUserId = data.user_id;

    // Deactivate Instagram connection for matching platform ID
    const { error: dbErr } = await supabaseAdmin
      .from("social_connections")
      .update({
        is_active: false,
        access_token: "DEAUTHORIZED_BY_PLATFORM",
        refresh_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("platform", "instagram")
      .eq("platform_user_id", String(platformUserId));

    if (dbErr) {
      console.error("[Webhook] Failed to deauthorize connection in DB:", dbErr.message);
      return res.status(500).json({ error: "Database update failure" });
    }

    console.log(`[Webhook] Instagram deauthorized successfully for platform user ${platformUserId}.`);
    return res.status(200).send("OK");
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Meta data deletion callback (spec P0-5). One handler serves the Facebook app and the
// Instagram app: the signed_request is verified with whichever app secret matches.
async function metaDeletion(req: any, res: any) {
  const signed = req.body?.signed_request;
  const secrets = [process.env.FACEBOOK_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(Boolean) as string[];
  if (!signed || !secrets.length) return res.status(400).json({ error: "Missing signed_request" });
  const data = secrets.map((sec) => parseMetaSignedRequest(signed, sec)).find(Boolean);
  if (!data?.user_id) return res.status(400).json({ error: "Invalid signature or missing user_id" });
  try {
    const { confirmationCode } = await handlePlatformDeletion("meta", String(data.user_id));
    const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://zieads.com";
    return res.json({ url: `${base}/data-deletion?code=${confirmationCode}`, confirmation_code: confirmationCode });
  } catch (e: any) {
    console.error("[deletion] meta callback failed:", e.message);
    return res.status(500).json({ error: "Deletion failed, please email privacy@zieads.com" });
  }
}
authRouter.post("/meta/data-deletion", metaDeletion);
authRouter.post("/facebook/data-deletion", metaDeletion);
authRouter.post("/instagram/data-deletion", metaDeletion);

// Old status links from before the shared handler keep working
authRouter.get("/instagram/data-deletion/status", (req, res) => {
  const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://zieads.com";
  res.redirect(`${base}/data-deletion?code=${encodeURIComponent(String(req.query.id || ""))}`);
});

// Facebook deauthorize: the person removed ZieAds from their Facebook apps
authRouter.post("/facebook/deauthorize", async (req: any, res) => {
  const data = process.env.FACEBOOK_APP_SECRET ? parseMetaSignedRequest(req.body?.signed_request, process.env.FACEBOOK_APP_SECRET) : null;
  if (!data?.user_id) return res.status(400).json({ error: "Invalid signature" });
  await supabaseAdmin
    .from("social_connections")
    .update({ is_active: false, status: "revoked", access_token: "DEAUTHORIZED_BY_PLATFORM", updated_at: new Date().toISOString() })
    .eq("platform", "facebook")
    .contains("metadata", { fb_user_id: String(data.user_id) });
  return res.status(200).send("OK");
});

// Threads (its own app secret): uninstall and delete callbacks set in the Threads use case settings
authRouter.post("/threads/deauthorize", async (req: any, res) => {
  const data = process.env.THREADS_APP_SECRET ? parseMetaSignedRequest(req.body?.signed_request, process.env.THREADS_APP_SECRET) : null;
  if (!data?.user_id) return res.status(400).json({ error: "Invalid signature" });
  await supabaseAdmin
    .from("social_connections")
    .update({ is_active: false, status: "revoked", access_token: "DEAUTHORIZED_BY_PLATFORM", refresh_token: null, updated_at: new Date().toISOString() })
    .eq("platform", "threads")
    .eq("platform_user_id", String(data.user_id));
  return res.status(200).send("OK");
});

authRouter.post("/threads/data-deletion", async (req: any, res) => {
  const data = process.env.THREADS_APP_SECRET ? parseMetaSignedRequest(req.body?.signed_request, process.env.THREADS_APP_SECRET) : null;
  if (!data?.user_id) return res.status(400).json({ error: "Invalid signature or missing user_id" });
  try {
    const { confirmationCode } = await handlePlatformDeletion("threads", String(data.user_id));
    const base = process.env.OAUTH_REDIRECT_BASE_URL || "https://zieads.com";
    return res.json({ url: `${base}/data-deletion?code=${confirmationCode}`, confirmation_code: confirmationCode });
  } catch (e: any) {
    console.error("[deletion] threads callback failed:", e.message);
    return res.status(500).json({ error: "Deletion failed, please email privacy@zieads.com" });
  }
});

// TikTok Webhooks for Deauthorization and Deletion (stubs returning 200 OK)
authRouter.post("/tiktok/deauthorize", async (req: any, res) => {
  const openId = req.body?.user_openid || req.body?.open_id || req.body?.content?.user_openid;
  if (openId) {
    await supabaseAdmin
      .from("social_connections")
      .update({ is_active: false, status: "revoked", access_token: "DEAUTHORIZED_BY_PLATFORM", refresh_token: null, updated_at: new Date().toISOString() })
      .eq("platform", "tiktok")
      .eq("platform_user_id", String(openId));
  }
  return res.status(200).send("OK");
});

authRouter.post("/tiktok/data-deletion", async (req: any, res) => {
  // TikTok sends the open_id of the user who removed ZieAds
  const openId = req.body?.user_openid || req.body?.open_id || req.body?.content?.user_openid;
  if (!openId) return res.status(200).json({ status: "ignored" });
  const { confirmationCode } = await handlePlatformDeletion("tiktok", String(openId));
  return res.json({ confirmation_code: confirmationCode, status: "completed" });
});

// LinkedIn Webhooks for Deauthorization (stub returning 200 OK)
authRouter.post("/linkedin/deauthorize", async (req, res) => {
  console.log("[Webhook] LinkedIn deauthorize triggered.", req.body);
  return res.status(200).send("OK");
});

/**
 * 4. Manual Disconnect: revoke the token and delete what ZieAds stored from that platform
 */
authRouter.post("/:platform/disconnect", requireAuth, async (req: any, res) => {
  const platform = req.params.platform;
  const userId = req.userId;
  // DNVB: TikTok disconnects one account (body.account_id), never the whole fleet by accident
  if (platform === "tiktok") {
    const openId = await resolveOpenId(userId, req.body?.account_id ? String(req.body.account_id) : null);
    if (!openId) return res.status(400).json({ error: "Pick the TikTok account to disconnect (account_id)." });
    try {
      const deleted = await disconnectTikTokAccount(userId, openId);
      return res.json({ success: true, platform, account_id: openId, deleted });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (!(CONNECT_PLATFORMS as readonly string[]).includes(platform)) {
    return res.status(400).json({ error: "Invalid platform parameter" });
  }
  try {
    const deleted = await deletePlatformData(userId, platform);
    await logActivity(userId, "user", "connection.disconnected", "platform", platform, { deleted });
    return res.json({ success: true, platform, deleted });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 5. Retrieve Connection Status
 */
authRouter.get("/connections", requireAuth, async (req: any, res) => {
  // DNVB: one entry per TikTok account (the workspace can hold 100+)
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from("social_connections")
      .select("id, platform, platform_user_id, platform_username, platform_display_name, platform_avatar_url, platform_account_type, account_label, account_group, connected_at, token_expires_at, scopes_granted, status, last_error_message, last_synced_at, last_refreshed_at, metadata")
      .eq("user_id", req.userId)
      .eq("platform", "tiktok")
      .eq("is_active", true)
      .order("connected_at", { ascending: true });
    if (dbErr) return res.status(500).json({ error: "Failed to fetch connections status" });
    const { data: cas } = await supabaseAdmin.from("connected_accounts").select("id, platform_account_id").eq("user_id", req.userId).eq("platform", "tiktok");
    const caId = new Map((cas || []).map((c: any) => [c.platform_account_id, c.id]));
    return res.json(
      (data || []).map((row: any) => ({
        platform: "tiktok",
        connected: true,
        account_id: caId.get(row.platform_user_id) || row.id,
        open_id: row.platform_user_id,
        username: row.platform_username || "",
        display_name: row.platform_display_name || "",
        avatar_url: row.platform_avatar_url || "",
        label: row.account_label || null,
        group: row.account_group || null,
        account_type: row.platform_account_type || "",
        connected_at: row.connected_at,
        token_expires_at: row.token_expires_at,
        scopes: row.scopes_granted || "",
        status: row.status || "live",
        last_error: row.last_error_message || null,
        last_synced_at: row.last_synced_at || row.last_refreshed_at || null,
      }))
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 6. Automated Token Refresh Trigger Route (Vercel Cron target)
 */
authRouter.get("/refresh-job", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const requestSecret = req.headers.authorization?.replace("Bearer ", "") || req.query.secret;

  // Enforce CRON_SECRET security token if configured in environment variables
  if (cronSecret && requestSecret !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized: Invalid cron security key" });
  }

  try {
    await refreshExpiringTokens();
    return res.json({ success: true, message: "Social tokens refresh scan completed successfully" });
  } catch (err: any) {
    console.error("[OAuth Refresh Job] Error executing token refresh:", err);
    return res.status(500).json({ error: err.message });
  }
});

