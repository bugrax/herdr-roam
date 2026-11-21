// Moving files between machines: tar over herdr-core, through this computer.
//
// Mods can't pipe into a program on another machine, and they read at most
// 1 MiB at a time, so files take this path:
//
//   source --(hc exec: tar -c)--> this computer --(hc exec -i: tar -x)--> target
//
// herdr-core carries at most 8 MB into or out of one exec, so anything going
// to or coming from another machine travels as an archive file in pieces:
// packed, moved PIECE_MB at a time with dd, checked with cksum, unpacked.
// Nothing needs installing anywhere: herdr-core, sh, tar, dd and cksum.

import { exec } from "herdr";
import { q, why } from "./machine.js";

/** Megabytes per hc exec: under herdr-core's 8 MB, with room to spare. */
export const PIECE_MB = 6;
const MB = 1048576;

async function local(script, timeout = 600000) {
  const r = await exec("sh", ["-c", script], { timeout });
  if (r.code !== 0) throw new Error(why(r, `exit ${r.code}`));
  return r.stdout;
}

// `hc exec` on machine `on`, as the start of an sh command line. herdr-core's
// own limit is 60 s, too short to pack a big folder.
const hcOn = (on, stdin = false) => `hc exec --on ${q(on)} --timeout 600${stdin ? " -i" : ""}`;

// An sh command line that runs `script` there (null: here), for the local sh.
const there = (on, script, stdin = false) => (on ? `${hcOn(on, stdin)} sh -c ${q(script)}` : `sh -c ${q(script)}`);

// macOS tar adds extended attributes Linux tar complains about; leave them out.
const PACK_FLAGS = 'f=""; tar --version 2>/dev/null | grep -q bsdtar && f="--no-xattrs --no-mac-metadata"';

// Prints "<crc> <size>" of a file, the same on macOS, Linux and busybox.
const SUM = (file) => `set -- $(cksum < ${file}); echo "$1 $2"`;

// Fails unless the file's cksum is `want` ("<crc> <size>").
const CHECK = (file, want, from) =>
  `set -- $(cksum < ${file}); [ "$1 $2" = ${q(want)} ] || { echo ${q(`the archive from ${from} arrived damaged`)} >&2; exit 1; }`;

/** How many PIECE_MB pieces a file of `size` bytes takes. */
export const pieces = (size) => Math.max(1, Math.ceil(Number(size) / (PIECE_MB * MB)));

// A scratch folder there; the name is checked before anything removes it.
async function scratch(on) {
  const d = (await local(there(on, 'mktemp -d "${TMPDIR:-/tmp}/roam.XXXXXX"'))).trim();
  if (!/^\/[^\n]*\/roam\.[A-Za-z0-9]+$/.test(d)) throw new Error(`unexpected scratch folder on ${on}: ${d}`);
  return d;
}

const parseSum = (out) => {
  const [crc, size] = out.trim().split(/\s+/);
  if (!/^\d+$/.test(crc ?? "") || !/^\d+$/.test(size ?? "")) throw new Error(`unexpected cksum output: ${out.trim()}`);
  return { sum: `${crc} ${size}`, size: Number(size) };
};

/**
 * Copies absolute `paths` (files or folders) from machine `on` into `dir`
 * here, at the same paths under it. `exclude` patterns are tar --exclude.
 * `progress(done, total)` hears about each piece.
 */
export async function pull(on, paths, dir, exclude = [], { progress } = {}) {
  if (!paths.length) return;
  const list = paths.map((p) => q("." + p)).join(" ");
  const ex = exclude.map((e) => `--exclude=${q(e)}`).join(" ");
  if (!on) {
    await local(`mkdir -p ${q(dir)} && ${PACK_FLAGS}; cd / && COPYFILE_DISABLE=1 tar $f ${ex} -czf - ${list} | tar -xzf - -C ${q(dir)}`);
    return;
  }
  const rdir = await scratch(on);
  const file = `${dir}.tgz`;
  try {
    // A file that vanished or changed while tar read it is a warning, not a
    // failure; an archive with nothing in it is.
    const pack = `${PACK_FLAGS}; a=${q(rdir + "/x.tgz")}
cd / && COPYFILE_DISABLE=1 tar $f ${ex} -czf "$a" ${list} 2>${q(rdir + "/err")} || [ -s "$a" ] || { cat ${q(rdir + "/err")} >&2; exit 1; }
${SUM('"$a"')}`;
    const { sum, size } = parseSum(await local(there(on, pack)));
    const n = pieces(size);
    await local(`: > ${q(file)}`);
    for (let i = 0; i < n; i++) {
      progress?.(i, n);
      const cut = `dd if="$1" bs=${MB} skip="$2" count=${PIECE_MB} 2>/dev/null`;
      await local(`${hcOn(on)} sh -c ${q(cut)} sh ${q(rdir + "/x.tgz")} ${i * PIECE_MB} >> ${q(file)}`);
    }
    progress?.(n, n);
    await local(`${CHECK(q(file), sum, on)}\nmkdir -p ${q(dir)} && tar -xzf ${q(file)} -C ${q(dir)}`);
  } finally {
    await local(there(on, `rm -rf ${q(rdir)}`)).catch(() => null);
    await local(`rm -f ${q(file)}`).catch(() => null);
  }
}

// Unpacks an archive (`from`: a quoted path, or - for stdin) of put/ and add/
// trees at their absolute paths: put/ replaces what's there (keeping a
// .roam-<tx>.bak of a different file), add/ only fills in what's missing.
// Writes are atomic (temp file + mv) and private (0600). Prints one line per
// file: "wrote <path>", "kept <path>" or "same <path>".
const UNPACK = (tx, mode, from = "-") => `set -e
d=$(mktemp -d "\${TMPDIR:-/tmp}/roam.XXXXXX")
trap 'rm -rf "$d"' EXIT
tar -xzf ${from} -C "$d" 2>"$d.err" || { cat "$d.err" >&2; rm -f "$d.err"; exit 1; }
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

function parseUnpack(out) {
  const res = { wrote: [], kept: [], same: [] };
  for (const line of out.split("\n")) {
    const m = /^(wrote|kept|same) (.*)$/.exec(line);
    if (m) res[m[1]].push(m[2]);
  }
  return res;
}

/**
 * Sends `dir` (with put/ and add/ inside) to machine `on`. `mode` is the
 * files' permissions there: "600" for session files, "keep" for projects.
 * `progress(done, total)` hears about each piece. Resolves with
 * { wrote, kept, same } lists of target paths.
 */
export async function push(on, dir, tx, { mode = "600", progress } = {}) {
  if (!on) return parseUnpack(await local(`cd ${q(dir)} && COPYFILE_DISABLE=1 tar -czf - . | sh -c ${q(UNPACK(tx, mode))}`));
  const file = `${dir}.tgz`;
  let rdir = null;
  try {
    const { sum, size } = parseSum(await local(`cd ${q(dir)} && COPYFILE_DISABLE=1 tar -czf ${q(file)} . && ${SUM(q(file))}`));
    rdir = await scratch(on);
    const archive = q(rdir + "/x.tgz");
    const n = pieces(size);
    for (let i = 0; i < n; i++) {
      progress?.(i, n);
      await local(`dd if=${q(file)} bs=${MB} skip=${i * PIECE_MB} count=${PIECE_MB} 2>/dev/null | ${hcOn(on, true)} sh -c 'cat >> "$1"' sh ${archive}`);
    }
    progress?.(n, n);
    return parseUnpack(await local(there(on, `${CHECK(archive, sum, "this computer")}\n${UNPACK(tx, mode, archive)}`)));
  } finally {
    if (rdir) await local(there(on, `rm -rf ${q(rdir)}`)).catch(() => null);
    await local(`rm -f ${q(file)}`).catch(() => null);
  }
}

/** Undoes a push: puts back each .roam-<tx>.bak, removes what was new. */
export async function unpush(on, wrote, tx) {
  if (!wrote.length) return;
  // `there` takes one script, so the paths go inside it, quoted.
  const list = wrote.map(q).join(" ");
  const script = `set -- ${list}; for t in "$@"; do if [ -e "$t.roam-${tx}.bak" ]; then mv -f "$t.roam-${tx}.bak" "$t"; else rm -f "$t"; fi; done`;
  await local(there(on, script)).catch(() => null);
}

/** After a move that worked: drops the .roam-<tx>.bak copies (they're only for rollback). */
export async function dropBackups(on, wrote, tx) {
  if (!wrote.length) return;
  const list = wrote.map(q).join(" ");
  await local(there(on, `set -- ${list}; for t in "$@"; do rm -f "$t.roam-${tx}.bak"; done`)).catch(() => null);
}

/** Removes a folder here. */
export const wipe = (dir) => local(`rm -rf ${q(dir)}`).catch(() => null);
