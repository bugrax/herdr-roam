// A made-up move for screenshots and the herdr.dev preview: Ana moves her
// "checkout-api" space from her laptop to a Linux box. Nothing here touches
// a machine; `herdr-app do roam.preview-<view>` shows it in an open dialog
// (pick, planning, review, play, done, failed).

const HOME = "/Users/ana";
const THERE = "/home/ana";
const REPO = "/code/checkout-api";

const session = (id, mb) => ({ agent: "claude-code", id, bytes: Math.round(mb * 1048576), files: [], mentioned: [] });

export function samplePlan(claudeProgram) {
  const program = claudeProgram ?? null;
  const pane = (address, title, kind, extra = {}) => ({
    address,
    title,
    kind,
    program: kind === "agent" ? program : null,
    agentName: kind === "agent" ? "Claude Code" : null,
    cwd: HOME + REPO,
    dstCwd: THERE + REPO,
    argv: [],
    ...extra,
  });
  return {
    tx: "preview",
    space: { id: "preview", name: "checkout-api", named: true, machine: null, tabs: [] },
    src: { name: null, label: "this computer", home: HOME, shell: "/bin/zsh" },
    dst: { name: "build-box", label: "build-box", home: THERE, shell: "/bin/bash" },
    panes: [
      pane("t2", "Fix flaky payment retries", "agent", { session: session("3f9e21c4-6b0d-4a51-9c3e-0d7f2a8e5b16", 2.4) }),
      pane("t3", "Document the refund webhooks", "agent", { session: session("7a1c0d92-2e4f-4b8a-a1d3-5c6e9f0b7d21", 0.9) }),
      pane("t4", "zsh", "shell"),
      pane("t5", "npm run dev", "program", { argv: ["npm", "run", "dev"] }),
    ],
    projects: [{ src: HOME + REPO, dst: THERE + REPO, how: "same place in the home folder", state: "same" }],
    rules: [
      { from: HOME + REPO, to: THERE + REPO, why: "project folder" },
      { from: HOME, to: THERE, why: "home folder" },
    ],
    warnings: ["t5 runs `npm run dev`. It stops here, and there it opens a shell that shows the command."],
    blockers: [],
    bytes: Math.round(3.3 * 1048576),
  };
}

export const sampleTargets = [
  { name: "build-box", label: "build-box", state: "ready" },
  { name: "studio-mac", label: "studio-mac", state: "ready" },
  { name: "gpu-rig", label: "gpu-rig", state: "unavailable" },
];

/** The steps as a real move reports them, with how long each takes. */
export const sampleSteps = [
  ["check", 350, "build-box is ready"],
  ["finish", 900, "2 agents are idle", "t2 is finishing its turn…"],
  ["pause", 1700, "transcripts are complete", "stopping t3…"],
  ["files", 450, "they match", "~/code/checkout-api matches"],
  ["sessions", 1300, "61 files · 3.3 MB · 412 paths rewritten"],
  ["start", 500, "4 panes on build-box", "t5 → build-box/t12"],
  ["verify", 2700, "back in 7.4 s", "build-box/t10: trusted the folder there (it was trusted here)"],
  ["retire", 250, "the old space is closed"],
];

export const sampleResult = { ok: true, total: 9100, downtime: 7400, space: "build-box/preview" };
