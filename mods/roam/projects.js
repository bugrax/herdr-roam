// Is a project folder the same on both machines?
//
// roam doesn't sync projects itself: Syncthing, Dropbox, a shared mount or
// git usually do. Before an agent continues on the target, its folder must
// match the source. A fingerprint of the contents answers that:
//   - in a git repo: HEAD, the status, the uncommitted diff and the untracked
//     files (git's own ignores apply);
//   - elsewhere: every file's checksum, skipping build and dependency folders.
// Both use cksum, which every Mac and Linux box has.

import { sh, q } from "./machine.js";

/** Folders nobody syncs: they're rebuilt on each machine. */
export const SKIP = [
  "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".gradle", "DerivedData",
  "Pods", "target", ".terraform", ".DS_Store",
];

const prune = SKIP.map((n) => `-name ${q(n)}`).join(" -o ");

const FINGERPRINT = `cd "$1" 2>/dev/null || { echo missing; exit 0; }
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  export GIT_OPTIONAL_LOCKS=0
  {
    git rev-parse HEAD 2>/dev/null || echo no-commits
    git status --porcelain=v1 -uall 2>/dev/null | LC_ALL=C sort
    git diff HEAD --binary 2>/dev/null | cksum
    git ls-files -o --exclude-standard 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do cksum "$f" 2>/dev/null; done
  } | cksum | awk '{ print "git " $1 " " $2 }'
else
  n=$(find . \\( ${prune} -o -name .git \\) -prune -o -type f -print 2>/dev/null | head -20001 | wc -l | tr -d ' ')
  [ "$n" -gt 20000 ] && { echo big; exit 0; }
  find . \\( ${prune} -o -name .git \\) -prune -o -type f -print 2>/dev/null | LC_ALL=C sort |
    while IFS= read -r f; do cksum "$f" 2>/dev/null; done | cksum | awk '{ print "files " $1 " " $2 }'
fi`;

/**
 * A folder's fingerprint on machine `on`: "missing", "big" (too many files
 * to check), or "git …" / "files …" to compare.
 */
export async function fingerprint(on, dir) {
  return (await sh(on, FINGERPRINT, [dir], 120000)).trim() || "missing";
}

/** Whether `dir` exists on `on`. */
export async function exists(on, dir) {
  return (await sh(on, '[ -d "$1" ] && echo yes || echo no', [dir])).trim() === "yes";
}

/** Compares a folder on two machines: "same", "differs", "missing", or "unknown". */
export async function compare(src, srcDir, dst, dstDir) {
  const [a, b] = await Promise.all([fingerprint(src, srcDir), fingerprint(dst, dstDir)]);
  if (b === "missing") return { state: "missing", src: a, dst: b };
  if (a === "big" || b === "big" || a === "missing") return { state: "unknown", src: a, dst: b };
  return { state: a === b ? "same" : "differs", src: a, dst: b };
}

/** How big a folder is (KB), leaving out the folders nobody syncs. */
export async function sizeKb(on, dir) {
  const ex = SKIP.map((n) => `-not -path ${q(`*/${n}/*`)}`).join(" ");
  const out = await sh(on, `cd "$1" && find . -type f ${ex} -exec ls -ln {} + 2>/dev/null | awk '{ s += $5 } END { print int(s / 1024) }'`, [dir], 120000).catch(() => "0");
  return Number(out.trim()) || 0;
}
