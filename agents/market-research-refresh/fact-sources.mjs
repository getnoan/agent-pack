/**
 * The `sources` a fact write carries (POST /facts): the pages the fact was read
 * from, shown in the app next to the fact. Shared by every writer that drafts from a page it
 * already holds: market research (the pages each block was drafted from) and brand extract
 * (the site it read).
 *
 * Only a page a reader could open belongs here. A source is visible to everyone in the
 * project, so a URL that carries credentials is refused rather than recorded: that is why
 * Feeds, which reads authenticated APIs, passes none.
 */

const FACT_SOURCES_MAX = 20;
const SECRET_PARAM = /^(?:api[_-]?key|key|token|access[_-]?token|auth|secret|sig|signature|password|pass|code)$/i;

/** A URL that is safe and useful as a source, or null. */
export function sourceUrl(raw) {
  const s = String(raw || "").trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password) return null;
  for (const k of u.searchParams.keys()) if (SECRET_PARAM.test(k)) return null;
  return s;
}

/** From [{url}] (anything with a url), the API's `sources`: safe http(s) URLs, deduped, at
 *  most 20. Empty means the key is left out of the write. */
export function factSources(used) {
  const out = [], seen = new Set();
  for (const r of used || []) {
    const url = sourceUrl(r?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url });
    if (out.length === FACT_SOURCES_MAX) break;
  }
  return out;
}

/** The POST /facts body: sources only when there are some (the API rejects an explicit null). */
export function factWriteBody(blockSlug, content, sources) {
  return { blockSlug, content, ...(sources?.length ? { sources } : {}) };
}

/** The `rationale` a fact write carries (POST /facts): why the fact changed,
 *  shown to approvers and in the version history. Only for a reason a source gives — the
 *  spec is explicit that a request to change is not a reason, so routine refreshes pass
 *  none. Sources here are pages ({type: "reference", url}), filtered like factSources.
 *  null (and the key left out of the write) when there is no text or no usable source. */
export function factRationale(text, urls = []) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const sources = factSources((urls || []).map(url => ({ url }))).map(s => ({ type: "reference", url: s.url }));
  if (!t || !sources.length) return null;
  return { text: t.length <= 2000 ? t : t.slice(0, 1997) + "...", sources };
}
