// Antigravity CLI's (agy) command line, rebuilt to resume a conversation
// somewhere else: keep the model, mode and agent; drop the conversation it
// was opened with and any first prompt; map path flags.
//
// Pure functions, no herdr imports: Node unit-tests this file directly.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Replaced by --conversation <id>, or one-shot options that don't apply to a resumed session.
const DROP_WITH_VALUE = new Set([
  "--conversation", "--print", "-p", "--prompt", "--prompt-interactive", "-i",
  "--input-format", "--output-format", "--json-schema", "--print-timeout",
]);
const DROP = new Set(["--continue", "-c", "--new-project"]);
const VALUE = new Set(["--model", "--mode", "--effort", "--agent", "--project", "--settings", "--add-dir", "--log-file"]);
const BOOL = new Set(["--dangerously-skip-permissions", "--disable-slash-commands", "--remote-agent", "--remote-control", "--sandbox"]);
const PATHS = new Set(["--add-dir", "--settings", "--log-file"]);

/** The argv that resumes conversation `id` with the original flags. */
export function agyResumeArgv(argv, id, mapPath = (p) => p) {
  const a = (argv ?? []).slice(1);
  const out = [];
  const map = (flag, v) => (PATHS.has(flag) && v.startsWith("/") ? mapPath(v) : v);
  const isValue = (i) => i < a.length && !a[i].startsWith("-");
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (!tok.startsWith("-") || tok === "-") continue;
    const eq = tok.indexOf("=");
    const flag = eq > 0 ? tok.slice(0, eq) : tok;
    if (DROP_WITH_VALUE.has(flag)) {
      if (eq < 0 && isValue(i + 1)) i++;
      continue;
    }
    if (DROP.has(flag)) continue;
    if (eq > 0) {
      out.push(`${flag}=${map(flag, tok.slice(eq + 1))}`);
      continue;
    }
    out.push(flag);
    if (BOOL.has(flag)) continue;
    if (VALUE.has(flag) ? isValue(i + 1) : isValue(i + 1) && !/\s/.test(a[i + 1])) out.push(map(flag, a[++i]));
  }
  return ["agy", "--conversation", id, ...out];
}

/** The conversation a command line names (`--conversation <id>`), or null. */
export function conversationFromArgv(argv) {
  const a = argv ?? [];
  for (let i = 0; i < a.length; i++) {
    const [flag, inline] = a[i].includes("=") ? a[i].split(/=(.*)/s) : [a[i], null];
    if (flag === "--conversation") {
      const v = inline ?? a[i + 1];
      if (v && UUID.test(v)) return v;
    }
  }
  return null;
}

/** Whether argv[0] is agy. */
export function isAgy(argv0) {
  return /(^|\/)agy$/.test(String(argv0 ?? ""));
}

/** "1.5.14" < "1.5.6"? Compares dotted versions numerically. */
export function olderVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}
