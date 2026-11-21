import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, claudeProjectDir, homesIn, homeOf, within, planRules, insideRoots } from "../mods/roam/paths.js";

test("insideRoots accepts session files and nothing else", () => {
  const roots = ["/Users/ana/.gemini/antigravity-cli/brain/abc", "/Users/ana/.gemini/antigravity-cli/conversations/abc.db"];
  assert.ok(insideRoots("/Users/ana/.gemini/antigravity-cli/brain/abc/plan.md", roots));
  assert.ok(insideRoots("/Users/ana/.gemini/antigravity-cli/conversations/abc.db", roots));
  // A path smuggled in through a file name with a newline in it.
  assert.ok(!insideRoots("/Users/ana/.ssh/id_rsa", roots));
  assert.ok(!insideRoots("/Users/ana/.gemini/antigravity-cli/brain/abc/../../../../.ssh/id_rsa", roots));
  assert.ok(!insideRoots("/Users/ana/.gemini/antigravity-cli/brain/abc/a\nb", roots));
  assert.ok(!insideRoots("/Users/ana/.gemini/antigravity-cli/brain/abcdef/x", roots));
  assert.ok(!insideRoots("relative/path", roots));
});

test("claudeProjectDir matches Claude Code's folder names", () => {
  assert.equal(claudeProjectDir("/Users/ana/Projects/_hop-e2e"), "-Users-ana-Projects--hop-e2e");
  assert.equal(claudeProjectDir("/root/work/my.app"), "-root-work-my-app");
});

test("longest prefix wins, in one pass", () => {
  const rw = compile([
    { from: "/Users/ana", to: "/root" },
    { from: "/Users/ana/Projects", to: "/Users/ana/Projects" },
  ]);
  assert.equal(rw.text("/Users/ana/Projects/app/main.py"), "/Users/ana/Projects/app/main.py");
  assert.equal(rw.text("/Users/ana/.claude/settings.json"), "/root/.claude/settings.json");
  assert.equal(rw.text("/Users/ana"), "/root");
});

test("a mapped result is never mapped again", () => {
  // /a -> /b and /b -> /c must not turn /a into /c.
  const rw = compile([{ from: "/a", to: "/b" }, { from: "/b", to: "/c" }]);
  assert.equal(rw.text("/a/x and /b/y"), "/b/x and /c/y");
});

test("prefixes stop at component boundaries", () => {
  const rw = compile([{ from: "/Users/ana", to: "/Users/bo" }]);
  assert.equal(rw.text("/Users/anabel/x"), "/Users/anabel/x");
  assert.equal(rw.text("src/Users/ana/x"), "src/Users/ana/x");
  assert.equal(rw.text("file:///Users/ana/x"), "file:///Users/bo/x");
  assert.equal(rw.text('cd "/Users/ana" && ls'), 'cd "/Users/bo" && ls');
  assert.equal(rw.text("(/Users/ana/a.txt)"), "(/Users/bo/a.txt)");
});

test("Claude project folder names move with their paths", () => {
  const rw = compile([{ from: "/Users/ana", to: "/Users/bo" }]);
  assert.equal(
    rw.text("/Users/ana/.claude/projects/-Users-ana-Projects-app/memory/notes.md"),
    "/Users/bo/.claude/projects/-Users-bo-Projects-app/memory/notes.md",
  );
  // ...but not inside other words.
  assert.equal(rw.text("my-Users-ana-thing"), "my-Users-ana-thing");
});

test("/root rules don't touch words that merely contain root", () => {
  const rw = compile([{ from: "/root", to: "/Users/bo" }]);
  assert.equal(rw.text("/root/.claude/x"), "/Users/bo/.claude/x");
  assert.equal(rw.text("/rootfs/x and grassroots"), "/rootfs/x and grassroots");
  assert.equal(rw.text("projects/-root-work"), "projects/-Users-bo-work");
});

test("JSON lines stay valid, keys are rewritten too", () => {
  const rw = compile([{ from: "/Users/ana", to: "/home/ana" }]);
  const snapshot = {
    type: "file-history-snapshot",
    snapshot: {
      trackedFileBackups: {
        "/Users/ana/.claude/projects/-Users-ana-p/memory/a.md": { backupFileName: "0c1a@v2", realParentDir: "/Users/ana/.claude/projects/-Users-ana-p/memory" },
        "main.py": { backupFileName: "2da4@v3", realParentDir: "/Users/ana/p" },
      },
    },
  };
  const said = { type: "user", message: { content: 'she said "look in /Users/ana/p\\x" then\nleft' } };
  const out = rw.jsonl(JSON.stringify(snapshot) + "\n" + JSON.stringify(said) + "\n");
  const [a, b] = out.trim().split("\n").map((l) => JSON.parse(l));
  const backups = a.snapshot.trackedFileBackups;
  assert.deepEqual(Object.keys(backups), ["/home/ana/.claude/projects/-home-ana-p/memory/a.md", "main.py"]);
  assert.equal(backups["main.py"].realParentDir, "/home/ana/p");
  assert.equal(b.message.content, 'she said "look in /home/ana/p\\x" then\nleft');
  assert.ok(out.endsWith("\n"), "keeps the trailing newline");
});

test("a torn last line is rewritten as text, not dropped", () => {
  const rw = compile([{ from: "/Users/ana", to: "/root" }]);
  const out = rw.jsonl('{"cwd":"/Users/ana/p"}\n{"cwd":"/Users/ana/p","trunc');
  assert.equal(out, '{"cwd":"/root/p"}\n{"cwd":"/root/p","trunc');
});

test("counts changes and ignores identity rules in the count", () => {
  const rw = compile([{ from: "/Users/ana/Projects", to: "/Users/ana/Projects" }, { from: "/Users/ana", to: "/root" }]);
  rw.text("/Users/ana/Projects/x /Users/ana/y /Users/ana/z");
  assert.equal(rw.changes, 2);
});

test("no rules: text is unchanged", () => {
  const rw = compile([]);
  assert.equal(rw.text("/Users/ana/x"), "/Users/ana/x");
  assert.equal(rw.file("a.jsonl", '{"a":1}'), '{"a":1}');
});

test("homesIn finds homes, not /Users/Shared", () => {
  const seen = homesIn('"/Users/ana/x" /home/bo/y /root/.claude /Users/Shared/z "/Users/ana"');
  assert.deepEqual([...seen.entries()], [["/Users/ana", 2], ["/home/bo", 1], ["/root", 1]]);
});

test("homeOf and within", () => {
  assert.equal(homeOf("/Users/ana/Projects/x"), "/Users/ana");
  assert.equal(homeOf("/home/bo"), "/home/bo");
  assert.equal(homeOf("/root/x"), "/root");
  assert.equal(homeOf("/srv/work"), null);
  assert.equal(homeOf("/Users/Shared/x"), null);
  assert.ok(within("/a/b/c", "/a/b"));
  assert.ok(within("/a/b", "/a/b/"));
  assert.ok(!within("/a/bc", "/a/b"));
});

test("planRules: laptop to a Linux root box with the project mirrored at the same path", () => {
  // The macOS laptop's project is synced to the same path on the server,
  // where Claude runs as root.
  const rules = planRules({
    srcHome: "/Users/ana",
    dstHome: "/root",
    projects: [{ src: "/Users/ana/Projects/app", dst: "/Users/ana/Projects/app" }],
  });
  const rw = compile(rules);
  assert.equal(rw.text("/Users/ana/Projects/app/a.py"), "/Users/ana/Projects/app/a.py");
  assert.equal(rw.text("/Users/ana/.claude/projects/-Users-ana-Projects-app/x.jsonl"), "/root/.claude/projects/-Users-ana-Projects-app/x.jsonl");
});

test("planRules: from that root box on to a Mac with another username", () => {
  // Second hop: the session now mentions /root (its home) and /Users/ana
  // (where the project lives there).
  const rules = planRules({
    srcHome: "/root",
    dstHome: "/Users/bo",
    projects: [{ src: "/Users/ana/Projects/app", dst: "/Users/bo/Projects/app" }],
    mentioned: ["/root", "/Users/ana"],
  });
  const rw = compile(rules);
  assert.equal(rw.text("/Users/ana/Projects/app/a.py"), "/Users/bo/Projects/app/a.py");
  assert.equal(rw.text("/root/.claude/projects/-Users-ana-Projects-app/s.jsonl"), "/Users/bo/.claude/projects/-Users-bo-Projects-app/s.jsonl");
  assert.equal(rw.text("/Users/ana/.claude/CLAUDE.md"), "/Users/bo/.claude/CLAUDE.md");
});

test("planRules: your own rules come first and duplicates are dropped", () => {
  const rules = planRules({
    srcHome: "/Users/ana",
    dstHome: "/home/ana",
    projects: [{ src: "/Users/ana/code/app", dst: "/home/ana/code/app" }],
    extra: [{ from: "/Users/ana/code", to: "/srv/code" }],
    mentioned: ["/Users/ana", "/home/ana"],
  });
  assert.deepEqual(rules.map((r) => [r.from, r.to, r.why]), [
    ["/Users/ana/code", "/srv/code", "your rule"],
    ["/Users/ana/code/app", "/home/ana/code/app", "project folder"],
    ["/Users/ana", "/home/ana", "home folder"],
  ]);
});
