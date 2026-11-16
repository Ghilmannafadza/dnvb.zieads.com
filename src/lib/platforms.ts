/*
  The 14 social networks ZieAds supports (Buffer and Vista Social list 12, Publer 13).
  Ordered by how easy and realistic each is to bring live for outside users:
    1. Facebook, 2. Instagram   one Meta app and one App Review covers both
    3. Threads                  same Meta app, adds the Threads permissions to that review
    4. Telegram, 5. Discord     no review at all: a bot in the channel, or a channel webhook
    6. Bluesky, 7. Mastodon     open APIs, no review
    8. YouTube                  Google OAuth verification, then a quota audit (until then uploads stay private)
    9. LinkedIn                 profile posting works; Company Pages need Community Management API approval
   10. TikTok                   public posting needs the Content Posting API audit
   11. Pinterest                trial access first, then a standard access review
   12. Tumblr, 13. X, 14. Reddit  not wired up yet (low demand, paid API, commercial approval)
  status 'available': the connect flow and publisher exist. 'soon': shown with a Soon label.
  Every available network connects in one click, like Meta: 'oauth' opens the network's sign in screen,
  'oauth_form' asks one thing first (Bluesky handle, Mastodon server) then signs in there, and
  'telegram_bot' links through the ZieAds bot. Manual fields stay as a fallback only.
*/
export type PlatformStatus = 'available' | 'soon';

export interface ConnectField {
  key: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'url';
  optional?: boolean;
  help?: string;
}

export interface Platform {
  id: string;
  name: string;
  what: string;
  status: PlatformStatus;
  tokenDays?: number;
  connect?: 'oauth' | 'form' | 'oauth_form' | 'telegram_bot';
  fields?: ConnectField[];
  howTo?: string;
  /** Manual fallback (own bot token, webhook URL, app password) behind a small link in the connect window */
  manualFields?: ConnectField[];
  manualHowTo?: string;
  manualLabel?: string;
  suggestions?: string[];
}

/* DNVB (dnvb.zieads.com): TikTok is the only connector. One workspace holds many TikTok accounts. */
export const PLATFORMS: Platform[] = [
  { id: 'tiktok', name: 'TikTok', what: 'Profile stats, videos, scheduling and publishing for every account', status: 'available', connect: 'oauth' },
];

export const PLATFORM_COUNT = PLATFORMS.length;
const NAMES: Record<string, string> = { tiktok: 'TikTok', tiktok_ads: 'TikTok Ads', instagram: 'Instagram', facebook: 'Facebook' };
export const platformName = (id: string) => PLATFORMS.find((p) => p.id === id)?.name || NAMES[id] || id;
