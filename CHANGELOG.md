# Changelog

## 0.1.0 (2026-11-21)

First version.

- Move a herdr space to another connected machine: this computer, or any machine in `hc machine ls`.
- Claude Code adapter. Each session finishes its turn, exits cleanly, and is resumed by id on the
  target with its original flags. Transcripts, subagents, project memory, `/rewind` history and
  todos move with it.
- Antigravity CLI (`agy`) adapter. Each conversation finishes its turn and exits, its database
  and working files move as they are, and it resumes with `agy --conversation <id>`.
- Path rules: longest prefix first, in one pass, inside JSON. They follow Claude Code's
  project-folder names and other homes a session mentions.
- Project folders are compared on both machines. roam waits for your sync, or copies a folder that
  is missing on the target.
- A review lists every pane, folder and path rule, warns, and blocks moves that can't work.
- Rollback after any failure once agents pause. A journal is written for every move.
- A preview mode and a screenshot pipeline that only ever show made-up data.
- Large sessions: paths are rewritten by perl in its own process. Doing it in the mod froze Herdr on a
  10 MB transcript, and the move was lost when the dialog closed.
- A move cut off by the dialog closing or Herdr quitting rolls back. The dialog starts the rollback as it
  closes, and the next time it opens it offers to finish it (**Bring them back**).
- Project folders are synced before agents pause, not after, so the pause stays short.
- Sessions and folders bigger than 8 MB move in 6 MB pieces, checked with `cksum`. herdr-core refuses
  more than 8 MB piped into one `hc exec`, which stopped a 27 MB session from moving.
