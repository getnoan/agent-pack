/**
 * HTML → plain text for a model to read. Shared so it can be tested: reply-worker.mjs runs its
 * main loop on import, so nothing there can be imported by a test.
 */

/** Inbound HTML → plain text for the model. Not a sanitiser (nothing here is rendered), but a
 *  closing tag browsers accept — `</script >`, `</script foo>` — must still end the block, or the
 *  script's text reaches the prompt (CodeQL js/bad-tag-filter). */
export function stripHtml(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
