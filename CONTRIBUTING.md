# Contributing to roam

Thanks for helping. roam moves people's live work between machines, so correctness beats
features: every change should keep the rule that a failed move leaves everything as it was.

## Set up

```sh
git clone https://github.com/bugrax/herdr-roam
cd herdr-roam
ln -s "$PWD/mods/roam" ~/.config/herdr-app/mods/roam   # Herdr reloads it on every save
npm test                                                 # unit tests, no dependencies
herdr-app check ~/.config/herdr-app/mods/roam            # loads and renders the mod once
```

Then add the shortcut from [`keys.json`](keys.json) to the `global` section of
`~/.config/herdr-app/keys.json`. The mod doesn't bind it by itself:

```json
"cmd-shift-m": { "command": "mod.open", "args": { "name": "roam" } }
```

Open the dialog with `herdr-app do mod.open --name roam`. To see every screen without moving
anything, run:

```sh
herdr-app do roam.preview-review   # or pick, planning, play, done, failed
```

## Layout

| File | What it does | Imports herdr |
|---|---|---|
| `mods/roam/main.js` | The dialog | yes |
| `mods/roam/engine.js` | Plan, move, rollback | yes |
| `mods/roam/claude.js` | Claude Code adapter | yes |
| `mods/roam/transport.js` | `tar` over `hc exec`, in 6 MB pieces | yes, tested with a stub herdr and `hc` |
| `mods/roam/projects.js` | Folder fingerprints | yes |
| `mods/roam/machine.js` | `exec`, `hc` and quoting helpers | yes |
| `mods/roam/paths.js` | Path rules | **no**, unit-tested |
| `mods/roam/claude-args.js` | Resume command line | **no**, unit-tested |
| `mods/roam/preview.js` | The made-up move for screenshots | no |

Mods run in QuickJS, not Node. Use no Node APIs in `mods/`, no `setTimeout` (use `sleep` from
`machine.js`), and no top-level `await`. Logic that can be pure should live in a file without
`herdr` imports, with tests in `test/`.

## Testing a change for real

Unit tests can't prove a move works. For anything in `engine.js`, `claude.js`, `transport.js`
or `projects.js`, also:

1. Make a throwaway space with a Claude session that has made edits (for `/rewind`) and
   started a subagent.
2. Move it to a machine with a **different home folder**, then back.
3. Ask the agent about the earlier conversation, have it run a tool, and use `/rewind`.
4. Break the target (sign Claude out there, or stop its herdr-core) and check that the move rolls
   back: the agent runs on the source again, and no `.roam-*` files are left on the target.

## Screenshots

Assets in `docs/assets/` and `preview.png` come from the preview, never from real spaces:

```sh
scripts/capture.sh   # needs Herdr running, Pillow and gifski
```

`scripts/compose.py` keeps only the dialog from each window shot, so nothing else on your screen
can reach the repo.

## Commits and pull requests

- Small, focused commits. Write the message in the imperative, and say why in the body.
- Explain what you tested for real in the pull request.
- New agents: see [docs/adapters.md](docs/adapters.md).
