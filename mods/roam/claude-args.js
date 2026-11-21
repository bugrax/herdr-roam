// Claude Code's command line, rebuilt to resume a session somewhere else.
//
// The running Claude was started with flags worth keeping (its model, its
// permission mode, the tools it may use) and some that must go (the session
// it resumed, the first prompt, which is already in the transcript). Path
// flags are mapped to the target machine.
//
// Pure functions, no herdr imports: Node unit-tests this file directly.

// The session it was opened with: replaced by --resume <id>.
const DROP_WITH_VALUE = new Set(["--resume", "-r", "--session-id", "--from-pr"]);
const DROP = new Set(["--continue", "-c", "--fork-session", "--print", "-p"]);

// Flags followed by several values.
const VARIADIC = new Set([
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--add-dir", "--mcp-config", "--plugin-dir", "--betas", "--tools",
]);

// Flags followed by one value.
const VALUE = new Set([
  "--model", "--permission-mode", "--settings", "--setting-sources", "--append-system-prompt",
  "--system-prompt", "--append-system-prompt-file", "--system-prompt-file", "--agent", "--agents",
  "--effort", "--fallback-model", "--name", "-n", "--max-turns", "--permission-prompt-tool",
  "--debug-file", "--output-style",
]);

// Flags without a value.
const BOOL = new Set([
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--verbose", "--debug",
  "-d", "--ide", "--strict-mcp-config", "--chrome", "--no-chrome", "--remote-control",
  "--disable-slash-commands", "--bare",
]);

// Flags whose values are paths on the machine Claude runs on.
const PATHS = new Set([
  "--add-dir", "--mcp-config", "--plugin-dir", "--settings", "--append-system-prompt-file",
  "--system-prompt-file", "--debug-file",
]);

// A tool pattern such as `Bash(git log:*)` has spaces but is one value.
const isToolPattern = (s) => /^[A-Za-z_][\w-]*\(.*\)$/.test(s);

/**
 * The argv that resumes `sessionId` with the original flags.
 * `argv` is the running Claude's own (argv[0] is the program).
 * `mapPath` maps a path on the source to the target.
 */
export function resumeArgv(argv, sessionId, mapPath = (p) => p) {
  const a = (argv ?? []).slice(1);
  const out = [];
  const map = (flag, v) => (PATHS.has(flag) && v.startsWith("/") ? mapPath(v) : v);
  const isValue = (i) => i < a.length && !a[i].startsWith("-");

  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    // A word on its own is the first prompt: it's in the transcript already.
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
    if (VARIADIC.has(flag)) {
      out.push(flag);
      while (isValue(i + 1) && (!/\s/.test(a[i + 1]) || isToolPattern(a[i + 1]))) out.push(map(flag, a[++i]));
      continue;
    }
    if (VALUE.has(flag)) {
      out.push(flag);
      if (isValue(i + 1)) out.push(map(flag, a[++i]));
      continue;
    }
    out.push(flag);
    if (BOOL.has(flag)) continue;
    // Unknown flag: a following single word is its value; a sentence is the prompt.
    if (isValue(i + 1) && !/\s/.test(a[i + 1])) out.push(a[++i]);
  }
  return ["claude", "--resume", sessionId, ...out];
}

/** The session a command line names (`--resume <id>`, `--session-id <id>`), or null. */
export function sessionFromArgv(argv) {
  const a = argv ?? [];
  for (let i = 0; i < a.length; i++) {
    const [flag, inline] = a[i].includes("=") ? a[i].split(/=(.*)/s) : [a[i], null];
    if (["--resume", "-r", "--session-id"].includes(flag)) {
      const v = inline ?? a[i + 1];
      if (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
    }
  }
  return null;
}

/** Whether argv[0] is Claude Code (`claude`, `/path/to/claude`). */
export function isClaude(argv0) {
  return /(^|\/)claude$/.test(String(argv0 ?? ""));
}
