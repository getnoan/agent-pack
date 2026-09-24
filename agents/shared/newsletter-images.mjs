/**
 * Newsletter images: from bytes a person dropped in Slack to a public URL an
 * email can show.
 *
 * WHERE. Supabase Storage, a public bucket (`newsletter-images`) in the project
 * the fleet already runs. Not the company site: the site's host went down on
 * 2026-09-21 while the first test issue was being read, and every image in an
 * email depends on its host at the moment someone OPENS it, days after it was
 * sent. Not R2 on our own domain: that needs the domain's DNS on Cloudflare.
 *
 * NO IMAGE LIBRARY. The hosted Slack service deploys without an install step,
 * so this is plain Node. The resizing is Supabase's own image transformation,
 * probed 2026-09-21: it resizes without upscaling, applies a phone photo's
 * rotation tag, and drops the metadata (location included). So the original is
 * put in a PRIVATE staging bucket, read back once through a signed transform
 * URL, and only the result is stored in the public bucket. The original, with
 * whatever its camera wrote into it, is deleted and was never public.
 *
 * NAMES CARRY THE SIZE. A stored image is `nl/<16 hex of the source's
 * sha256>-<width>x<height>.<ext>`. The hash makes a second upload of the same
 * picture return the first URL; the size lets the email renderer, which cannot
 * fetch anything, give the <img> the width and height Outlook needs.
 *
 * GIFs are stored as they are (the transform would flatten an animation), and
 * only when already small enough. WebP and HEIC are refused with the fix: most
 * email clients do not show them.
 */
import { createHash } from "node:crypto";

export const BUCKET = "newsletter-images";
export const STAGING_BUCKET = "newsletter-images-src";
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_FINAL_BYTES = 1024 * 1024;
export const TARGET_WIDTH = 1200;           // twice the email's 600px column: sharp on a retina screen
export const CACHE = "max-age=31536000";    // names are content hashes, so a stored image never changes

const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif" };
const EXT = { png: "png", jpeg: "jpg", gif: "gif" };

/** What these bytes are, from their first bytes rather than a filename, and their pixel size. */
export function sniffImage(buf) {
  const b = Buffer.from(buf || []);
  if (b.length < 24) return { error: "that file is empty or is not a picture" };
  if (b.readUInt32BE(0) === 0x89504e47) return { kind: "png", mime: MIME.png, ext: EXT.png, width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 3) === "GIF") return { kind: "gif", mime: MIME.gif, ext: EXT.gif, width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        return { kind: "jpeg", mime: MIME.jpeg, ext: EXT.jpeg, width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { error: "that JPG could not be read" };
  }
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return { error: "WebP pictures do not show in Outlook. Save it as JPG or PNG and send it again" };
  if (b.toString("ascii", 4, 8) === "ftyp" && /hei[cx]|mif1|msf1|heim|heis/.test(b.toString("ascii", 8, 12))) return { error: "iPhone HEIC pictures do not show in most email. Export it as JPG and send it again" };
  return { error: "that is not a PNG, JPG or GIF" };
}

/** `nl/<hash>-1200x630.jpg` -> { width: 1200, height: 630 }, or null for a name without a size. */
export function dimsFromUrl(url) {
  const m = /-(\d{1,5})x(\d{1,5})\.(?:png|jpe?g|gif)(?:[?#].*)?$/i.exec(String(url || ""));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function publicBase(supabaseUrl, bucket = BUCKET) {
  return `${String(supabaseUrl).replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/`;
}

/**
 * The uploader. `url` and `key` are the Supabase project URL and its service
 * role key; `fetchImpl` is injectable for tests.
 *
 * host(bytes) -> { url, width, height, bytes, mime, reused }
 * Throws an Error whose message is written for the person who sent the
 * picture: what is wrong and what to do instead.
 */
export function newsletterImageHost({ url, key, fetchImpl = fetch, bucket = BUCKET, staging = STAGING_BUCKET }) {
  if (!url || !key) throw new Error("newsletterImageHost: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const root = String(url).replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${key}`, apikey: key };
  const pub = publicBase(root, bucket);

  async function call(path, init = {}) {
    const res = await fetchImpl(`${root}/storage/v1${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    return res;
  }
  async function existing(hash) {
    const res = await call(`/object/list/${bucket}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefix: "nl", search: hash, limit: 5 }) });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const hit = (Array.isArray(rows) ? rows : []).find(r => String(r?.name || "").startsWith(`${hash}-`));
    return hit ? `nl/${hit.name}` : null;
  }
  async function put(bkt, path, bytes, mime, extra = {}) {
    const res = await call(`/object/${bkt}/${path}`, { method: "POST", headers: { "Content-Type": mime, "x-upsert": "true", ...extra }, body: bytes });
    if (!res.ok) throw new Error(`storage upload failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
  async function transformed(path, { width, quality }) {
    const res = await call(`/object/sign/${staging}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 120, transform: { width, resize: "contain", ...(quality ? { quality } : {}) } }) });
    if (!res.ok) throw new Error(`storage could not prepare the resize (${res.status})`);
    const { signedURL } = await res.json();
    const img = await fetchImpl(`${root}/storage/v1${signedURL}`);
    if (!img.ok) throw new Error(`storage could not resize the picture (${img.status})`);
    return Buffer.from(await img.arrayBuffer());
  }

  async function host(input) {
    const src = Buffer.from(input || []);
    if (src.length > MAX_SOURCE_BYTES) throw new Error(`it is ${(src.length / 1048576).toFixed(1)} MB, and pictures over 10 MB are not taken. Export a smaller copy and send it again`);
    const info = sniffImage(src);
    if (info.error) throw new Error(info.error);
    const hash = createHash("sha256").update(src).digest("hex").slice(0, 16);
    const already = await existing(hash);
    if (already) {
      const d = dimsFromUrl(already);
      return { url: pub + already, width: d?.width, height: d?.height, bytes: null, mime: info.mime, reused: true };
    }

    let out = src, final = info;
    if (info.kind === "gif") {
      if (src.length > MAX_FINAL_BYTES) throw new Error(`the GIF is ${(src.length / 1048576).toFixed(1)} MB; an animated picture in an email must be under 1 MB. Make it shorter or smaller and send it again`);
    } else {
      const stage = `${hash}.${info.ext}`;
      await put(staging, stage, src, info.mime);
      try {
        // The largest first; a PNG that stays heavy (a detailed screenshot)
        // steps down in width, a JPG steps down in quality.
        const tries = info.kind === "jpeg"
          ? [{ width: TARGET_WIDTH, quality: 80 }, { width: TARGET_WIDTH, quality: 65 }, { width: 1000, quality: 60 }]
          : [{ width: TARGET_WIDTH }, { width: 1000 }, { width: 800 }];
        for (const t of tries) {
          out = await transformed(stage, t);
          if (out.length <= MAX_FINAL_BYTES) break;
        }
      } finally {
        await call(`/object/${staging}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [stage] }) }).catch(() => {});
      }
      final = sniffImage(out);
      if (final.error) throw new Error("storage returned something that is not a picture");
      if (out.length > MAX_FINAL_BYTES) throw new Error(`even at ${final.width}px wide it is ${(out.length / 1048576).toFixed(1)} MB; email pictures must be under 1 MB. Send it as a JPG instead of a PNG`);
    }
    const path = `nl/${hash}-${final.width}x${final.height}.${final.ext}`;
    await put(bucket, path, out, final.mime, { "cache-control": CACHE });
    return { url: pub + path, width: final.width, height: final.height, bytes: out.length, mime: final.mime, reused: false };
  }

  return { host, base: pub };
}
