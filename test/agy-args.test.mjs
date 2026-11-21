import { test } from "node:test";
import assert from "node:assert/strict";
import { agyResumeArgv, conversationFromArgv, isAgy, olderVersion } from "../mods/roam/agy-args.js";

const ID = "f20940a5-376e-45de-8278-1ab0bec150c4";
const OLD = "02ce25c2-7bb4-4b2a-987c-77c8d2d94845";

test("keeps model and mode, resumes by id", () => {
  assert.deepEqual(
    agyResumeArgv(["agy", "--model", "gemini-3.8-flash-low", "--mode", "accept-edits"], ID),
    ["agy", "--conversation", ID, "--model", "gemini-3.8-flash-low", "--mode", "accept-edits"],
  );
});

test("drops the old conversation, continue, and first prompts", () => {
  assert.deepEqual(agyResumeArgv(["agy", "--conversation", OLD, "--effort", "high"], ID), ["agy", "--conversation", ID, "--effort", "high"]);
  assert.deepEqual(agyResumeArgv(["agy", "-c"], ID), ["agy", "--conversation", ID]);
  assert.deepEqual(agyResumeArgv(["agy", "-i", "fix the tests", "--sandbox"], ID), ["agy", "--conversation", ID, "--sandbox"]);
  assert.deepEqual(agyResumeArgv(["agy", `--conversation=${OLD}`, "--new-project"], ID), ["agy", "--conversation", ID]);
});

test("maps path flags", () => {
  const map = (p) => p.replace("/Users/ana", "/home/ana");
  assert.deepEqual(
    agyResumeArgv(["/Users/ana/.local/bin/agy", "--add-dir", "/Users/ana/lib", "--settings=/Users/ana/s.json", "--project", "web"], ID, map),
    ["agy", "--conversation", ID, "--add-dir", "/home/ana/lib", "--settings=/home/ana/s.json", "--project", "web"],
  );
});

test("conversationFromArgv and isAgy", () => {
  assert.equal(conversationFromArgv(["agy", "--conversation", OLD]), OLD);
  assert.equal(conversationFromArgv(["agy", `--conversation=${OLD}`]), OLD);
  assert.equal(conversationFromArgv(["agy", "-c"]), null);
  assert.ok(isAgy("agy") && isAgy("/root/.local/bin/agy") && !isAgy("agy-helper"));
});

test("olderVersion compares numerically", () => {
  assert.ok(olderVersion("1.1.3", "1.5.14"));
  assert.ok(olderVersion("1.5.6", "1.5.14"));
  assert.ok(!olderVersion("1.5.14", "1.5.6"));
  assert.ok(!olderVersion("1.5.14", "1.5.14"));
});
