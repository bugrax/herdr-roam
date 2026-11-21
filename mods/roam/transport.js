// Moving files between machines: tar over herdr-core, through this computer.
//
// Mods can't pipe into a program on another machine, and they read at most
// 1 MiB at a time, so files take this path:
//
//   source --(hc exec: tar -c)--> this computer --(hc exec -i: tar -x)--> target
//
// Nothing needs installing anywhere: herdr-core, sh and tar are enough.

import { exec } from "herdr";
import { q, why } from "./machine.js";

async function local(script, timeout = 600000) {
  const r = await exec("sh", ["-c", script], { timeout });
  if (r.code !== 0) throw new Error(why(r, `exit ${r.code}`));
  return r.stdout;
}

// An sh command line that runs `script` there (null: here), for the local sh.
const there = (on, script, stdin = false) => (on ? `hc exec --on ${q(on)}${stdin ? " -i" : ""} sh -c ${q(script)}` : `sh -c ${q(script)}`);

// macOS tar adds extended attributes Linux tar complains about; leave them out.
const PACK_FLAGS = 'f=""; tar --version 2>/dev/null | grep -q bsdtar && f="--no-xattrs --no-mac-metadata"';

/**
 * Copies absolute `paths` (files or folders) from machine `on` into `dir`
 * here, at the same paths under it. `exclude` patterns are tar --exclude.
 */
export async function pull(on, paths, dir, exclude = []) {
  if (!paths.length) return;
  const list = paths.map((p) => q("." + p)).join(" ");
  const ex = exclude.map((e) => `--exclude=${q(e)}`).join(" ");
  const pack = `${PACK_FLAGS}; cd / && COPYFILE_DISABLE=1 tar $f ${ex} -czf - ${list}`;
  await local(`mkdir -p ${q(dir)} && ${there(on, pack)} | tar -xzf - -C ${q(dir)}`);
}

// Unpacks a stream of put/ and add/ trees at their absolute paths:
// put/ replaces what's there (keeping a .roam-<tx>.bak of a different file),
// add/ only fills in what's missing. Writes are atomic (temp file + mv) and
// private (0600). Prints one line per file: "wrote <path>" or "kept <path>".
const UNPACK = (tx, mode) => `set -e
d=$(mktemp -d "\${TMPDIR:-/tmp}/roam.XXXXXX")
trap 'rm -rf "$d"' EXIT
tar -xzf - -C "$d" 2>"$d.err" || { cat "$d.err" >&2; rm -f "$d.err"; exit 1; }
rm -f "$d.err"
for kind in put add; do
  [ -d "$d/$kind" ] || continue
  cd "$d/$kind"
  find . -type f | while IFS= read -r f; do
    t="/\${f#./}"
    mkdir -p "$(dirname "$t")"
    if [ -e "$t" ]; then
      cmp -s "$f" "$t" && { echo "same $t"; continue; }
      [ "$kind" = add ] && { echo "kept $t"; continue; }
      cp -p "$t" "$t.roam-${tx}.bak"
    fi
    cp -p "$f" "$t.roam-tmp"
    ${mode === "keep" ? ":" : `chmod ${mode} "$t.roam-tmp"`}
    mv -f "$t.roam-tmp" "$t"
    echo "wrote $t"
  done
done`;

/**
 * Sends `dir` (with put/ and add/ inside) to machine `on`. `mode` is the
 * files' permissions there: "600" for session files, "keep" for projects.
 * Resolves with { wrote, kept, same } lists of target paths.
 */
export async function push(on, dir, tx, { mode = "600" } = {}) {
  const out = await local(`cd ${q(dir)} && COPYFILE_DISABLE=1 tar -czf - . | ${there(on, UNPACK(tx, mode), true)}`);
  const res = { wrote: [], kept: [], same: [] };
  for (const line of out.split("\n")) {
    const m = /^(wrote|kept|same) (.*)$/.exec(line);
    if (m) res[m[1]].push(m[2]);
  }
  return res;
}

/** Undoes a push: puts back each .roam-<tx>.bak, removes what was new. */
export async function unpush(on, wrote, tx) {
  if (!wrote.length) return;
  // `there` takes one script, so the paths go inside it, quoted.
  const list = wrote.map(q).join(" ");
  const script = `set -- ${list}; for t in "$@"; do if [ -e "$t.roam-${tx}.bak" ]; then mv -f "$t.roam-${tx}.bak" "$t"; else rm -f "$t"; fi; done`;
  await local(there(on, script)).catch(() => null);
}

/** Removes a folder here. */
export const wipe = (dir) => local(`rm -rf ${q(dir)}`).catch(() => null);
