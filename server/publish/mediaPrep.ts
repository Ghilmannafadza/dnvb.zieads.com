/*
  Media fixes before a post goes to a platform that is strict about images.
  Instagram only takes JPEG photos with an aspect ratio between 4:5 and 1.91:1. A PNG, WebP or a tall
  phone screenshot is refused with a vague error, so ZieAds converts and crops a copy here and posts that copy.
  The copy is stored next to the original (Vercel Blob when connected, else Supabase Storage).
*/
import crypto from "crypto";
import sharp from "sharp";
import { put } from "@vercel/blob";
import { blobToken } from "../utils/blobToken.js";
import { supabaseAdmin } from "../supabaseServer.js";
import { PublishError } from "./errors.js";

const BUCKET = "post-attachments";
const MAX_BYTES = 30 * 1024 * 1024;

async function store(buf: Buffer, key: string): Promise<string> {
  const token = blobToken();
  if (token) {
    const b = await put(`converted/${key}.jpg`, buf, { access: "public", contentType: "image/jpeg", token, addRandomSuffix: false, allowOverwrite: true });
    return b.url;
  }
  const path = `converted/${key}.jpg`;
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, buf, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(error.message);
  return supabaseAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export type ImageRules = { jpegOnly?: boolean; minRatio?: number; maxRatio?: number };
export const INSTAGRAM_IMAGE: ImageRules = { jpegOnly: true, minRatio: 4 / 5, maxRatio: 1.91 };
/** Threads takes JPEG and PNG; WebP and others become JPEG */
export const THREADS_IMAGE: ImageRules = { jpegOnly: true };

/** Returns a URL the platform accepts: the original when it already fits, else a converted copy */
export async function prepareImage(url: string, rules: ImageRules, platform: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e: any) {
    throw new PublishError(`Could not read the image for ${platform} (${e?.cause?.code || e.message}). ZieAds will retry.`, true);
  }
  if (!res.ok) throw new PublishError(`Could not read the image for ${platform} (${res.status}). Attach the file again.`, res.status >= 500);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new PublishError(`The image is ${Math.round(buf.byteLength / 1e6)} MB. ${platform} takes up to 8 MB; use a smaller file.`, false);
  let meta: { width?: number; height?: number; format?: string };
  try {
    meta = await sharp(buf).metadata();
  } catch {
    // Unreadable here: a JPEG goes as is and the platform decides, anything else cannot be fixed
    if (type.includes("jpeg") || /\.jpe?g(\?|$)/i.test(url)) return url;
    throw new PublishError(`${platform} could not use this file as an image. Attach a JPG or PNG.`, false);
  }
  const w = meta.width || 0;
  const h = meta.height || 0;
  const ratio = w && h ? w / h : 1;
  const isJpeg = meta.format === "jpeg" || type.includes("jpeg");
  const tooTall = rules.minRatio && ratio < rules.minRatio - 0.005;
  const tooWide = rules.maxRatio && ratio > rules.maxRatio + 0.005;
  if ((!rules.jpegOnly || isJpeg) && !tooTall && !tooWide) return url;

  let img = sharp(buf).rotate();
  if (tooTall || tooWide) {
    // Centre crop to the nearest ratio the platform accepts, keeping the full width or height
    const target = tooTall ? rules.minRatio! : rules.maxRatio!;
    const cw = tooTall ? w : Math.round(h * target);
    const ch = tooTall ? Math.round(w / target) : h;
    img = img.extract({ left: Math.max(0, Math.round((w - cw) / 2)), top: Math.max(0, Math.round((h - ch) / 2)), width: Math.min(cw, w), height: Math.min(ch, h) });
  }
  const out = await img.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const key = crypto.createHash("sha256").update(url).update(JSON.stringify(rules)).digest("hex").slice(0, 32);
  try {
    return await store(out, key);
  } catch (e: any) {
    throw new PublishError(`Could not prepare the image for ${platform} (${e.message}). ZieAds will retry.`, true);
  }
}
