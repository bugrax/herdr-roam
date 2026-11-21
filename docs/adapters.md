# Agent adapters

roam knows how to move an agent through an adapter: one module that finds a running session,
pauses it, lists its files, says where they go, and resumes it. There are two to learn from:
[`claude.js`](../mods/roam/claude.js) handles a JSONL transcript keyed by folder, with every path
rewritten. [`agy.js`](../mods/roam/agy.js) handles a SQLite conversation found through the
process's open files and moved as it is. To support another agent, write a module with the same exports and add it to
`ADAPTERS` in [`engine.js`](../mods/roam/engine.js).

## The interface

```js
export const id = "codex";              // what the agent reports to herdr (status.app)
export const name = "Codex CLI";

// Does terminal `t` (from `hc get --json`) run this agent?
export function detects(t) {}

// The running session in terminal `t` on machine `m`
// (m: { name, label, home, shell, os, user }). Must return at least:
//   { agent, id, pid, cwd, argv, files: [{ path, size, kind }], bytes,
//     account?, mentioned? }
// `mentioned`: home folders the session refers to (helps path rules).
export async function inspect(m, t) {}

// Every file of session `s` now (called again after the agent pauses).
export async function files(m, s) {}

// Ends the agent cleanly so its files are complete; resolves when its process is gone.
export async function stop(m, t, s) {}

// Optional, for Move now: ends the agent's turn right away without breaking its history
// (Claude Code: Esc). Resolves with what was cut off: { turn, background }. roam then
// stops it as usual and, on the target, tells it to carry on. Without it, Move now
// still waits for this agent's turn to end.
export async function interrupt(m, t, s) {}

// Where each file goes on target `dst` (cwd there: `dstCwd`), given the
// compiled path rules `rw`. Each entry: { ...file, to, mode: "put" | "add", rewrite: boolean }
//   put: replace what's there (a backup is kept); add: only if missing.
//   rewrite: run the path rules over its contents (false for binary or user files).
export function destinations(s, rw, dst, dstCwd) {}

// The argv that resumes it on the target, and the line that resumes it here (rollback).
export function resumeArgv(s, rw) {}
export function resumeLine(s) {}

// Resolves once the agent is up in terminal `addr`; handles first-run prompts.
export async function ready(addr, { trust, report, timeout }) {}

// Puts the source copy away so the session isn't resumed twice. Returns whether it did.
export async function archive(m, s, dests, sameFile) {}

// Used by the review: the agent's version on a machine (null when it isn't there),
// the signed-in account (optional), and warnings about this session on that target (optional).
export async function installed(m) {}
export async function account(m) {}
export function notes(s, { src, dst, dstCwd }) {}
```

`machine.js` has helpers every adapter needs: `sh(on, script, args)` runs a script on a machine
(pass paths as arguments, not inside the script), `hcj(args)` runs `hc` and parses its JSON, and
`sleep(ms)`.

## Notes for the agents people ask about

These are starting points. Check each against the agent's own docs and source before relying on it.

### Codex CLI

- Sessions are JSONL rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
  A SQLite index (`state_*.sqlite`) and `session_index.jsonl` sit beside them.
- Resume with `codex resume <id>`.
- `cwd` appears in the rollout's `session_meta` and turn context, and in the SQLite `threads` table.
  Copying the rollout without the SQLite index may let Codex re-index it. Verify this.
- Its hooks expose `CODEX_THREAD_ID`.

### Gemini CLI

- Sessions are under `~/.gemini/tmp/<project hash>/chats/`. The hash is derived from the project
  path, so it must be recomputed for the target cwd rather than rewritten.
- Resume with `gemini --resume <id>`.

### opencode

- Sessions live in SQLite (`~/.local/share/opencode/opencode.db`). Don't copy a live database.
  Prefer `opencode export <id>` on the source and `opencode import <file>` on the target, then
  `opencode --session <id>`.

## Testing an adapter

- Put its pure parts (argv parsing, path shapes) in a separate file without `herdr` imports and
  unit-test them like `test/claude-args.test.mjs`.
- Then move a real session there and back between two machines with different home folders. Check
  that the agent remembers the conversation, that tools work at the new paths, and that a failed
  move (stop the agent's binary on the target) rolls back cleanly.
