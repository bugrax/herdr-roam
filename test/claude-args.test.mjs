import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeArgv, sessionFromArgv, isClaude } from "../mods/roam/claude-args.js";

const ID = "08c97baf-4b24-4bc9-89e8-311ed2dbf76d";
const OLD = "dde9f5ce-8162-4b8a-b114-0e80a9864a8c";

test("keeps model, permission mode and allowed tools", () => {
  assert.deepEqual(
    resumeArgv(["claude", "--model", "haiku", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(python3:*)"], ID),
    ["claude", "--resume", ID, "--model", "haiku", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(python3:*)"],
  );
});

test("drops the session it was opened with", () => {
  assert.deepEqual(resumeArgv(["claude", "--resume", OLD, "--model", "opus"], ID), ["claude", "--resume", ID, "--model", "opus"]);
  assert.deepEqual(resumeArgv(["claude", "-r"], ID), ["claude", "--resume", ID]);
  assert.deepEqual(resumeArgv(["claude", "--continue", "--fork-session"], ID), ["claude", "--resume", ID]);
  assert.deepEqual(resumeArgv(["claude", `--resume=${OLD}`], ID), ["claude", "--resume", ID]);
});

test("drops the first prompt, which is already in the transcript", () => {
  assert.deepEqual(resumeArgv(["claude", "fix the login bug"], ID), ["claude", "--resume", ID]);
  assert.deepEqual(resumeArgv(["claude", "--verbose", "fix the login bug"], ID), ["claude", "--resume", ID, "--verbose"]);
});

test("maps path flags to the target", () => {
  const map = (p) => p.replace("/Users/ana", "/home/ana");
  assert.deepEqual(
    resumeArgv(["/Users/ana/.local/bin/claude", "--add-dir", "/Users/ana/lib", "/Users/ana/docs", "--settings=/Users/ana/s.json", "--model", "/not/a/flag/path"], ID, map),
    ["claude", "--resume", ID, "--add-dir", "/home/ana/lib", "/home/ana/docs", "--settings=/home/ana/s.json", "--model", "/not/a/flag/path"],
  );
});

test("tool patterns with spaces stay one value; a trailing prompt doesn't", () => {
  assert.deepEqual(
    resumeArgv(["claude", "--allowedTools", "Bash(git log:*)", "Read", "please review this"], ID),
    ["claude", "--resume", ID, "--allowedTools", "Bash(git log:*)", "Read"],
  );
});

test("unknown flags keep a one-word value, not a sentence", () => {
  assert.deepEqual(resumeArgv(["claude", "--new-flag", "fast"], ID), ["claude", "--resume", ID, "--new-flag", "fast"]);
  assert.deepEqual(resumeArgv(["claude", "--new-flag", "do the thing"], ID), ["claude", "--resume", ID, "--new-flag"]);
});

test("sessionFromArgv", () => {
  assert.equal(sessionFromArgv(["claude", "--resume", OLD]), OLD);
  assert.equal(sessionFromArgv(["claude", `--session-id=${OLD}`]), OLD);
  assert.equal(sessionFromArgv(["claude", "-r"]), null);
  assert.equal(sessionFromArgv(["claude", "--resume", "my session name"]), null);
});

test("isClaude", () => {
  assert.ok(isClaude("claude"));
  assert.ok(isClaude("/Users/ana/.local/bin/claude"));
  assert.ok(!isClaude("claude-code-helper"));
  assert.ok(!isClaude("zsh"));
});
