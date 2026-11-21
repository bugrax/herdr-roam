// The Antigravity CLI (agy) adapter.
//
// What an agy conversation is on disk (~/.gemini/antigravity-cli):
//   conversations/<id>.db     the conversation, SQLite (WAL while agy runs)
//   brain/<id>/               its working files (plans, scratch, uploads)
//
// Conversations aren't kept per folder, so `agy --conversation <id>` finds
// one wherever it's started. The paths inside are protobuf in SQLite, where a
// string's length is part of the data; roam doesn't rewrite them. The
// conversation moves as it is, and the review says so when the project's
// path differs on the target. Credentials (antigravity-oauth-token) never move.

import { hc } from "herdr";
import { sh, hcj, sleep, q, isShell, interruptUntilGone } from "./machine.js";
import { agyResumeArgv, conversationFromArgv, isAgy } from "./agy-args.js";
import { homesIn, insideRoots } from "./paths.js";

export const id = "antigravity";
export const name = "Antigravity CLI";

const root = (m) => `${m.home}/.gemini/antigravity-cli`;
const TEXT = /\.(md|txt|json|ya?ml|toml)$/i;

/** Whether terminal `t` (from `hc get --json`) runs agy. */
export function detects(t) {
  return t?.status?.app === "antigravity" || isAgy(t?.foreground?.argv?.[0]);
}

const LIST = `for p in "$@"; do
  [ -e "$p" ] || continue
  find "$p" -type f 2>/dev/null | while IFS= read -r f; do
    printf '%s\\t%s\\n' "$(wc -c < "$f" | tr -d ' ')" "$f"
  done
done
true`;

/** Every file of conversation `s` on machine `m`. */
export async function files(m, s) {
  const r = root(m);
  const roots = [`${r}/conversations/${s.id}.db`, `${r}/conversations/${s.id}.db-wal`, `${r}/brain/${s.id}`];
  const out = await sh(m.name, LIST, roots, 120000);
  const list = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    // Only the conversation's own files, whatever the file names say.
    if (!insideRoots(path, roots)) continue;
    list.push({ path, size: Number(line.slice(0, tab)) || 0, kind: path.includes("/conversations/") ? "conversation" : "brain" });
  }
  return list;
}

/** The conversation a running agy has open: the conversations/<id>.db among its open files. */
export async function inspect(m, t) {
  const pid = t.foreground?.pid;
  const open = pid
    ? await sh(m.name, 'if [ -d "/proc/$1/fd" ]; then ls -l "/proc/$1/fd" 2>/dev/null; else lsof -p "$1" -Fn 2>/dev/null; fi | grep -o "antigravity-cli/conversations/[0-9a-f-]*\\.db" | head -1; true', [pid]).catch(() => "")
    : "";
  const cid = /conversations\/([0-9a-f-]{36})\.db/.exec(open)?.[1] ?? conversationFromArgv(t.foreground?.argv);
  if (!cid) throw new Error(`can't tell which conversation ${t.address} has open`);
  const s = { agent: id, id: cid, pid, cwd: t.foreground?.cwd ?? t.cwd, argv: t.foreground?.argv ?? ["agy"], root: root(m) };
  s.files = await files(m, s);
  s.bytes = s.files.reduce((n, f) => n + f.size, 0);
  const homes = await sh(m.name, 'LC_ALL=C grep -a -h -o -E "(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|/root)/" "$@" 2>/dev/null | sort -u', s.files.map((f) => f.path), 60000).catch(() => "");
  s.mentioned = [...homesIn(homes.replace(/\/$/gm, "")).keys()];
  return s;
}

/** agy's version on `m` (through its login shell), or null. */
export async function installed(m) {
  const out = await sh(m.name, `${q(m.shell)} -lic 'command -v agy >/dev/null 2>&1 && agy --version' 2>/dev/null | tail -1`, [], 30000).catch(() => "");
  return /\d+\.\d+/.test(out) ? out.trim().split(/\s+/).pop() : null;
}

/** Ends agy cleanly; it checkpoints its database on the way out. */
export async function stop(m, t, s) {
  await interruptUntilGone(m, t.address, s.pid, "agy");
}

/** Where its files go: the same places under the target's ~/.gemini. */
export function destinations(s, rw, dst) {
  const src = s.root + "/";
  return s.files
    .filter((f) => f.path.startsWith(src))
    .map((f) => ({ ...f, to: `${dst.home}/.gemini/antigravity-cli/${f.path.slice(src.length)}`, mode: "put", rewrite: f.kind === "brain" && TEXT.test(f.path) }));
}

/** Warnings for the review. */
export function notes(s, { src, dst, dstCwd }) {
  return dstCwd !== s.cwd
    ? [`agy keeps the paths in its conversation as they were. On ${dst.label} the folder is ${dstCwd}, so files it mentions from before still point to ${s.cwd}.`]
    : [];
}

export function resumeArgv(s, rw) {
  return agyResumeArgv(s.argv, s.id, (p) => rw.path(p));
}

export function resumeLine(s) {
  return agyResumeArgv(s.argv, s.id).map(q).join(" ");
}

const TRUST = /Do you trust the contents of this project/i;

/** Resolves once agy is up in `addr`. Its trust prompt starts on "Yes". */
export async function ready(addr, { trust = true, report = () => {}, timeout = 90000 } = {}) {
  const started = Date.now();
  let answered = false;
  let seen = false;
  while (Date.now() - started < timeout) {
    const screen = (await hc(["read", addr, "--lines", "40"]).catch(() => null))?.stdout ?? "";
    const t = await hcj(["get", addr], { ok: true }).catch(() => null);
    const tail = () => screen.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" · ");
    if (t && t.state && t.state !== "live") throw new Error(`agy exited there: ${tail()}`);
    const fg = t?.foreground?.argv?.[0] ?? "";
    if (isAgy(fg)) seen = true;
    else if ((seen || Date.now() - started > 4000) && isShell(fg)) throw new Error(`agy exited there: ${tail()}`);
    if (TRUST.test(screen)) {
      if (!trust) report("waiting for you to trust the folder there");
      else if (!answered) {
        if (!/>\s*Yes, I trust this folder/.test(screen)) await hc(["keys", addr, "up"]).catch(() => null);
        await hc(["keys", addr, "enter"]).catch(() => null);
        answered = true;
        report("trusted the folder there (it was trusted here)");
      }
      await sleep(600);
      continue;
    }
    const st = t?.status;
    if (st?.app === "antigravity" && st.state && st.state !== "working") return;
    if (/\? for shortcuts/.test(screen)) return;
    await sleep(600);
  }
  throw new Error(`agy didn't come up there within ${Math.round(timeout / 1000)} s`);
}

/** Puts the source copy away so the conversation isn't resumed twice. */
export async function archive(m, s, dests, sameFile) {
  const db = s.files.find((f) => f.kind === "conversation" && f.path.endsWith(".db"));
  const to = dests.find((d) => d.path === db?.path)?.to;
  if (!db || sameFile(db.path, to)) return false;
  await sh(m.name, '[ -f "$1" ] && mv -f "$1" "$1.roamed"; true', [db.path]);
  return true;
}
