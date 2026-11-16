import './setup-env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TIKTOK_CLIENT_KEY ||= 'ck_test';
const { pool } = await import('../server/tiktok/accounts.ts');
const { buildAuthUrl } = await import('../server/routes/api-auth.ts');
const { PLAN_LIMITS } = await import('../server/creditConfig.ts');
const { PLATFORMS } = await import('../src/lib/platforms.ts');

test('pool keeps at most N tasks in flight and keeps the order of results', async () => {
  let running = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 + (n % 3) * 3));
    running--;
    return n * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test('TikTok sign in always shows the account picker so the next account can be added', () => {
  const url = buildAuthUrl('tiktok', 'state123', 'https://dnvb.zieads.com', 'challenge');
  assert.match(url, /disable_auto_auth=1/);
  assert.match(url, /code_challenge=challenge/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fdnvb\.zieads\.com%2Fapi%2Fauth%2Ftiktok%2Fcallback/);
});

test('plans hold 100+ TikTok accounts at the top', () => {
  assert.ok(PLAN_LIMITS.pro.tiktokAccounts >= 100);
  assert.equal(PLAN_LIMITS.agency.tiktokAccounts, -1);
});

test('TikTok is the only connector', () => {
  assert.deepEqual(PLATFORMS.map((p) => p.id), ['tiktok']);
});
