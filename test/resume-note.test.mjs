// What an agent hears after Move now cut it off. It is typed into the agent
// as a message, so it has to say what happened, and that the interruption
// wasn't the person turning a tool call down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/hooks.mjs", import.meta.url);
const { resumeNote } = await import("../mods/roam/engine.js");

test("a turn cut off mid tool call: not the user's no, run it again", () => {
  assert.equal(
    resumeNote({ turn: true, background: false }),
    "[roam] This session just moved to another machine. To do that it interrupted your last turn, so a tool call that shows as rejected or interrupted was not the user's decision: run it again if you still need its result. Then continue where you left off.",
  );
});

test("background commands that stopped may be started again", () => {
  assert.equal(
    resumeNote({ turn: false, background: true }),
    "[roam] This session just moved to another machine. To do that it stopped the commands you had running in the background: start them again if you still need them. Then continue where you left off.",
  );
  assert.match(resumeNote({ turn: true, background: true }), /not the user's decision: .* It also stopped the commands you had running in the background/);
});

test("after a rollback it says the move was undone", () => {
  assert.match(resumeNote({ turn: true, background: false }, false), /^\[roam\] roam started moving this session to another machine, then undid the move\. To do that it interrupted/);
});
