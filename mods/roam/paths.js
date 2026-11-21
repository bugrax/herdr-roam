// Path rewriting for sessions that move between machines.
//
// A session remembers absolute paths: where it ran, the files it read, its
// own transcript folder. On another machine those paths change (a different
// home, a different project root), so roam rewrites them with prefix rules:
// longest prefix first, in one pass, inside every JSON string.
//
// Pure functions, no herdr imports: Node unit-tests this file directly.

/** Claude Code names a project's transcript folder after its working directory. */
export function claudeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

// A path prefix starts where a path can start (not in the middle of a word)
// and ends where a path component ends.
const BEFORE = "(?<![A-Za-z0-9_.~-])";
const AFTER_PATH = "(?=$|[/\\\\\"'`\\s:;,)\\]}>|])";
const AFTER_DIR = "(?=$|[-/\\\\\"'`\\s:;,)\\]}>|])";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * Builds a rewriter from rules `[{ from, to }]` of absolute path prefixes.
 * Each rule also covers its Claude project-folder spelling (`/a/b` -> `-a-b`).
 * A rule whose `from` equals its `to` shields that prefix from shorter rules
 * (keep `/Users/me/Projects` while `/Users/me` becomes `/root`).
 */
export function compile(rules) {
  const table = new Map();
  for (const r of rules ?? []) {
    if (!r?.from || !r.from.startsWith("/") || trimSlash(r.from) === "/") continue;
    const from = trimSlash(r.from);
    const to = trimSlash(r.to ?? r.from);
    if (!table.has(from)) table.set(from, { to, dir: false });
    const encoded = claudeProjectDir(from);
    if (!table.has(encoded)) table.set(encoded, { to: claudeProjectDir(to), dir: true });
  }
  const keys = [...table.keys()].sort((a, b) => b.length - a.length);
  const rx = keys.length
    ? new RegExp(keys.map((k) => BEFORE + escapeRe(k) + (table.get(k).dir ? AFTER_DIR : AFTER_PATH)).join("|"), "g")
    : null;
  let changes = 0;

  const text = (s) => {
    if (!rx || typeof s !== "string") return s;
    return s.replace(rx, (m) => {
      const to = table.get(m).to;
      if (to !== m) changes++;
      return to;
    });
  };

  const value = (v) => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[text(k)] = value(v[k]);
      return out;
    }
    return v;
  };

  // One JSON document per line; a line that doesn't parse (a torn last line)
  // is rewritten as text so nothing is dropped.
  const jsonl = (src) =>
    src
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        try {
          return JSON.stringify(value(JSON.parse(line)));
        } catch {
          return text(line);
        }
      })
      .join("\n");

  const json = (src) => {
    try {
      return JSON.stringify(value(JSON.parse(src)));
    } catch {
      return text(src);
    }
  };

  /** Rewrites a file's contents by its kind: .jsonl, .json, or plain text. */
  const file = (path, src) => (path.endsWith(".jsonl") ? jsonl(src) : path.endsWith(".json") ? json(src) : text(src));

  return {
    text,
    value,
    jsonl,
    json,
    file,
    /** Maps one absolute path; unmatched paths come back unchanged. */
    path: (p) => text(p),
    get changes() {
      return changes;
    },
    rules: keys.filter((k) => !table.get(k).dir).map((k) => ({ from: k, to: table.get(k).to })),
    /** Every prefix it replaces, folder spellings included (what rewrite-perl.js applies). */
    entries: keys.map((k) => ({ from: k, to: table.get(k).to, dir: table.get(k).dir })),
  };
}

const HOME_LIKE = /(?<![A-Za-z0-9_.~-])(\/Users\/(?!Shared(?:[/"'\s]|$))[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|\/root)(?=$|[/\\"'`\s:;,)\]}>|])/g;

/** Home folders a text mentions (`/Users/x`, `/home/x`, `/root`) and how often. */
export function homesIn(text) {
  const seen = new Map();
  for (const m of String(text).matchAll(HOME_LIKE)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  return seen;
}

/** The home-like folder a path lives under (`/Users/x/a/b` -> `/Users/x`), or null. */
export function homeOf(path) {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/.exec(String(path));
  return m && m[1] !== "/Users/Shared" ? m[1] : null;
}

/**
 * Whether `path` is one of `roots` or inside one, with no `..` segment and no
 * control characters. File lists come from `find`, one path per line, and a
 * file an agent named with a newline must not smuggle in another path.
 */
export function insideRoots(path, roots) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) return false;
  return roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"));
}

/** `child` is `parent` or inside it. */
export function within(child, parent) {
  const c = trimSlash(child);
  const p = trimSlash(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

/**
 * The rules for one move, most specific first:
 *   1. the person's own rules,
 *   2. each project folder (kept when the same path exists on the target),
 *   3. the source home to the target home,
 *   4. any other home the sessions mention, to the target home.
 */
export function planRules({ srcHome, dstHome, projects = [], extra = [], mentioned = [] }) {
  const rules = [];
  const add = (from, to, why) => {
    if (from && to && !rules.some((r) => r.from === trimSlash(from))) rules.push({ from: trimSlash(from), to: trimSlash(to), why });
  };
  for (const r of extra) add(r.from, r.to, "your rule");
  for (const p of projects) if (p.src && p.dst) add(p.src, p.dst, p.src === p.dst ? "same path there" : "project folder");
  if (srcHome && dstHome) add(srcHome, dstHome, "home folder");
  for (const h of mentioned) if (h !== dstHome && !rules.some((r) => within(h, r.from))) add(h, dstHome, "another home it mentions");
  return rules;
}
