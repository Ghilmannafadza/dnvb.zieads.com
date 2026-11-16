/*
  DNVB: TikTok sync for the accounts of a workspace. The work happens in server/tiktok/accounts.ts.
  Older code paths call this once per connection row and on page loads; with 100+ accounts that would
  start the same fleet sync many times. So:
    - one run per workspace at a time (later callers share the running promise)
    - without a list of accounts, only accounts not synced in the last 30 minutes are synced
  The Sync button on the Accounts page calls syncTikTokAccounts directly (forced).
*/
import { supabaseAdmin } from "../supabaseServer.js";
import { syncTikTokAccounts, SyncResult } from "../tiktok/accounts.js";

const running = new Map<string, Promise<SyncResult[]>>();

export async function syncTikTokInsightsForUser(userId: string, openIds?: string[]): Promise<SyncResult[]> {
  const key = `${userId}:${(openIds || []).join(",")}`;
  const busy = running.get(key);
  if (busy) return busy;
  const job = (async () => {
    let target = openIds;
    if (!target?.length) {
      const stale = new Date(Date.now() - 30 * 60000).toISOString();
      const { data } = await supabaseAdmin
        .from("social_connections")
        .select("platform_user_id")
        .eq("user_id", userId)
        .eq("platform", "tiktok")
        .eq("is_active", true)
        .or(`last_synced_at.is.null,last_synced_at.lt.${stale}`)
        .order("last_synced_at", { ascending: true, nullsFirst: true })
        .limit(40);
      target = (data || []).map((r: any) => r.platform_user_id);
      if (!target.length) return [];
    }
    const results = await syncTikTokAccounts(userId, target);
    console.log(`[TikTok Sync] user ${userId}: ${results.filter((r) => r.ok).length} synced, ${results.filter((r) => !r.ok).length} failed`);
    return results;
  })();
  running.set(key, job);
  try {
    return await job;
  } finally {
    running.delete(key);
  }
}
