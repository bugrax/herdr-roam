# Security

roam copies agent sessions between your own machines, and those sessions can contain secrets:
anything an agent read or printed. This is what it touches and what it never does.

## What roam reads, writes and sends

- **Reads**, on the source: the session's files under `~/.claude` (transcript, subagents,
  project memory, `/rewind` backups, todos) or `~/.gemini/antigravity-cli` (the conversation and
  its `brain` folder), `~/.claude/sessions/<pid>.json`, and fingerprints of
  the project folders. On the target: the `accountUuid` in `~/.claude.json`, to warn about a
  different account.
- **Writes**, on the target: those session files under `~/.claude` or `~/.gemini/antigravity-cli`,
  with mode `0600`, and a missing project folder when `copyMissingProjects` is on. On the source:
  it renames the moved transcript to `<id>.jsonl.roamed` (or `<id>.db.roamed` for agy).
- **On the computer running the herdr window**: files pass through `~/.config/herdr-app/.roam/<tx>/`
  and are deleted when the move ends, whether it worked or not. Only `journal.json` (paths, ids,
  timings, and no file contents) is kept.
- **Over the network**: only through herdr-core's own connections to your machines (`hc exec`,
  normally over SSH). roam has no server, makes no other network calls and collects no telemetry.

## What roam never does

- Copy credentials: `~/.claude/.credentials.json`, the macOS Keychain, agy's
  `antigravity-oauth-token`, or any other agent's auth.
  The target must already be signed in.
- Run a move without your click on **Move**. The preview never plans or moves a real space.
- Overwrite a file on the target without keeping a `.roam-<tx>.bak` of it until the move succeeds.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/bugrax/herdr-roam/security/advisories/new)
for this repository, with steps to reproduce. You'll get an answer within a week.
