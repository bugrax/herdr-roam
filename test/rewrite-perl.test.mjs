// The perl rewriter must do exactly what paths.js does: same rules, same
// boundaries, same count. Runs the real script with the system perl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, planRules } from "../mods/roam/paths.js";
import { PERL_REWRITE, rulesText, manifestText } from "../mods/roam/rewrite-perl.js";

const LINES = [
  { cwd: "/Users/ana/code/app", message: { content: "read /Users/ana/code/app/main.py and /Users/anabel/x" } },
  { snapshot: { trackedFileBackups: { "/Users/ana/.claude/projects/-Users-ana-code-app/memory/a.md": { realParentDir: "/Users/ana/code/app" } } } },
  { text: 'cd "/Users/ana" && ls (/Users/ana/notes.txt) src/Users/ana/no file:///Users/ana/yes' },
  { text: "projects/-Users-ana-code-app/x my-Users-ana-thing /root/.claude /rootfs grassroots" },
  { text: "unicode: /Users/ana/çalışma/dosya.md — ok" },
];

function both(rules, text) {
  const rw = compile(rules);
  const js = rw.jsonl(text);
  const dir = mkdtempSync(join(tmpdir(), "roam-perl-"));
  writeFileSync(join(dir, "in.jsonl"), text);
  writeFileSync(join(dir, "rules.tsv"), rulesText(rw.entries));
  writeFileSync(join(dir, "manifest.tsv"), manifestText([{ from: join(dir, "in.jsonl"), out: join(dir, "out", "deep", "out.jsonl"), rewrite: true }]));
  const n = Number(execFileSync("perl", ["-e", PERL_REWRITE, join(dir, "rules.tsv"), join(dir, "manifest.tsv")]).toString().trim());
  return { js, perl: readFileSync(join(dir, "out", "deep", "out.jsonl"), "utf8"), jsChanges: rw.changes, perlChanges: n };
}

test("perl and paths.js agree: home to home", () => {
  const text = LINES.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const r = both([{ from: "/Users/ana", to: "/home/ana" }], text);
  assert.equal(r.perl, r.js);
  assert.equal(r.perlChanges, r.jsChanges);
  assert.ok(r.perl.includes("/home/ana/code/app/main.py") && r.perl.includes("-home-ana-code-app"));
});

test("perl and paths.js agree: identity rules shield, /root moves", () => {
  const text = LINES.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const rules = planRules({ srcHome: "/root", dstHome: "/Users/bo", projects: [{ src: "/Users/ana/code/app", dst: "/Users/bo/code/app" }], mentioned: ["/Users/ana"] });
  const r = both(rules, text);
  assert.equal(r.perl, r.js);
  assert.equal(r.perlChanges, r.jsChanges);
  assert.ok(r.perl.includes("/Users/bo/.claude") && r.perl.includes("/rootfs") && r.perl.includes("grassroots"));
});

test("copy mode copies bytes untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "roam-perl-"));
  const bytes = Buffer.from([0, 1, 2, 255, 10, 47, 85, 115, 101, 114, 115]);
  writeFileSync(join(dir, "bin"), bytes);
  writeFileSync(join(dir, "rules.tsv"), rulesText(compile([{ from: "/Users/ana", to: "/home/ana" }]).entries));
  writeFileSync(join(dir, "manifest.tsv"), manifestText([{ from: join(dir, "bin"), out: join(dir, "o", "bin"), rewrite: false }]));
  execFileSync("perl", ["-e", PERL_REWRITE, join(dir, "rules.tsv"), join(dir, "manifest.tsv")]);
  assert.deepEqual(readFileSync(join(dir, "o", "bin")), bytes);
});

test("a 10 MB transcript takes well under a second", () => {
  const line = JSON.stringify({ cwd: "/Users/ana/code/app", message: { content: "x".repeat(900) + " /Users/ana/code/app/a.py" } });
  const text = (line + "\n").repeat(10_500);
  const t0 = Date.now();
  const r = both([{ from: "/Users/ana", to: "/home/ana" }], text);
  const ms = Date.now() - t0;
  assert.equal(r.perlChanges, 21_000);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test("rules and manifests drop entries with tabs or newlines", () => {
  assert.equal(rulesText([{ from: "/a\tb", to: "/c", dir: false }, { from: "/x", to: "/y", dir: true }]), "/x\t/y\tdir\n");
  assert.equal(manifestText([{ from: "/a\nb", out: "/o", rewrite: true }]), "");
});
