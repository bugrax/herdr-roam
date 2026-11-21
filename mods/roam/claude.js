// The Claude Code adapter: how roam finds, pauses, moves and resumes a
// Claude Code session. Other agents get their own file with the same
// exports (see docs/adapters.md).
//
// What a Claude Code session is on disk (~/.claude):
//   projects/<folder>/<id>.jsonl         the transcript (<folder>: its cwd, / and . as -)
//   projects/<folder>/<id>/              subagent transcripts, large tool results
//   projects/<folder>/memory/            the project's memory (shared by its sessions)
//   file-history/<id>/                   backups behind /rewind
//   todos/<id>-*.json                    its todo lists
//   sessions/<pid>.json                  which session a running Claude has open

import { readTextFile, hc } from "herdr";
import { sh, hcj, sleep, q, isShell, interruptUntilGone } from "./machine.js";
import { resumeArgv as rebuild, sessionFromArgv, isClaude } from "./claude-args.js";
import { claudeProjectDir, homesIn } from "./paths.js";

export const id = "claude-code";
export const name = "Claude Code";

const dirOf = (p) => p.slice(0, p.lastIndexOf("/"));

/** Whether terminal `t` (from `hc get --json`) runs Claude Code. */
export function detects(t) {
  return t?.status?.app === "claude-code" || isClaude(t?.foreground?.argv?.[0]);
}

const LIST = `for p in "$@"; do
  [ -e "$p" ] || continue
  find "$p" -type f 2>/dev/null | while IFS= read -r f; do
    printf '%s\\t%s\\n' "$(wc -c < "$f" | tr -d ' ')" "$f"
  done
done
true`;

/** Every file that belongs to session `s` on machine `m`, with sizes. */
export async function files(m, s) {
  const cfg = `${m.home}/.claude`;
  const roots = [s.transcript, `${s.projectDir}/${s.id}`, `${s.projectDir}/memory`, `${cfg}/file-history/${s.id}`];
  const out = await sh(m.name, LIST, roots, 120000);
  const todos = await sh(m.name, `[ -d "$1" ] && find "$1" -type f -name "$2*" 2>/dev/null | while IFS= read -r f; do printf '%s\\t%s\\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done; true`, [`${cfg}/todos`, s.id]);
  const list = [];
  for (const line of (out + todos).split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    const kind =
      path === s.transcript ? "transcript"
      : path.startsWith(`${s.projectDir}/${s.id}/`) ? "session"
      : path.startsWith(`${s.projectDir}/memory/`) ? "memory"
      : path.includes("/file-history/") ? "history"
      : "todo";
    if (!list.some((f) => f.path === path)) list.push({ path, size: Number(line.slice(0, tab)) || 0, kind });
  }
  return list;
}

/**
 * The session running in terminal `t` on machine `m`.
 * Claude Code 2.1+ writes ~/.claude/sessions/<pid>.json for each running
 * Claude; older ones are found by a --resume <id> in their arguments.
 */
export async function inspect(m, t) {
  const cfg = `${m.home}/.claude`;
  const pid = t.foreground?.pid;
  let info = null;
  if (pid) {
    const raw = await readTextFile(`${cfg}/sessions/${pid}.json`, { on: m.name }).catch(() => null);
    try {
      info = raw ? JSON.parse(raw) : null;
    } catch {
      info = null;
    }
  }
  const sid = info?.sessionId ?? sessionFromArgv(t.foreground?.argv);
  if (!sid) throw new Error(`can't tell which session ${t.address} has open (no ${cfg}/sessions/${pid}.json; Claude Code 2.1 or newer writes one)`);

  // The newest copy, if it was ever resumed from another folder.
  const found = (await sh(m.name, 'for f in "$1"/projects/*/"$2".jsonl; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f")" "$f"; done; true', [cfg, sid]))
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ mtime: Number(l.split("\t")[0]), path: l.split("\t")[1] }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!found.length) throw new Error(`session ${sid.slice(0, 8)} has no transcript under ${cfg}/projects`);

  const s = {
    agent: id,
    id: sid,
    pid,
    cwd: info?.cwd ?? t.foreground?.cwd ?? t.cwd,
    argv: t.foreground?.argv ?? ["claude"],
    version: info?.version ?? null,
    transcript: found[0].path,
    projectDir: dirOf(found[0].path),
  };
  s.files = await files(m, s);
  s.bytes = s.files.reduce((n, f) => n + f.size, 0);

  // Which account it belongs to, and which home folders it mentions.
  const text = s.files.filter((f) => f.kind === "transcript" || f.kind === "session").map((f) => f.path);
  const facts = await sh(
    m.name,
    'grep -m1 -o "\\"type\\":\\"session-owner\\",\\"accountUuid\\":\\"[^\\"]*\\"" "$1" 2>/dev/null | sed "s/.*accountUuid\\":\\"//; s/\\"$//"; echo ---; grep -h -o -E "(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|/root)[/\\"]" "$@" 2>/dev/null | sed "s/[/\\"]$//" | sort | uniq -c',
    [s.transcript, ...text.filter((p) => p !== s.transcript)],
    60000,
  ).catch(() => "---");
  const [account, homes] = facts.split("---");
  s.account = account.trim() || null;
  s.mentioned = [...homesIn(homes.split("\n").map((l) => l.trim().replace(/^\d+\s+/, "")).join(" ")).keys()];
  return s;
}

/** The Claude account machine `m` is signed in to, or null if it can't tell. */
export async function account(m) {
  const out = await sh(m.name, 'grep -o "\\"accountUuid\\": *\\"[^\\"]*\\"" "$HOME/.claude.json" 2>/dev/null | head -1 | sed "s/.*: *\\"//; s/\\"$//"').catch(() => "");
  return out.trim() || null;
}

/** Claude Code's version on `m` (through its login shell, as agents start), or null. */
export async function installed(m) {
  const out = await sh(m.name, `${q(m.shell)} -lic 'command -v claude >/dev/null 2>&1 && claude --version' 2>/dev/null | tail -1`, [], 30000).catch(() => "");
  return /\d+\.\d+/.test(out) ? out.trim().split(" ")[0] : null;
}

/**
 * Ends Claude cleanly, so its transcript is complete: Ctrl+C until it exits
 * (the first may only clear a half-typed prompt), then SIGTERM if it won't.
 */
export async function stop(m, t, s) {
  await interruptUntilGone(m, t.address, s.pid, "Claude");
}

/** Warnings for the review, about this session on that target. */
export function notes(s, { dst }) {
  return dst.user === "root" && s.argv.includes("--dangerously-skip-permissions")
    ? [`This session skips permissions, which Claude refuses as root on ${dst.label}.`]
    : [];
}

/**
 * Where each of the session's files goes on the target. The transcript and
 * its folder go to the target cwd's own project folder, so `claude -r` lists
 * it there; memory only fills in files the target doesn't have.
 */
export function destinations(s, rw, dst, dstCwd) {
  const cfg = `${dst.home}/.claude`;
  const folder = claudeProjectDir(dstCwd);
  // Claude shortens and hashes folder names past 200 characters; keep the
  // mapped name then: --resume <id> finds a transcript in any folder.
  const projectDir = folder.length <= 200 ? `${cfg}/projects/${folder}` : rw.path(s.projectDir);
  return s.files.map((f) => {
    const rel = f.path.startsWith(s.projectDir + "/") ? f.path.slice(s.projectDir.length) : null;
    const to =
      f.kind === "transcript" ? `${projectDir}/${s.id}.jsonl`
      : rel && (f.kind === "session" || f.kind === "memory") ? projectDir + rel
      : rw.path(f.path);
    return { ...f, to, mode: f.kind === "memory" ? "add" : "put", rewrite: f.kind !== "history" };
  });
}

/** The command that resumes it on the target, with its original flags. */
export function resumeArgv(s, rw) {
  return rebuild(s.argv, s.id, (p) => rw.path(p));
}

/** What to type into the source shell to bring it back there (rollback). */
export function resumeLine(s) {
  return rebuild(s.argv, s.id).map(q).join(" ");
}

const TRUST = /Do you trust|trust this folder|Is this a project you created or one you trust/i;

/**
 * Resolves once Claude is up in terminal `addr` on the target. A folder the
 * target has never seen asks "Is this a project you trust?" with "No, exit"
 * selected: with `trust`, roam answers yes (it ran there on the source).
 */
export async function ready(addr, { trust = true, report = () => {}, timeout = 90000 } = {}) {
  const started = Date.now();
  const deadline = started + timeout;
  let answered = false;
  let seen = false;
  while (Date.now() < deadline) {
    const screen = (await hc(["read", addr, "--lines", "40"]).catch(() => null))?.stdout ?? "";
    const t = await hcj(["get", addr], { ok: true }).catch(() => null);
    const tail = () => screen.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" · ");
    if (t && t.state && t.state !== "live") throw new Error(`Claude exited there: ${tail()}`);
    // It runs inside the login shell; the shell back in front means Claude quit.
    const fg = t?.foreground?.argv?.[0] ?? "";
    if (isClaude(fg)) seen = true;
    else if ((seen || Date.now() - started > 4000) && isShell(fg)) throw new Error(`Claude exited there: ${tail()}`);
    if (TRUST.test(screen)) {
      if (!trust) report("waiting for you to trust the folder there");
      else if (!answered) {
        if (/❯\s*(1\.\s*)?No, exit/.test(screen)) {
          await hc(["keys", addr, "down"]).catch(() => null);
          await sleep(250);
        }
        await hc(["keys", addr, "enter"]).catch(() => null);
        answered = true;
        report("trusted the folder there (it was trusted here)");
      }
      await sleep(600);
      continue;
    }
    const st = t?.status;
    if (st?.app === "claude-code" && st.state && st.state !== "working") return;
    if (/accept edits on|bypass permissions on|plan mode on|\? for shortcuts|shift\+tab to cycle/.test(screen)) return;
    await sleep(600);
  }
  throw new Error(`Claude didn't come up there within ${Math.round(timeout / 1000)} s`);
}

/**
 * Puts the source copy away so it isn't resumed in two places: the
 * transcript becomes <id>.jsonl.roamed. Skipped when source and target
 * share the file (the same path in a synced ~/.claude).
 */
export async function archive(m, s, dests, sameFile) {
  const t = dests.find((d) => d.kind === "transcript");
  if (!t || sameFile(s.transcript, t.to)) return false;
  await sh(m.name, '[ -f "$1" ] && mv -f "$1" "$1.roamed"; true', [s.transcript]);
  return true;
}
