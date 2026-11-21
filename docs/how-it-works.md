# How roam works

roam moves a herdr space from one machine to another while its agents are alive. This page
explains each step, why it works, and where the edges are.

## The idea

Process-level live migration isn't available to us:

- **macOS** has nothing like [CRIU](https://criu.org). Apple's Virtualization framework can save
  and restore a whole VM, but not a process.
- **Linux to Linux**, CRIU could checkpoint the agent's process. But the agent holds a TLS
  connection to its API, and CRIU restores TCP connections only when the address stays the same.
  Its PTY also belongs to herdr-core, not to the agent, and would have to be grafted onto a new one
  on the target.

What makes the move possible anyway is that a coding agent keeps its state on disk. A Claude Code
session is a transcript (`~/.claude/projects/<folder>/<id>.jsonl`) plus a few folders next to it,
and `claude --resume <id>` rebuilds the conversation from them. So roam migrates at the
application level: it pauses the agent between turns, copies its files with every path rewritten,
and resumes it by id on the other machine.

## The steps

| Step | What happens | Why |
|---|---|---|
| **Check the target** | Starts and removes a throwaway terminal there (tried twice), finds `claude` through the login shell, reads free disk space, compares Claude accounts. | Fail before anything changes. A target that can't start terminals is caught here, not after agents pause. |
| **Let agents finish their turn** | Waits for your sync to bring the project folders up to date, while agents still work. Then polls each agent's status: `working` waits with `hc wait`, and `blocked` (a permission prompt) waits for you. | Pausing mid-turn could cut off an edit or a tool call. Syncing first keeps the pause short. |
| **Pause agents** | Ctrl+C until Claude exits (up to three times, since the first may only clear a half-typed prompt), then SIGTERM if needed. Confirms the process is gone. | A clean exit flushes the transcript. From here on, any failure rolls back. |
| **Match project files** | Fingerprints each project folder on both machines. If they differ, waits for your sync (90 s by default). If the folder is missing on the target, copies it. | The agent must find the same files when it continues. |
| **Move sessions** | Lists the session's files, pulls them with `tar` over `hc exec`, rewrites paths, and pushes them to the target. | The transcript is the agent's memory. |
| **Start on the target** | Starts one terminal per pane with `hc run --on <target>`, labelled with new space and tab ids. Herdr adopts labelled terminals into a space. The space and its tabs keep their names. | It's the same space, now on the other machine. |
| **Wait for agents** | Reads each new terminal's screen and status until Claude is up. Answers the folder-trust prompt when `carryTrust` is on. Fails fast if Claude exits. | The move only counts once the agents run. |
| **Close the old space** | Renames each source transcript to `<id>.jsonl.roamed`, selects the new space, then closes the old one. | A session must not be resumed in two places. The old space closes last because closing it can close the dialog. |

## Moving files

Mods can't pipe into a program on another machine, and `readTextFile` reads at most 1 MiB. Files
therefore travel through the computer running the herdr window:

```
source ──(hc exec: tar -c)──▶ this computer ──(hc exec -i: tar -x)──▶ target
```

- herdr-core carries at most 8 MB into or out of one `hc exec`. A session with screenshots or PDFs
  in it is past that even compressed, and so are most project folders. So an archive going to or
  coming from another machine is written to a file, moved 6 MB at a time (`dd` there, `hc exec -i`
  appending here), checked with `cksum` on arrival, and only then unpacked. The review shows
  "sending them to … (2 of 3)" as the pieces go. `test/transport.test.mjs` runs `pull` and `push`
  against a stand-in `hc` that enforces the same limits.
- Paths are rewritten by `perl` in its own process, streaming each file line by line, with the rules `paths.js` compiles. A 10 MB transcript takes a few hundredths of a second. Mods run in QuickJS on Herdr's own thread, and rewriting a session that size there froze the window long enough to look broken. `test/rewrite-perl.test.mjs` checks that perl and `paths.js` produce byte-identical output.
- On macOS, `tar` runs with `--no-xattrs --no-mac-metadata`, so Linux `tar` gets no extended
  headers it doesn't understand.
- On the target, files are unpacked into a temporary folder first, then each one is copied into
  place atomically (temp file, then `mv`) with mode `0600`.
- An existing file that differs is kept as `<file>.roam-<tx>.bak`. Rollback restores these and
  removes files that were new.
- Project memory is shared by every session of a project, so it is only added to. A memory file the
  target already has is kept as it is.
- Project folders copied because they were missing keep their permissions, so executable bits
  survive. Dependency and build folders (`node_modules`, `.venv`, `target`, ...) are left out.

## Which files belong to a Claude Code session

| Path under `~/.claude` | What | Rewritten |
|---|---|---|
| `projects/<folder>/<id>.jsonl` | The transcript. `<folder>` is the cwd with every non-alphanumeric character replaced by `-`. | yes |
| `projects/<folder>/<id>/` | Subagent transcripts (`subagents/agent-*.jsonl`, `.meta.json`) and large tool results. | yes |
| `projects/<folder>/memory/` | The project's memory, shared by its sessions. Only added, never replaced. | yes |
| `file-history/<id>/` | The backups behind `/rewind`, as `<hash>@v<n>`. These are your files' contents. | no |
| `todos/<id>-*.json` | Todo lists. | yes |

roam finds which session a terminal runs from `~/.claude/sessions/<pid>.json`, which Claude Code
2.1+ writes for every running Claude. herdr-core reports each terminal's foreground pid. Older
versions are found by a `--resume <id>` in the command line.

The transcript goes to the **target cwd's own folder** (`projects/<target folder>/<id>.jsonl`),
so `claude -r` lists it there. `claude --resume <id>` would also find it in any other folder, and
roam relies on that for cwds whose folder name exceeds 200 characters, which Claude Code shortens
with a hash.

## Which files belong to an Antigravity CLI conversation

| Path under `~/.gemini/antigravity-cli` | What | Rewritten |
|---|---|---|
| `conversations/<id>.db` | The conversation, SQLite (with a WAL while agy runs) | no |
| `brain/<id>/` | Its working files: plans, scratch files, uploads | text files only |

agy doesn't keep a pid file. The conversation a running agy has open is found among its open files
(`/proc/<pid>/fd` on Linux, `lsof` on macOS). agy checkpoints its WAL when it exits, so the
database is copied only after the pause. Conversations aren't stored per folder, and
`agy --conversation <id>` finds one wherever it starts. Inside the database, paths are protobuf
fields whose length is part of the data, and rewriting them without the schema could corrupt it.
roam moves the conversation as it is, and the review warns when the project's path differs on the
target. agy's `antigravity-oauth-token` never moves.

## Path rules

A session mentions absolute paths everywhere: `cwd` on every line, tool inputs and outputs, the
backups' `realParentDir`, its own transcript folder. roam builds prefix rules, most specific first:

1. your own rules (`roam.json`),
2. each project folder: kept when the same path exists on the target, otherwise moved to the
   same place under the target's home,
3. the source home to the target home,
4. any other home the session mentions (`/Users/x`, `/home/x`, `/root`) to the target home. That
   covers a session that already moved once.

`paths.js` compiles the rules into one regular expression and rewrites in a single pass, so a
result is never rewritten again (`/a → /b` and `/b → /c` never turn `/a` into `/c`):

- **Longest prefix first.** An identity rule (`/Users/ana/Projects → /Users/ana/Projects`)
  shields a folder from a shorter rule (`/Users/ana → /root`).
- **Whole components only.** A prefix must start where a path can start and end at `/`, a quote,
  whitespace or punctuation. `/Users/anabel` and `src/Users/ana` are left alone.
- **Claude's folder spelling comes along.** Every rule also covers its project-folder form:
  `/Users/ana → /home/ana` rewrites `-Users-ana-code-app` to `-home-ana-code-app`.
- **Real JSON.** Each JSONL line is parsed and every string is rewritten, keys included, so
  escapes and quotes stay valid. A line that doesn't parse (a torn last line) is rewritten as
  text, so nothing is dropped.

The review lists the rules before anything moves. `test/paths.test.mjs` covers the cases above,
including a laptop to Linux root hop and a second hop on to another Mac.

## Rollback

From the moment the first agent pauses, a failure triggers this, in order:

1. Every terminal roam started on the target is killed, along with any `claude --resume <id>` left
   running there.
2. Every file written on the target is restored from its `.roam-<tx>.bak`, or removed if it was new.
3. Every paused agent resumes on the source. When its pane is a shell again, roam types the resume
   command there. Otherwise it starts a new terminal in the same space and tab.

Before the first agent pauses, Esc cancels and nothing has changed.

A move can also be cut off outright: the dialog closed (⌘⇧M again), Herdr quit, the machine slept. roam writes the journal at every step: before each agent stops and after it stops, after files land on the target, and after each terminal starts there. Each entry holds what a rollback needs: the pane, the resume command, the space and tab, and what was started and written. A dialog that closes mid-move starts the rollback on its way out: it kills what started on the target and types the resume command into each stopped agent's pane. The next time roam opens, it lists every journal still marked as running and offers **Bring them back** (or `r`). That runs the full rollback, and an agent that is already running is left alone. Each move writes a journal to
`~/.config/herdr-app/.roam/<tx>/journal.json` with the rules, panes and a timestamped log. It
never contains copies of session files. Those are deleted after every move, successful or not.

## Measured

Real moves of a Claude Code session (one subagent, `/rewind` history, project memory) between a
MacBook and a Linux box over Tailscale:

| Direction | Files | Paths rewritten | Agents paused | Total |
|---|---|---|---|---|
| Linux → macOS | 14 · 1.6 MB | 100 | 6.5 s | 6.9 s |
| macOS → Linux | 13 · 1.6 MB | 100 | 8.5 s | 10.4 s |
| macOS → macOS, another username (Claude Code) | 14 · 1.6 MB | 467 | 7.9 s | 8.4 s |
| Linux → macOS (Antigravity CLI) | 8 · 495 KB | n/a | 3.9 s | 4.4 s |

Most of the pause is Claude exiting (about 1 to 2 s) and starting again on the target (about 3 s).

## Edges

- **Keep the dialog open** until the move finishes. It runs inside the dialog. Closing it mid-move
  rolls back instead of finishing (see Rollback).
- **Split sizes** aren't carried over. Panes come back in order in the same tabs, and herdr lays
  them out.
- **Same session in two places.** roam renames the source transcript after a move. When both
  machines share `~/.claude` at the same path (one synced folder), there is only one file and it
  is left in place.
- **Different Claude account on the target.** The session's `session-owner` line names its
  account. The review warns, because Claude may refuse to open it.
- **Root targets.** Claude Code refuses `--dangerously-skip-permissions` as root, and the review says so.
- **Windows** isn't supported yet: paths, shells and `tar` differ.
