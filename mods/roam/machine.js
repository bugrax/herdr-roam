// Running things on a machine through herdr-core: this computer (null) or
// another one from `hc machine ls`.

import { exec, hc } from "herdr";

/** Quotes a word for sh. */
export function q(s) {
  s = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/** The last few lines of what a failed program said. */
export function why(r, fallback = "it failed") {
  const text = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/LIBARCHIVE\.xattr|unknown extended header/.test(l));
  return lines.slice(-3).join(" · ") || fallback;
}

/** Runs an sh script on `on` (null: here). Resolves with stdout, rejects with what it said. */
export async function sh(on, script, args = [], timeout = 60000) {
  const r = await exec("sh", ["-c", script, "sh", ...args.map(String)], { on: on ?? null, timeout });
  if (r.code !== 0) {
    const e = new Error(why(r, `exit ${r.code}`));
    e.code = r.code;
    throw e;
  }
  return r.stdout;
}

/**
 * Runs hc and parses its JSON. Rejects with hc's own error message.
 * --json goes right after the subcommand: anything after `--` belongs to
 * the program `hc run` starts.
 */
export async function hcj(args, { ok = false } = {}) {
  const r = await hc([args[0], "--json", ...args.slice(1)]);
  let body = null;
  try {
    body = JSON.parse(r.stdout || "null");
  } catch {
    body = null;
  }
  if (r.code !== 0 && !ok) {
    const e = new Error(body?.error?.message || why(r, `hc ${args[0]} failed`));
    e.kind = body?.error?.kind;
    throw e;
  }
  return body;
}

/** `hc ... --on <m>` for another machine, nothing for this one. */
export const onArgs = (m) => (m ? ["--on", m] : []);

/** Waits (mods have no setTimeout). */
export const sleep = (ms) => exec("sleep", [(ms / 1000).toFixed(2)]).then(() => null, () => null);

/** What roam needs to know about a machine: its home, shell, OS and user. */
export async function describe(on) {
  const out = await sh(on, 'printf "%s\\n%s\\n%s\\n%s\\n" "$HOME" "${SHELL:-/bin/sh}" "$(uname -s)" "$(id -un)"', [], 20000);
  const [home, shell, os, user] = out.split("\n");
  if (!home) throw new Error(`${on ?? "this computer"} didn't say where its home is`);
  return { name: on ?? null, label: on ?? "this computer", home, shell, os, user, mac: os === "Darwin" };
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "pwsh", "elvish", "xonsh"]);
const POSIX = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"]);
const base = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");

/** argv[0] is a shell (`zsh`, `-zsh`, `/bin/bash`). */
export const isShell = (argv0) => SHELLS.has(base(argv0));

/**
 * Runs `cmd` in the machine's interactive login shell, which stays open
 * after it exits: what Herdr does for agents, so PATH and aliases match.
 */
export function inShell(shell, cmd) {
  return POSIX.has(base(shell)) ? [shell, "-lic", '"$@"; exec "$0" -li', shell, ...cmd] : cmd;
}

/** A login shell that first prints a dim note (what this pane was running). */
export function shellWithNote(shell, note) {
  return POSIX.has(base(shell)) ? [shell, "-lic", 'printf "\\033[2m%s\\033[0m\\n" "$1"; exec "$0" -li', shell, note] : null;
}

/**
 * Ends an agent the way a person would: Ctrl+C until its process exits (the
 * first may only clear a half-typed prompt), then SIGTERM if it won't.
 */
export async function interruptUntilGone(m, addr, pid, label) {
  const alive = async () => (await sh(m.name, 'kill -0 "$1" 2>/dev/null && echo yes || echo no', [pid]).catch(() => "no")).trim() === "yes";
  for (let i = 0; i < 3 && (await alive()); i++) {
    await hc(["keys", addr, "ctrl+c"]).catch(() => null);
    await sleep(350);
    await hc(["keys", addr, "ctrl+c"]).catch(() => null);
    for (let j = 0; j < 10 && (await alive()); j++) await sleep(300);
  }
  if (await alive()) {
    await sh(m.name, 'kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -ge 50 ] && exit 1; sleep 0.2; done', [pid]).catch(() => {
      throw new Error(`${label} (pid ${pid}) on ${m.label} didn't exit`);
    });
  }
}

/** A random hex id. */
export function hex(n = 32) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return s.slice(0, n);
}
