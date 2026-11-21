// pull and push against a stand-in hc (test/support/bin/hc) that keeps
// herdr-core's limits: at most 8 MB piped into one exec, 8 MB back out.
// Sessions with images and big project folders are well past that.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register("./support/hooks.mjs", import.meta.url);
const { pull, push, pieces, PIECE_MB } = await import("../mods/roam/transport.js");

const BIN = fileURLToPath(new URL("./support/bin", import.meta.url));
const MB = 1048576;
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "roam-transport-"));
  // Scratch folders land here, so the tests can see they're cleaned up.
  process.env.TMPDIR = mkdtempSync(join(root, "tmp-"));
  process.env.PATH = `${BIN}:${process.env.PATH}`;
});

const fresh = (name) => mkdtempSync(join(root, `${name}-`));
const leftovers = () => readdirSync(process.env.TMPDIR);

test("the stand-in hc refuses more than 8 MB piped in, like herdr-core", () => {
  const big = join(fresh("limit"), "big");
  writeFileSync(big, randomBytes(9 * MB));
  assert.throws(() => execFileSync("sh", ["-c", `hc exec --on box -i sh -c 'cat > /dev/null' < '${big}'`], { stdio: "pipe" }), /at most 8 MB piped in/);
});

test("push sends an archive bigger than 8 MB in pieces", async () => {
  const dir = fresh("out");
  const target = join(fresh("there"), "projects", "a session.jsonl");
  const bytes = randomBytes(20 * MB); // random bytes don't compress
  mkdirSync(join(dir, "put", target, ".."), { recursive: true });
  writeFileSync(join(dir, "put", target), bytes);
  const seen = [];
  const res = await push("box", dir, "tx1", { progress: (i, n) => seen.push([i, n]) });
  assert.deepEqual(res.wrote, [target]);
  assert.ok(readFileSync(target).equals(bytes));
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const n = seen[0][1];
  assert.ok(n >= 4, `expected at least 4 pieces, got ${n}`);
  assert.deepEqual(seen.at(-1), [n, n]);
  assert.equal(existsSync(`${dir}.tgz`), false);
  assert.deepEqual(leftovers(), []);
});

test("push of the same files again changes nothing", async () => {
  const dir = fresh("out");
  const target = join(fresh("there"), "memory", "notes.md");
  mkdirSync(join(dir, "put", target, ".."), { recursive: true });
  writeFileSync(join(dir, "put", target), "hello\n");
  assert.deepEqual((await push("box", dir, "tx2")).wrote, [target]);
  const again = await push("box", dir, "tx3");
  assert.deepEqual([again.wrote, again.same], [[], [target]]);
  assert.deepEqual(leftovers(), []);
});

test("push keeps a backup of a file it replaces, and add/ never replaces", async () => {
  const there = fresh("there");
  const put = join(there, "t.jsonl");
  const add = join(there, "keep.md");
  writeFileSync(put, "old\n");
  writeFileSync(add, "theirs\n");
  const dir = fresh("out");
  mkdirSync(join(dir, "put", there), { recursive: true });
  mkdirSync(join(dir, "add", there), { recursive: true });
  writeFileSync(join(dir, "put", put), "new\n");
  writeFileSync(join(dir, "add", add), "ours\n");
  const res = await push("box", dir, "tx4");
  assert.deepEqual([res.wrote, res.kept], [[put], [add]]);
  assert.equal(readFileSync(put, "utf8"), "new\n");
  assert.equal(readFileSync(`${put}.roam-tx4.bak`, "utf8"), "old\n");
  assert.equal(readFileSync(add, "utf8"), "theirs\n");
});

test("pull fetches more than 8 MB from another machine in pieces", async () => {
  const src = fresh("src");
  const a = randomBytes(11 * MB);
  const b = randomBytes(3 * MB);
  mkdirSync(join(src, "sub"));
  writeFileSync(join(src, "a.bin"), a);
  writeFileSync(join(src, "sub", "b.bin"), b);
  writeFileSync(join(src, "sub", "skip.log"), "no");
  const dir = join(fresh("stage"), "src");
  const seen = [];
  await pull("box", [src], dir, ["*.log"], { progress: (i, n) => seen.push([i, n]) });
  assert.ok(readFileSync(join(dir, src, "a.bin")).equals(a));
  assert.ok(readFileSync(join(dir, src, "sub", "b.bin")).equals(b));
  assert.equal(existsSync(join(dir, src, "sub", "skip.log")), false);
  assert.ok(seen[0][1] >= 3);
  assert.equal(existsSync(`${dir}.tgz`), false);
  assert.deepEqual(leftovers(), []);
});

test("pull from this computer still pipes straight through", async () => {
  const src = fresh("src");
  writeFileSync(join(src, "x.txt"), "x");
  const dir = join(fresh("stage"), "src");
  await pull(null, [src], dir);
  assert.equal(readFileSync(join(dir, src, "x.txt"), "utf8"), "x");
});

test("pull of a path that vanished brings the rest and cleans up", async () => {
  // tar only warns about it; the rewrite step after a pull reports a missing session file.
  const src = fresh("src");
  writeFileSync(join(src, "here.txt"), "here");
  const dir = join(fresh("stage"), "src");
  await pull("box", [join(src, "here.txt"), join(src, "gone.txt")], dir);
  assert.equal(readFileSync(join(dir, src, "here.txt"), "utf8"), "here");
  assert.equal(existsSync(join(dir, src, "gone.txt")), false);
  assert.deepEqual(leftovers(), []);
});

test("pieces", () => {
  assert.equal(pieces(1), 1);
  assert.equal(pieces(PIECE_MB * MB), 1);
  assert.equal(pieces(PIECE_MB * MB + 1), 2);
  assert.ok(PIECE_MB * MB < 8_000_000);
});
