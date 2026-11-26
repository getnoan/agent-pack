/**
 * NOAN UI markdown escaping, undone.
 *
 * Saving a fact in the NOAN app round-trips its markdown: specials come back
 * backslash-escaped (MAX_WORDS: -> MAX\_WORDS:, [[QUERIES]] -> \[\[QUERIES\]\]),
 * a backslash already in the text is doubled, and a bare URL is rewritten as a
 * self-referential link. None of it changes a word a person reads, and all of it
 * changes what a regex sees.
 *
 * So every parser that reads a machine-readable line out of a config fact
 * (`KEY: value`, a `[[FENCE]]`) runs the text through this first. Without it, one
 * edit in the app turns `^MAX_WORDS:` into a key that is silently absent: the
 * worker falls back to its defaults, or fails closed, and nothing errors.
 * Rewriting the fact unescaped only lasts until the next edit in the app, so the
 * parsers tolerate the escaping instead.
 *
 * Apply it where text is PARSED, not where it is fetched: anything that compares
 * or re-posts a fact needs its live bytes as they are.
 */
export const unescapeUi = (s) => String(s ?? "")
  // [https://example.com](https://example.com) -> https://example.com. The backreference is the
  // point: only a SELF-referential link is the UI's autolinking. A real link whose text differs
  // from its href is authored content and is left alone.
  .replace(/\[([^\]\n]+)\]\(\1\)/g, "$1")
  // \[ \] \_ \* ... -> [ ] _ * ...   and the doubled \\b in a regex back to \b.
  .replace(/\\([\\`*_{}\[\]()#+\-.!|~])/g, "$1");
