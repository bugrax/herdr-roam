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
