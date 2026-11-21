// The few parts of Herdr's mod API that transport.js and machine.js use,
// backed by child_process. `hc` on PATH is test/support/bin/hc.
import { spawnSync } from "node:child_process";

export async function exec(program, args = [], { timeout } = {}) {
  const r = spawnSync(program, args, { encoding: "utf8", maxBuffer: 1 << 30, timeout });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export async function hc() {
  throw new Error("hc() isn't available in tests");
}

// The rest of what the engine imports: enough to load it, not to run a move.
export const spaces = () => [];
export const panes = () => [];
export const machines = () => [];
export const run = () => {};
export const appHome = () => "/nonexistent/herdr-app";
export const setShared = () => {};
export async function readTextFile() {
  throw new Error("readTextFile() isn't available in tests");
}
