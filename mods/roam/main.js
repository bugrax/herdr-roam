// roam: move a live herdr space, agents and all, to another machine.
//
// A dialog for the space you're looking at (`mod.open roam`; ⌘⇧M with the
// keys.json that ships with it). Pick a machine, read what will move, press
// Move. Agents finish their turn, pause, and continue there with their whole
// history; the old space closes. Anything that goes wrong is rolled back.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, focused, spaces, machines, nextCommand, notify, panes } from "herdr";
import { plan, move, interrupted, recover, abandon, STEPS, fmtBytes, fmtSecs } from "./engine.js";
import { samplePlan, sampleTargets, sampleSteps, sampleResult } from "./preview.js";
import { sleep } from "./machine.js";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const LOGO = "mods/roam/roam.svg";
const tilde = (p, home) => (p && home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p ?? "");

function icon(program, size, color) {
  if (!program?.icon) return svg(I("terminal")).size(size).flex_none().text_color(color);
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).w(size).h(size).flex_none();
}

function button(t, id, label, onClick, { primary = false, disabled = false } = {}) {
  return div()
    .id(id)
    .h(30)
    .px(14)
    .flex()
    .items_center()
    .rounded(8)
    .text_size(12.5)
    .font_medium()
    .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
    .when(!primary, (el) => el.border_1().border_color(t.input).bg(t.raised).text_color(t.foreground))
    .when(disabled, (el) => el.opacity(0.4))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)))
    .child(label);
}

function pill(t, name, label) {
  return h_flex()
    .flex_none()
    .gap(6)
    .h(26)
    .px(10)
    .items_center()
    .rounded(13)
    .bg(t.raised)
    .border_1()
    .border_color(t.border)
    .child(svg(I(name ? "server" : "monitor")).size(12).text_color(t.muted))
    .child(div().text_size(12).font_medium().text_color(t.foreground).child(label));
}

function section(t, title) {
  return div().pt(14).pb(5).text_size(11.5).font_medium().text_color(t.dim).child(title);
}

function note(t, color, text) {
  return h_flex()
    .gap(8)
    .px(10)
    .py(7)
    .rounded(8)
    .bg(color + "14")
    .border_1()
    .border_color(color + "40")
    .child(div().mt(5).size(6).flex_none().rounded(3).bg(color))
    .child(div().flex_1().min_w(0).text_size(12.3).line_height("18px").text_color(t.foreground).child(text));
}

export default class Roam extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
    this.spaceId = props()?.space ?? focused()?.space ?? null;
    this.view = "pick"; // pick | planning | review | moving | done | failed
    this.sel = 0;
    this.plan = null;
    this.error = null;
    this.steps = {};
    this.result = null;
    this.cancel = false;
    this.copied = false;
    this.live = null;
    // Moves cut off earlier (the dialog closed, Herdr quit): offer to undo them.
    this.stale = [];
    this.recovering = null;
    cx.spawn(async (cx) => {
      this.stale = await interrupted().catch(() => []);
      cx.notify();
    });
    cx.timer.every(1000, (cx) => {
      if (this.view === "moving") cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  space() {
    return spaces().find((s) => s.id === this.spaceId) ?? null;
  }

  // Every connected machine but the space's own, this computer first.
  targets() {
    if (this.isPreview) return sampleTargets;
    const here = this.space()?.machine ?? null;
    return machines()
      .filter((m) => (m.name ?? null) !== here)
      .map((m) => ({ name: m.name ?? null, label: m.name ?? "This computer", state: m.layout }))
      .sort((a, b) => (a.name === null ? -1 : b.name === null ? 1 : a.label.localeCompare(b.label)));
  }

  pick(i, cx) {
    const target = this.targets()[i];
    if (!target || target.state === "unavailable") return;
    if (this.isPreview) return this.preview("review", cx); // never plan a made-up move
    this.target = target;
    this.view = "planning";
    this.plan = null;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        this.plan = await plan(this.spaceId, target.name);
        this.view = "review";
      } catch (e) {
        this.error = e.message;
        this.view = "failed";
      }
      cx.notify();
    });
  }

  go(cx) {
    if (this.view !== "review" || !this.plan || this.plan.blockers.length) return;
    if (this.isPreview) return this.preview("play", cx); // never move a made-up space
    this.view = "moving";
    this.steps = {};
    this.t0 = Date.now();
    this.paused = false;
    this.cancel = false;
    const finish = (res, cx) => {
      if (this.result) return;
      this.result = res;
      this.view = res.ok ? "done" : "failed";
      this.error = res.ok ? null : res.error;
      const name = this.plan.space.name;
      notify(
        res.ok
          ? { title: `${name} moved to ${this.target.label}`, body: `Agents were paused for ${fmtSecs(res.downtime)}.`, level: "success", action: { name: "space.select", args: { id: res.space } } }
          : { title: `Couldn't move ${name}`, body: res.rolledBack ? `${res.error} Everything is back on ${this.plan.src.label}.` : res.error, level: res.cancelled ? "info" : "error" },
      );
      cx.notify();
    };
    this.result = null;
    cx.spawn(async (cx) => {
      const res = await move(this.plan, {
        step: (key, state, detail) => {
          this.steps[key] = { state, detail, at: Date.now() };
          if (key === "pause" && state === "run") this.paused = true;
          cx.notify();
        },
        cancelled: () => this.cancel,
        // Said before the old space closes, which may close this dialog too.
        finished: (r) => finish(r, cx),
        track: (live) => (this.live = live),
      });
      finish(res, cx);
    });
  }

  dismiss() {
    closeOverlay(props()?.overlay);
  }

  // Closed mid-move (⌘⇧M again, Herdr quitting): start the rollback on the way out.
  async close(_cx) {
    if (this.view === "moving" && this.live && !this.isPreview) abandon(this.live);
  }

  recoverStale(item, cx) {
    if (this.recovering) return;
    this.recovering = item.tx;
    cx.spawn(async (cx) => {
      const r = await recover(item.path).catch((e) => ({ error: e.message }));
      this.stale = this.stale.filter((s) => s.tx !== item.tx);
      this.recovering = null;
      notify(
        r.error
          ? { title: "roam couldn't undo the cut-off move", body: r.error, level: "error" }
          : { title: `${item.space}: back on ${item.from}`, body: r.resumed ? `${r.resumed === 1 ? "Its agent runs" : `${r.resumed} agents run`} where it was again.` : "Nothing needed bringing back.", level: "success" },
      );
      cx.notify();
    });
  }

  staleBanner(t) {
    return v_flex()
      .pt(12)
      .gap(6)
      .children(
        this.stale.map((s) =>
          h_flex()
            .gap(10)
            .px(10)
            .py(8)
            .items_center()
            .rounded(8)
            .bg(t.blocked + "14")
            .border_1()
            .border_color(t.blocked + "40")
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(2)
                .child(div().text_size(12.5).font_medium().child(`A move of ${s.space} to ${s.to} was cut off`))
                .child(div().text_size(11.8).text_color(t.muted).child(`It stopped during "${s.phase}". ${s.agents ? `${s.agents === 1 ? "Its agent" : `${s.agents} agents`} may still be paused on ${s.from}.` : ""}`)),
            )
            .child(button(t, `roam-recover-${s.tx}`, this.recovering === s.tx ? "Bringing back…" : "Bring them back", (cx) => this.recoverStale(s, cx), { primary: true, disabled: Boolean(this.recovering) })),
        ),
      );
  }

  escape(cx) {
    if (this.view === "moving") {
      // Before agents pause, Esc cancels; after, the move must finish (or roll back).
      if (!this.paused) this.cancel = true;
      return;
    }
    if (this.view === "review" || (this.view === "failed" && this.plan)) {
      this.view = "pick";
      cx.notify();
      return;
    }
    this.dismiss();
  }

  // A made-up move (preview.js) for screenshots: `herdr-app do roam.preview-<view>`.
  preview(kind, cx) {
    this.isPreview = true;
    this.plan = samplePlan(panes().find((p) => p.app === "claude-code")?.program);
    this.target = sampleTargets[0];
    this.result = null;
    this.error = null;
    this.steps = {};
    this.sel = 0;
    const all = (state) => Object.fromEntries(sampleSteps.map(([k, , done]) => [k, { state, detail: done }]));
    if (kind === "pick" || kind === "planning" || kind === "review") this.view = kind;
    else if (kind === "done") [this.view, this.steps, this.result] = ["done", all("done"), sampleResult];
    else if (kind === "failed") {
      this.view = "failed";
      const why = "Claude exited there: Not logged in · Please run /login";
      this.steps = { ...all("done"), verify: { state: "fail", detail: why }, retire: undefined };
      this.result = { ok: false, rolledBack: true, error: why };
      this.error = this.result.error;
    } else if (kind === "play") {
      this.view = "moving";
      this.t0 = Date.now();
      this.paused = false;
      cx.spawn(async (cx) => {
        for (const [key, ms, done, during] of sampleSteps) {
          this.steps[key] = { state: "run", detail: during ?? "" };
          if (key === "pause") this.paused = true;
          cx.notify();
          await sleep(ms);
          this.steps[key] = { state: "done", detail: done };
          cx.notify();
        }
        await sleep(600);
        this.result = sampleResult;
        this.view = "done";
        cx.notify();
      });
    }
  }

  command(c, cx) {
    if (c.startsWith("preview-")) return this.preview(c.slice("preview-".length), cx);
    if (c === "recover" && this.view === "pick" && this.stale.length) return this.recoverStale(this.stale[0], cx);
    const n = this.targets().length || 1;
    if (c === "next" && this.view === "pick") this.sel = (this.sel + 1) % n;
    else if (c === "prev" && this.view === "pick") this.sel = (this.sel - 1 + n) % n;
    else if (c === "go") {
      if (this.view === "pick") this.pick(this.sel, cx);
      else if (this.view === "review") this.go(cx);
      else if (this.view === "done" || this.view === "failed") this.dismiss();
    } else if (c === "back" || c === "close") this.escape(cx);
  }

  key(e, cx) {
    const k = e.key;
    if (k === "escape") this.escape(cx);
    else if (k === "down" || k === "j") this.command("next", cx);
    else if (k === "up" || k === "k") this.command("prev", cx);
    else if (k === "enter") this.command("go", cx);
    else if (k === "r") this.command("recover", cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ── views ────────────────────────────────────────────────────────────

  header(t) {
    // Once the old space closes, the plan still knows its name.
    const name = this.isPreview ? this.plan.space.name : (this.space()?.name ?? this.plan?.space?.name ?? null);
    return v_flex()
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .child(svg(LOGO).size(17).text_color(t.accent))
          .child(div().text_size(15).font_semibold().child("Roam"))
          .when(Boolean(name), (el) => el.child(div().px(8).py(2).rounded(6).bg(t.raised).text_size(12).text_color(t.muted).child(name)))
          .child(div().flex_1())
          .when(!(this.view === "moving" && this.paused), (el) =>
            el.child(
              div()
                .id("roam-esc")
                .px(6)
                .py(2)
                .rounded(5)
                .text_size(11)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((x) => x.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.escape(cx))
                .child(this.view === "moving" ? "Cancel" : "Esc"),
            ),
          ),
      )
      .when(this.view === "pick" || this.view === "planning", (el) =>
        el.child(
          div()
            .pt(6)
            .text_size(12.8)
            .line_height("19px")
            .text_color(t.muted)
            .child("Move this space to another machine. Agents finish their turn, then continue there with their whole history: transcripts, subagents, memory and /rewind."),
        ),
      );
  }

  route(t) {
    const p = this.plan;
    if (!p?.src) return div();
    return h_flex()
      .pt(14)
      .gap(8)
      .items_center()
      .child(pill(t, p.src.name, p.src.name ?? "This computer"))
      .child(svg(I("chevron-right")).size(13).text_color(t.dim))
      .child(pill(t, p.dst.name, p.dst.name ?? "This computer"))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).child(`${p.panes.length} ${p.panes.length === 1 ? "pane" : "panes"} · ${fmtBytes(p.bytes)}`));
  }

  pickView(t) {
    const list = this.targets();
    if (!this.space() && !this.isPreview) return div().pt(14).text_size(12.5).text_color(t.dim).child("Open the space you want to move, then open roam again.");
    if (!list.length)
      return div().pt(14).text_size(12.5).line_height("19px").text_color(t.dim).child("No other machine is connected. Add one with Add machine in the sidebar (or `hc machine add`), then come back.");
    return v_flex()
      .when(this.stale.length > 0 && !this.isPreview, (el) => el.child(this.staleBanner(t)))
      .child(section(t, "Move it to"))
      .children(
        list.map((m, i) => {
          const off = m.state === "unavailable";
          return h_flex()
            .id(`roam-target-${i}`)
            .h(40)
            .px(10)
            .gap(10)
            .items_center()
            .rounded(8)
            .when(i === this.sel, (el) => el.bg(t.selected ?? t.hover))
            .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(i, cx)))
            .when(off, (el) => el.opacity(0.45))
            .child(svg(I(m.name ? "server" : "monitor")).size(15).text_color(t.muted))
            .child(div().flex_1().text_size(13).text_color(t.foreground).child(m.label))
            .child(div().text_size(12).text_color(t.dim).child(off ? "offline" : m.state === "loading" ? "connecting" : ""))
            .child(svg(I("chevron-right")).size(13).text_color(t.dim));
        }),
      );
  }

  planningView(t) {
    return h_flex()
      .pt(18)
      .pb(6)
      .gap(10)
      .items_center()
      .child(svg(I("spinner")).size(14).text_color(t.working).spin(900))
      .child(div().text_size(12.8).text_color(t.muted).child(`Looking at the sessions, folders and ${this.target?.label ?? "the target"}…`));
  }

  // A pane; its folder only when it isn't the one most panes share (that one is under Folders).
  paneRow(t, x, common) {
    const p = this.plan;
    const what =
      x.kind === "agent" ? (x.session ? `${x.agentName ?? "agent"} · ${x.session.id.slice(0, 8)} · ${fmtBytes(x.session.bytes)}` : "agent")
      : x.kind === "shell" ? "shell"
      : "program";
    return v_flex()
      .px(10)
      .py(5)
      .gap(3)
      .rounded(8)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(icon(x.program, 14, t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(x.title || x.address))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(what)),
      )
      .when(x.cwd !== common, (el) =>
        el.child(
          h_flex()
            .pl(22)
            .gap(6)
            .items_center()
            .text_size(11.5)
            .text_color(t.dim)
            .child(div().min_w(0).truncate().child(tilde(x.cwd, p.src.home)))
            .child("→")
            .child(div().min_w(0).truncate().child(tilde(x.dstCwd, p.dst.home))),
        ),
      );
  }

  folderRow(t, pr) {
    const p = this.plan;
    const [color, label] = {
      same: [t.ansi2, "in sync"],
      differs: [t.blocked, "waits for your sync"],
      missing: [t.working, "gets copied"],
      unknown: [t.dim, "too big to compare"],
      home: [t.dim, "home folder, not compared"],
    }[pr.state] ?? [t.dim, pr.state];
    const from = tilde(pr.src, p.src.home);
    const to = tilde(pr.dst, p.dst.home);
    return h_flex()
      .px(10)
      .h(26)
      .gap(8)
      .items_center()
      .child(div().size(7).flex_none().rounded(4).bg(color))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .text_size(12.3)
          .text_color(t.foreground)
          .child(div().min_w(0).truncate().child(from))
          .when(from !== to, (el) => el.child(div().text_color(t.dim).child("→")).child(div().min_w(0).truncate().child(to))),
      )
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(label));
  }

  reviewView(t) {
    const p = this.plan;
    const rules = p.rules.filter((r) => r.from !== r.to);
    const counts = new Map();
    for (const x of p.panes) counts.set(x.cwd, (counts.get(x.cwd) ?? 0) + 1);
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return v_flex()
      .child(this.route(t))
      .child(
        v_flex()
          .id("roam-review")
          .max_h(440)
          .min_h(0)
          .flex_shrink(1)
          .overflow_y_scroll()
          .child(section(t, "What moves"))
          .children(p.panes.map((x) => this.paneRow(t, x, common)))
          .when(p.projects.length > 0, (el) => el.child(section(t, "Folders")).children(p.projects.map((pr) => this.folderRow(t, pr))))
          .when(rules.length > 0, (el) =>
            el.child(section(t, "Paths it rewrites")).children(
              rules.map((r) =>
                h_flex()
                  .px(10)
                  .h(22)
                  .gap(6)
                  .items_center()
                  .text_size(11.8)
                  .child(div().text_color(t.foreground).child(r.from))
                  .child(div().text_color(t.dim).child("→"))
                  .child(div().text_color(t.foreground).child(r.to))
                  .child(div().flex_1())
                  .child(div().text_color(t.dim).child(r.why)),
              ),
            ),
          )
          .when(p.warnings.length + p.blockers.length > 0, (el) =>
            el.child(
              v_flex()
                .pt(14)
                .gap(6)
                .children([...p.blockers.map((b) => note(t, t.blocked, b)), ...p.warnings.map((w) => note(t, t.working, w))]),
            ),
          ),
      )
      .child(
        h_flex()
          .pt(16)
          .gap(8)
          .items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child(p.blockers.length ? "Fix the above, then try again." : "Agents pause only between turns."))
          .child(button(t, "roam-back", "Back", (cx) => this.escape(cx)))
          .child(button(t, "roam-move", `Move to ${p.dst.name ?? "this computer"}`, (cx) => this.go(cx), { primary: true, disabled: p.blockers.length > 0 })),
      );
  }

  stepRow(t, key, title) {
    const s = this.steps[key];
    const state = s?.state ?? "wait";
    const mark =
      state === "run" ? svg(I("spinner")).size(13).text_color(t.working).spin(900)
      : state === "done" ? svg(I("circle-check")).size(13).text_color(t.ansi2)
      : state === "fail" ? svg(I("x")).size(13).text_color(t.blocked)
      : state === "skip" ? svg(I("minus")).size(13).text_color(t.dim)
      : h_flex().size(13).items_center().justify_center().child(div().size(5).rounded(3).bg(t.border));
    return v_flex()
      .px(10)
      .py(5)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(mark)
          .child(div().flex_none().text_size(12.8).text_color(state === "wait" ? t.dim : t.foreground).child(title))
          .child(div().flex_1())
          .when(state !== "fail" && Boolean(s?.detail), (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(s.detail))),
      )
      .when(state === "fail" && Boolean(s?.detail), (el) => el.child(div().pl(23).pt(3).text_size(12).line_height("18px").text_color(t.blocked).child(s.detail)));
  }

  movingView(t) {
    const elapsed = Date.now() - (this.t0 ?? Date.now());
    return v_flex()
      .child(this.route(t))
      .child(v_flex().pt(12).children(STEPS.map(([k, title]) => this.stepRow(t, k, title))))
      .child(
        h_flex()
          .pt(14)
          .items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child(this.paused ? "Keep this open until it finishes." : "Esc cancels until agents pause."))
          .child(div().text_size(11.5).text_color(t.dim).child(fmtSecs(elapsed))),
      );
  }

  doneView(t) {
    const r = this.result;
    const p = this.plan;
    return v_flex()
      .child(this.route(t))
      .child(v_flex().pt(10).children(STEPS.map(([k, title]) => this.stepRow(t, k, title))))
      .child(
        h_flex()
          .mt(14)
          .p(12)
          .gap(12)
          .items_center()
          .rounded(10)
          .bg(t.ansi2 + "14")
          .border_1()
          .border_color(t.ansi2 + "40")
          .child(svg(I("circle-check")).size(22).text_color(t.ansi2))
          .child(
            v_flex()
              .flex_1()
              .gap(2)
              .child(div().text_size(13.5).font_semibold().child(`${p.space.name} is on ${p.dst.name ?? "this computer"}`))
              .child(div().text_size(12).text_color(t.muted).child(`Agents were paused for ${fmtSecs(r.downtime)} · ${fmtSecs(r.total)} in all`)),
          )
          .child(button(t, "roam-close", "Done", () => this.dismiss(), { primary: true })),
      );
  }

  failedView(t) {
    const r = this.result;
    const p = this.plan;
    return v_flex()
      .when(Boolean(p?.src), (el) => el.child(this.route(t)))
      .when(Boolean(r), (el) => el.child(v_flex().pt(10).children(STEPS.map(([k, title]) => this.stepRow(t, k, title)))))
      .child(
        v_flex()
          .mt(14)
          .p(12)
          .gap(6)
          .rounded(10)
          .bg(t.blocked + "12")
          .border_1()
          .border_color(t.blocked + "40")
          .child(
            h_flex()
              .gap(10)
              .items_center()
              .child(svg(I("x")).size(16).text_color(t.blocked))
              .child(div().text_size(13.5).font_semibold().child(r?.cancelled ? "Cancelled" : "It didn't move")),
          )
          .when(!r?.cancelled, (el) => el.child(div().text_size(12.3).line_height("18px").text_color(t.foreground).child(this.error ?? "")))
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(r?.rolledBack ? `Rolled back: everything is running on ${p.src.name ?? "this computer"} again.` : "Nothing changed."),
          )
          .when(Boolean(r?.journal), (el) =>
            el.child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.journal))
                .child(
                  div()
                    .id("roam-copy-journal")
                    .px(8)
                    .py(3)
                    .rounded(6)
                    .bg(t.raised)
                    .text_size(11.5)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      cx.write_to_clipboard(r.journal);
                      this.copied = true;
                      cx.notify();
                    })
                    .child(this.copied ? "Copied" : "Copy log path"),
                ),
            ),
          ),
      )
      .child(
        h_flex()
          .pt(14)
          .gap(8)
          .child(div().flex_1())
          .when(Boolean(p), (el) => el.child(button(t, "roam-again", "Try again", (cx) => this.pick(this.targets().findIndex((m) => m.name === this.target?.name), cx))))
          .child(button(t, "roam-done", "Close", () => this.dismiss(), { primary: true })),
      );
  }

  render() {
    const t = theme();
    const body =
      this.view === "pick" ? this.pickView(t)
      : this.view === "planning" ? this.planningView(t)
      : this.view === "review" ? this.reviewView(t)
      : this.view === "moving" ? this.movingView(t)
      : this.view === "done" ? this.doneView(t)
      : this.failedView(t);
    return v_flex()
      .id("roam")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(this.header(t))
      .child(body);
  }
}
