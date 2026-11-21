// Moving a space, step by step.
//
// Processes can't be frozen and carried across machines (CRIU is Linux-only,
// and nothing like it exists for macOS), but an agent's state is already on
// disk: its transcript. So roam does what live migration does, one level up:
//
//   check     the target can start terminals, has the agent, has the folders
//   finish    each agent finishes its turn (nothing is cut off mid-edit)
//   pause     each agent exits cleanly, so its transcript is complete
//   files     project folders match on both machines (synced, or copied)
//   sessions  transcripts, subagents, memory and /rewind history are copied,
//             with paths rewritten for the target
//   start     the same tabs and panes open there, agents resumed by id
//   verify    each agent is up there (a folder trust prompt is answered)
//   retire    the source space closes, its transcripts are put away
//
// Anything that fails after "pause" is rolled back: what started on the
// target is stopped, the files written there are taken back, and the agents
// resume where they were. The journal is written at every step with what a
// rollback needs, so a move cut off outright (the dialog closed, Herdr quit)
// can still be rolled back: by the dialog as it closes, or from its banner
// the next time it opens.

import { spaces, panes, machines, run, hc, exec, appHome, readTextFile, setShared } from "herdr";
import * as fs from "fs/promises";
import { describe, sh, hcj, onArgs, sleep, isShell, inShell, shellWithNote, hex, why } from "./machine.js";
import { compile, planRules, homeOf } from "./paths.js";
import { pull, push, unpush, dropBackups, wipe } from "./transport.js";
import { PERL_REWRITE, rulesText, manifestText } from "./rewrite-perl.js";
import { compare, exists, sizeKb, SKIP } from "./projects.js";
import * as claude from "./claude.js";
import * as agy from "./agy.js";

/** Agents roam can move. Add an adapter here to support another one. */
export const ADAPTERS = [claude, agy];

// "1.1.3" is a release line behind "1.5.14"; "2.1.323" isn't behind "2.1.330".
function behind(a, b) {
  const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
  return x[0] < y[0] || (x[0] === y[0] && (x[1] || 0) < (y[1] || 0));
}
const adapterById = (id) => ADAPTERS.find((a) => a.id === id);

export const STEPS = [
  ["check", "Check the target"],
  ["finish", "Let agents finish their turn"],
  ["pause", "Pause agents"],
  ["files", "Match project files"],
  ["sessions", "Move sessions"],
  ["start", "Start on the target"],
  ["verify", "Wait for agents"],
  ["retire", "Close the old space"],
];

const DEFAULTS = { rules: [], syncWaitSeconds: 90, carryTrust: true, copyMissingProjects: true };

/** The person's settings: ~/.config/herdr-app/roam.json (all optional). */
export async function settings() {
  const raw = await readTextFile(`${appHome()}/roam.json`).catch(() => null);
  try {
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS, invalid: true };
  }
}

export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtSecs = (ms) => (ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const dirOf = (p) => p.slice(0, p.lastIndexOf("/"));
const tilde = (p, home) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

/** Whether machine `on` can start a terminal now (tried twice: the first try can fail on a fresh connection). */
async function canStart(on) {
  let last = null;
  for (let i = 0; i < 2; i++) {
    const r = await hc(["run", ...onArgs(on), "--rm", "--no-parent", "--", "true"]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    if (r.code === 0) return { ok: true };
    last = null;
    for (const out of [r.stderr, r.stdout]) {
      try {
        last = last ?? JSON.parse(out).error?.message ?? null;
      } catch {
        // not JSON
      }
    }
    last = last ?? (r.stderr || r.stdout || "").trim();
    await sleep(1500);
  }
  return { ok: false, why: last || "it didn't answer" };
}

/**
 * What moving `spaceId` to `target` (a machine name, or null for this
 * computer) would do: every pane, every session, every folder, every path
 * rule, and what would stop it. Changes nothing.
 */
export async function plan(spaceId, target) {
  const space = spaces().find((s) => s.id === spaceId);
  if (!space) throw new Error("That space is gone.");
  const p = {
    tx: hex(12),
    space: { id: space.id, name: space.name, named: space.named, machine: space.machine ?? null, tabs: space.tabs.map((t) => ({ id: t.id, name: t.name, named: t.named })) },
    settings: await settings(),
    panes: [],
    projects: [],
    rules: [],
    warnings: [],
    blockers: [],
    bytes: 0,
  };
  const srcName = space.machine ?? null;
  const dstName = target ?? null;
  if (srcName === dstName) {
    p.blockers.push("The space is already there.");
    return p;
  }
  if (p.settings.invalid) p.warnings.push("roam.json isn't valid JSON, so roam uses its defaults.");

  const [src, dst] = await Promise.all([describe(srcName), describe(dstName)]);
  p.src = src;
  p.dst = dst;
  const machine = machines().find((m) => (m.name ?? null) === dstName);
  if (dstName && machine?.layout === "unavailable") p.blockers.push(`${dst.label} isn't connected.`);
  const start = await canStart(dstName);
  if (!start.ok) p.blockers.push(`${dst.label} can't start terminals right now: ${start.why}`);

  // Every pane in the space, in tab order.
  const tabIds = space.tabs.map((t) => t.id);
  const order = (x) => tabIds.indexOf(x.tab);
  const list = panes().filter((x) => x.terminal && tabIds.includes(x.tab)).sort((a, b) => order(a) - order(b));
  for (const pane of list) {
    const t = await hcj(["get", pane.terminal]).catch((e) => ({ error: e.message }));
    if (t.error) {
      p.blockers.push(`${pane.terminal}: ${t.error}`);
      continue;
    }
    const adapter = ADAPTERS.find((a) => a.detects(t));
    const argv = t.foreground?.argv ?? [];
    const x = {
      address: pane.terminal,
      tab: pane.tab,
      title: pane.title,
      program: pane.program,
      cwd: t.foreground?.cwd ?? pane.cwd ?? t.cwd,
      argv,
      kind: adapter ? "agent" : isShell(argv[0]) ? "shell" : "program",
      adapter: adapter?.id ?? null,
      t,
      agentName: adapter?.name ?? null,
    };
    if (adapter) {
      try {
        x.session = await adapter.inspect(src, t);
        x.cwd = x.session.cwd;
        p.bytes += x.session.bytes;
      } catch (e) {
        p.blockers.push(`${pane.terminal}: ${e.message}`);
      }
    } else if (t.status?.app) {
      p.warnings.push(`${pane.terminal} runs ${t.status.app}, which roam can't move yet: it opens as a shell there.`);
    } else if (x.kind === "program") {
      p.warnings.push(`${pane.terminal} runs \`${argv.join(" ")}\`. It stops here, and there it opens a shell that shows the command.`);
    }
    p.panes.push(x);
  }
  if (!p.panes.length) p.blockers.push("This space has no terminals to move.");

  // Where each folder is on the target: the same path, or the same place in its home.
  const extra = compile(p.settings.rules ?? []);
  for (const cwd of [...new Set(p.panes.map((x) => x.cwd).filter(Boolean))]) {
    const mine = extra.path(cwd);
    const home = homeOf(cwd);
    let dstCwd;
    let how;
    if (mine !== cwd) [dstCwd, how] = [mine, "your rule"];
    else if (await exists(dstName, cwd)) [dstCwd, how] = [cwd, "same path"];
    else if (home && (await exists(dstName, dst.home + cwd.slice(home.length)))) [dstCwd, how] = [dst.home + cwd.slice(home.length), "same place in the home folder"];
    else [dstCwd, how] = [home ? dst.home + cwd.slice(home.length) : cwd, "missing"];
    const isHome = cwd === src.home || cwd === home || cwd === "/";
    const c = isHome ? { state: "home" } : await compare(srcName, cwd, dstName, dstCwd).catch((e) => ({ state: "unknown", why: e.message }));
    const pr = { src: cwd, dst: dstCwd, how, state: c.state };
    if (c.state === "missing") {
      if (p.settings.copyMissingProjects) {
        pr.kb = await sizeKb(srcName, cwd);
        p.warnings.push(`${tilde(dstCwd, dst.home)} isn't on ${dst.label}: roam copies it (${fmtBytes(pr.kb * 1024)}, without ${SKIP.slice(0, 3).join(", ")}…).`);
      } else p.blockers.push(`${tilde(dstCwd, dst.home)} isn't on ${dst.label}.`);
    } else if (c.state === "differs") {
      p.warnings.push(`${tilde(dstCwd, dst.home)} differs on ${dst.label} right now. roam waits up to ${p.settings.syncWaitSeconds} s for your sync before it continues.`);
    } else if (c.state === "unknown") {
      p.warnings.push(`${tilde(dstCwd, dst.home)} is too big to compare: roam assumes your sync has it.`);
    }
    p.projects.push(pr);
  }

  // Path rules, then each pane's command on the target.
  const mentioned = [...new Set(p.panes.flatMap((x) => x.session?.mentioned ?? []))];
  p.rules = planRules({ srcHome: src.home, dstHome: dst.home, projects: p.projects, extra: p.settings.rules ?? [], mentioned });
  const rw = compile(p.rules);
  for (const x of p.panes) {
    x.dstCwd = rw.path(x.cwd ?? src.home);
    if (x.kind === "agent" && x.session) {
      const a = adapterById(x.adapter);
      x.dests = a.destinations(x.session, rw, dst, x.dstCwd);
      x.dstArgv = inShell(dst.shell, a.resumeArgv(x.session, rw));
    } else if (x.kind === "program") {
      x.dstArgv = shellWithNote(dst.shell, `roam: on ${src.label} this pane was running: ${x.argv.join(" ")}`);
    }
  }

  // The agents themselves, on the target: installed, recent enough, same account.
  const agents = p.panes.filter((x) => x.kind === "agent" && x.session);
  for (const aid of [...new Set(agents.map((x) => x.adapter))]) {
    const a = adapterById(aid);
    const [there, here, acct] = await Promise.all([a.installed(dst), a.installed(src), a.account ? a.account(dst) : null]);
    if (!there) p.blockers.push(`${a.name} isn't on ${dst.label} (not on its login shell's PATH).`);
    else if (here && behind(there, here)) p.warnings.push(`${a.name} on ${dst.label} is ${there}, older than ${here} here: it may not read this session. Update it there first.`);
    for (const x of agents.filter((y) => y.adapter === aid)) {
      if (x.session.account && acct && x.session.account !== acct)
        p.warnings.push(`${dst.label} is signed in to a different ${a.name} account than ${x.address}'s session. It may not open there.`);
      for (const n of a.notes?.(x.session, { src, dst, dstCwd: x.dstCwd }) ?? []) p.warnings.push(`${x.address}: ${n}`);
    }
  }
  const freeKb = Number((await sh(dstName, 'df -Pk "$HOME" | awk \'NR==2 { print $4 }\'').catch(() => "0")).trim()) || 0;
  const needKb = p.bytes / 1024 + p.projects.reduce((n, x) => n + (x.state === "missing" ? x.kb ?? 0 : 0), 0);
  if (freeKb && freeKb < needKb * 2 + 200 * 1024) p.blockers.push(`${dst.label} is nearly out of disk space (${fmtBytes(freeKb * 1024)} free).`);
  if (!(await perl()) && p.bytes > 4 * 1048576)
    p.warnings.push(`perl isn't on this computer, so roam rewrites ${fmtBytes(p.bytes)} of sessions itself. Herdr may stop responding for a while during that step.`);
  return p;
}

let perlHere = null;
/** Whether this computer has perl (macOS and common Linux distributions ship it). */
async function perl() {
  if (perlHere === null) perlHere = await exec("perl", ["-e", "1"]).then((r) => r.code === 0, () => false);
  return perlHere;
}

/**
 * Rewrites (or copies) staged files: with perl in its own process when there
 * is one, else in the mod, which blocks Herdr while it runs. Returns how many
 * paths changed.
 */
async function rewriteFiles(items, rw, stage) {
  if (await perl()) {
    await fs.writeFile(`${stage}/rules.tsv`, rulesText(rw.entries));
    await fs.writeFile(`${stage}/manifest.tsv`, manifestText(items));
    const r = await exec("perl", ["-e", PERL_REWRITE, `${stage}/rules.tsv`, `${stage}/manifest.tsv`], { timeout: 600000 });
    if (r.code !== 0) throw new Error(why(r, "perl couldn't rewrite the session files"));
    return Number(r.stdout.trim()) || 0;
  }
  for (const x of items) {
    await fs.mkdir(dirOf(x.out), { recursive: true });
    await fs.writeFile(x.out, x.rewrite ? rw.file(x.path, await fs.readFile(x.from, "utf8")) : await fs.readFile(x.from));
  }
  return rw.changes;
}

/** Waits until agent `x` isn't mid-turn; reports what it waits for. */
async function settle(x, report, cancelled) {
  for (;;) {
    if (cancelled()) throw new Cancelled();
    const t = await hcj(["get", x.address]);
    const st = t.status?.state;
    if (st === "working") {
      report(`${x.address} is finishing its turn…`);
      await hc(["wait", x.address, "--timeout", "10"]).catch(() => null);
      continue;
    }
    if (st === "blocked") {
      report(`${x.address} is waiting for you${t.status?.msg ? `: ${t.status.msg}` : ""}`);
      await sleep(1500);
      continue;
    }
    x.t = t;
    return;
  }
}

/** Waits until `ok()` is true, up to `ms`. */
async function until(ok, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await sleep(250);
  }
  return ok();
}

/**
 * Moves the space as planned. `ui.step(key, state, detail)` hears every step
 * ("run", "done", "fail", "skip"); `ui.cancelled()` may stop it until agents
 * pause. Resolves with { ok, error?, rolledBack?, downtime, total, space }.
 */
export async function move(p, ui) {
  const t0 = Date.now();
  const stage = `${appHome()}/.roam/${p.tx}`;
  const rw = compile(p.rules);
  const agents = p.panes.filter((x) => x.kind === "agent");
  const did = { stopped: [], wrote: [], started: [] };
  const log = [];
  const say = (m) => log.push(`${new Date().toISOString()}  ${m}`);
  let current = "check";
  let pausedAt = null;
  // What a rollback needs, kept current and in the journal at every step.
  const live = { tx: p.tx, phase: "check", src: p.src.name, dst: p.dst.name, agents: [], started: [], wrote: [], done: false };
  ui.track?.(live);
  const save = () => journal(stage, p, log, { running: true, phase: current }, live).catch(() => null);
  const step = (key, state, detail = "") => {
    current = key;
    live.phase = key;
    say(`${key} ${state} ${detail}`);
    ui.step(key, state, detail);
  };
  setShared("roam.moving", null); // older versions kept a lock here

  try {
    step("check", "run");
    const start = await canStart(p.dst.name);
    if (!start.ok) throw new Error(`${p.dst.label} can't start terminals right now: ${start.why}`);
    for (const x of p.panes) await hc(["label", x.address, `roam.moving=${p.tx}`]).catch(() => null);
    step("check", "done", `${p.dst.label} is ready`);

    step("finish", "run");
    // Let the person's sync catch up while agents still work: once they
    // pause, only their last turn's changes are left to wait for.
    for (const pr of p.projects) await matchFolder(p, pr, stage, (d) => step("finish", "run", d), { copy: false, cancelled: ui.cancelled });
    for (const x of agents) await settle(x, (d) => step("finish", "run", d), ui.cancelled);
    step("finish", agents.length ? "done" : "skip", agents.length ? `${agents.length === 1 ? "the agent is" : `${agents.length} agents are`} idle` : "no agents here");

    step("pause", "run");
    pausedAt = Date.now();
    for (const x of agents) {
      await settle(x, (d) => step("pause", "run", d), () => false);
      step("pause", "run", `stopping ${x.address}…`);
      const a = adapterById(x.adapter);
      live.agents.push({
        address: x.address,
        id: x.session.id,
        line: a.resumeLine(x.session),
        argv: inShell(p.src.shell, a.resumeArgv(x.session, compile([]))),
        cwd: x.cwd,
        space: x.t?.labels?.["herdr.space"] ?? null,
        tab: x.t?.labels?.["herdr.tab"] ?? null,
      });
      await save(); // before it stops: a cut-off move must know to bring it back
      await a.stop(p.src, x.t, x.session);
      live.agents[live.agents.length - 1].stopped = true;
      did.stopped.push(x);
      await save();
    }
    step("pause", agents.length ? "done" : "skip", agents.length ? "transcripts are complete" : "");

    step("files", "run");
    for (const pr of p.projects) await matchFolder(p, pr, stage, (d) => step("files", "run", d));
    step("files", "done", p.projects.filter((x) => x.state !== "home").length ? "they match" : "nothing to check");

    step("sessions", "run");
    let bytes = 0;
    const all = [];
    for (const x of agents) {
      const a = adapterById(x.adapter);
      x.session.files = await a.files(p.src, x.session);
      x.dests = a.destinations(x.session, rw, p.dst, x.dstCwd);
      all.push(...x.dests);
    }
    let changes = 0;
    if (all.length) {
      bytes = all.reduce((n, d) => n + d.size, 0);
      step("sessions", "run", `copying ${all.length} files (${fmtBytes(bytes)})…`);
      const part = (what) => (i, n) => n > 1 && i < n && step("sessions", "run", `${what} (${i + 1} of ${n})…`);
      await pull(p.src.name, all.map((d) => d.path), `${stage}/src`, [], { progress: part(`copying ${all.length} files (${fmtBytes(bytes)})`) });
      step("sessions", "run", `rewriting paths in ${fmtBytes(bytes)}…`);
      changes = await rewriteFiles(
        all.map((d) => ({ from: `${stage}/src${d.path}`, out: `${stage}/out/${d.mode}${d.to}`, rewrite: d.rewrite, path: d.path })),
        rw,
        stage,
      );
      step("sessions", "run", `sending them to ${p.dst.label}…`);
      const res = await push(p.dst.name, `${stage}/out`, p.tx, { progress: part(`sending them to ${p.dst.label}`) });
      did.wrote = res.wrote;
      live.wrote = res.wrote;
      await save();
      if (res.kept.length) say(`kept the target's own copy of ${res.kept.join(", ")}`);
    }
    step("sessions", all.length ? "done" : "skip", all.length ? `${all.length} files · ${fmtBytes(bytes)} · ${changes} paths rewritten` : "no sessions");

    step("start", "run");
    const sp = "sp" + hex(32);
    const prefix = p.dst.name ? `${p.dst.name}/` : "";
    const newSpace = prefix + sp;
    for (const tab of p.space.tabs) {
      const tb = "tb" + hex(32);
      tab.dstId = prefix + tb;
      for (const x of p.panes.filter((y) => y.tab === tab.id)) {
        const args = ["run", ...onArgs(p.dst.name), "--bg", "--keep", "--no-parent", "--cwd", x.dstCwd, "--label", `herdr.space=${sp}`, "--label", `herdr.tab=${tb}`, "--label", `roam.from=${p.tx}`];
        if (x.dstArgv) args.push("--", ...x.dstArgv);
        const r = await hcj(args);
        x.dstAddress = r.address;
        did.started.push(r.address);
        live.started.push(r.address);
        await save();
        step("start", "run", `${x.address} → ${r.address}`);
      }
    }
    await until(() => spaces().some((s) => s.id === newSpace), 8000);
    if (p.space.named) safeRun("space.rename", { id: newSpace, name: p.space.name });
    for (const tab of p.space.tabs) if (tab.named) safeRun("tab.rename", { id: tab.dstId, name: tab.name });
    step("start", "done", `${did.started.length} ${did.started.length === 1 ? "pane" : "panes"} on ${p.dst.label}`);

    step("verify", "run");
    for (const x of agents) {
      await adapterById(x.adapter).ready(x.dstAddress, { trust: p.settings.carryTrust, report: (d) => step("verify", "run", `${x.dstAddress}: ${d}`) });
    }
    const downtime = pausedAt ? Date.now() - pausedAt : 0;
    step("verify", agents.length ? "done" : "skip", agents.length ? `back in ${fmtSecs(downtime)}` : "");

    step("retire", "run");
    const sameFile = (a, b) => p.src.home === p.dst.home && a === b;
    for (const x of agents) await adapterById(x.adapter).archive(p.src, x.session, x.dests, sameFile).catch((e) => say(`archive: ${e.message}`));
    // Agents run there now: the target's backups were only for rollback.
    await dropBackups(p.dst.name, did.wrote, p.tx);
    const result = { ok: true, total: Date.now() - t0, downtime, space: newSpace };
    live.done = true;
    await journal(stage, p, log, result, live);
    await wipe(`${stage}/src`);
    await wipe(`${stage}/out`);
    await fs.unlink(`${stage}/rules.tsv`).catch(() => null);
    await fs.unlink(`${stage}/manifest.tsv`).catch(() => null);
    safeRun("space.select", { id: newSpace });
    step("retire", "done", "the old space is closed");
    // Closing the old space can close this dialog with it, so everything
    // that needs saying is said first.
    ui.finished?.(result);
    safeRun("space.close", { id: p.space.id, confirmed: true });
    return result;
  } catch (e) {
    const cancelled = e instanceof Cancelled;
    step(current, "fail", cancelled ? "cancelled" : e.message);
    let rolledBack = false;
    if (did.stopped.length || did.started.length) {
      rolledBack = true;
      say("rolling back");
      for (const addr of did.started) await hc(["kill", addr]).catch(() => null);
      // An agent that started there despite an error (the session id is unique).
      for (const x of did.stopped) await sh(p.dst.name, 'pkill -f -- "$1" 2>/dev/null; true', [x.session.id]).catch(() => null);
      await unpush(p.dst.name, did.wrote, p.tx);
      for (const x of did.stopped) await resumeHere(p, x).catch((err) => say(`resume ${x.address}: ${err.message}`));
    }
    for (const x of p.panes) await hc(["label", x.address, "roam.moving="]).catch(() => null);
    live.done = true;
    await journal(stage, p, log, { ok: false, error: e.message, rolledBack }, live).catch(() => null);
    // Session copies can hold secrets: keep only the journal.
    await wipe(`${stage}/src`);
    await wipe(`${stage}/out`);
    await wipe(`${stage}/project`);
    await wipe(`${stage}/projout`);
    await fs.unlink(`${stage}/rules.tsv`).catch(() => null);
    await fs.unlink(`${stage}/manifest.tsv`).catch(() => null);
    return { ok: false, cancelled, error: e.message, rolledBack, total: Date.now() - t0, journal: `${stage}/journal.json` };
  }
}

function safeRun(name, args) {
  try {
    run(name, args);
  } catch {
    // Cosmetic steps (names, focus) never fail a move.
  }
}

/**
 * Makes a project folder match on the target: waits for the person's sync,
 * or copies a missing one. With `copy: false` (before agents pause) it only
 * waits, and a missing folder is left for after the pause.
 */
async function matchFolder(p, pr, stage, report, { copy = true, cancelled = () => false } = {}) {
  if (pr.state === "home") return;
  const deadline = Date.now() + p.settings.syncWaitSeconds * 1000;
  const short = tilde(pr.dst, p.dst.home);
  let copied = false;
  for (;;) {
    if (cancelled()) throw new Cancelled();
    const c = await compare(p.src.name, pr.src, p.dst.name, pr.dst).catch((e) => ({ state: "unknown", why: e.message }));
    if (c.state === "same") return report(`${short} matches`);
    if (c.state === "unknown") return report(`${short} is too big to compare`);
    if (c.state === "missing" && !copy) return;
    if (c.state === "missing" && !copied) {
      if (!p.settings.copyMissingProjects) throw new Error(`${short} isn't on ${p.dst.label}.`);
      report(`copying ${tilde(pr.src, p.src.home)} to ${p.dst.label}…`);
      await copyFolder(p, pr, stage, (i, n) => n > 1 && i < n && report(`copying ${tilde(pr.src, p.src.home)} to ${p.dst.label} (${i + 1} of ${n})…`));
      copied = true;
      continue;
    }
    if (Date.now() > deadline) throw new Error(`${short} on ${p.dst.label} still differs after ${p.settings.syncWaitSeconds} s. Let your sync catch up, then move again.`);
    report(`waiting for ${short} to sync (${Math.ceil((deadline - Date.now()) / 1000)} s)…`);
    await sleep(2000);
  }
}

/** Copies a project folder that isn't on the target, without dependency and build folders. */
async function copyFolder(p, pr, stage, progress) {
  const raw = `${stage}/project`;
  await pull(p.src.name, [pr.src], raw, SKIP, { progress });
  // Same contents, under the target path.
  await sh(null, 'mkdir -p "$2" && mkdir -p "$(dirname "$2$3")" && mv "$1$4" "$2$3"', [raw, `${stage}/projout/put`, pr.dst, pr.src]);
  await push(p.dst.name, `${stage}/projout`, p.tx, { mode: "keep", progress });
  await wipe(raw);
  await wipe(`${stage}/projout`);
}

/** Brings a paused agent back where it was (rollback). */
async function resumeHere(p, x) {
  const a = adapterById(x.adapter);
  const t = await hcj(["get", x.address], { ok: true }).catch(() => null);
  if (t?.state === "live" && isShell(t.foreground?.argv?.[0])) {
    // Its pane is a shell again: type the resume command there.
    await hc(["send", x.address, a.resumeLine(x.session)]);
    return;
  }
  const labels = x.t?.labels ?? {};
  await hcj([
    "run", ...onArgs(p.src.name), "--bg", "--keep", "--no-parent", "--cwd", x.cwd,
    "--label", `herdr.space=${labels["herdr.space"]}`, "--label", `herdr.tab=${labels["herdr.tab"]}`,
    "--", ...inShell(p.src.shell, a.resumeArgv(x.session, compile([]))),
  ]);
}

/**
 * Writes what happened to ~/.config/herdr-app/.roam/<tx>/journal.json. While
 * a move runs, `result.running` is true and `recovery` says how to undo it.
 */
async function journal(stage, p, log, result, live) {
  await fs.mkdir(stage, { recursive: true });
  const body = {
    tx: p.tx,
    at: new Date().toISOString(),
    from: p.src?.label,
    to: p.dst?.label,
    space: p.space.name,
    result,
    rules: p.rules,
    panes: p.panes.map((x) => ({ from: x.address, to: x.dstAddress ?? null, kind: x.kind, session: x.session?.id ?? null, cwd: x.cwd, dstCwd: x.dstCwd })),
    recovery: live ? { src: live.src, dst: live.dst, phase: live.phase, agents: live.agents, started: live.started, wrote: live.wrote } : null,
    log,
  };
  await fs.writeFile(`${stage}/journal.json`, JSON.stringify(body, null, 2));
}

/**
 * Moves that were cut off (the dialog closed, Herdr quit) before they
 * finished or rolled back: their journals still say `running`.
 */
export async function interrupted() {
  const root = `${appHome()}/.roam`;
  const found = [];
  const dirs = await fs.readdir(root).catch(() => []);
  for (const d of dirs) {
    const raw = await fs.readFile(`${root}/${d}/journal.json`, "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      if (j.result?.running && j.recovery && (j.recovery.agents.length || j.recovery.started.length))
        found.push({ tx: j.tx, path: `${root}/${d}/journal.json`, space: j.space, from: j.from, to: j.to, phase: j.recovery.phase, agents: j.recovery.agents.length, at: j.at });
    } catch {
      // not a journal
    }
  }
  return found;
}

/** Whether terminal `addr` runs an agent right now (not a shell). */
async function agentRunning(addr) {
  const t = await hcj(["get", addr], { ok: true }).catch(() => null);
  if (!t || t.state !== "live") return { live: false };
  const fg = t.foreground?.argv?.[0];
  return { live: true, shell: isShell(fg), t };
}

/**
 * Undoes a cut-off move from its journal: stops what it started on the
 * target, takes back the files it wrote there, and brings each paused agent
 * back on the source. Safe to run twice: an agent already running is left alone.
 */
export async function recover(path) {
  const j = JSON.parse(await fs.readFile(path, "utf8"));
  const r = j.recovery;
  if (!r) return { resumed: 0 };
  for (const addr of r.started) await hc(["kill", addr]).catch(() => null);
  for (const a of r.agents) await sh(r.dst, 'pkill -f -- "$1" 2>/dev/null; true', [a.id]).catch(() => null);
  await unpush(r.dst, r.wrote, j.tx);
  let resumed = 0;
  for (const a of r.agents) {
    const here = await agentRunning(a.address);
    if (here.live && !here.shell) continue; // it never stopped, or it's back already
    if (here.live) await hc(["send", a.address, a.line]).catch(() => null);
    else
      await hcj([
        "run", ...onArgs(r.src), "--bg", "--keep", "--no-parent", "--cwd", a.cwd,
        ...(a.space ? ["--label", `herdr.space=${a.space}`] : []), ...(a.tab ? ["--label", `herdr.tab=${a.tab}`] : []),
        "--", ...a.argv,
      ]).catch(() => null);
    await hc(["label", a.address, "roam.moving="]).catch(() => null);
    resumed++;
  }
  j.result = { ok: false, recovered: true, error: `cut off while ${r.phase}; rolled back afterwards` };
  await fs.writeFile(path, JSON.stringify(j, null, 2));
  await wipe(path.replace(/\/journal\.json$/, "/src"));
  await wipe(path.replace(/\/journal\.json$/, "/out"));
  return { resumed };
}

/**
 * Last words of a dialog closing mid-move: it has no time to wait, so it
 * starts the rollback and leaves. Once the old space is being closed, the
 * move has happened and nothing is undone. The banner finishes the rest.
 */
export function abandon(live) {
  if (!live || live.done || live.phase === "retire") return;
  for (const addr of live.started) hc(["kill", addr]).catch(() => null);
  // Only agents that really stopped: typing this into a running one would send it as a message.
  for (const a of live.agents) if (a.stopped) hc(["send", a.address, a.line]).catch(() => null);
}
