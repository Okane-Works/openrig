import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERDR_COMMUNITY_SOURCE,
  HERDR_STATUS_DEBOUNCE_MS,
  HERDR_STATUS_REPLAY_MS,
  HERDR_STATUS_SWEEP_MS,
  HerdrAgentStatusRelay,
  herdrAgentState,
  type HerdrSeatActivity,
} from "../src/domain/terminal/herdr-agent-status.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { AgentActivity, AgentActivityState } from "../src/domain/types.js";

const activity = (state: AgentActivityState): AgentActivity =>
  ({ state, reason: "hook", evidenceSource: "hook", sampledAt: "2026-11-11T00:00:00.000Z", evidence: null }) as AgentActivity;

type Call = { method: string; params: Record<string, unknown> };

/** A Herdr endpoint: panes with their foreground pids (null = unreadable), and methods that can be told to fail. */
function herdr(panes: Record<string, unknown[] | null>) {
  const calls: Call[] = [];
  /** Extra raw entries for the pane list, to make it malformed. */
  const extraPanes: unknown[] = [];
  const failing = new Set<string>();
  const authorities = new Map<string, { source: string; agent: string; state: unknown }>();
  let gate: Promise<void> | null = null;
  const transport: HerdrTransport = {
    async probe() { return { alive: true, version: null, protocol: null }; },
    async request(method, params): Promise<HerdrResult> {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      if (gate && method === "pane.report_agent") await gate;
      if (failing.has(method)) throw new Error(`${method} failed`);
      if (method === "pane.list") return { type: "pane_list", panes: [...Object.keys(panes).map((pane_id) => ({ pane_id, agent: authorities.get(pane_id)?.agent ?? null })), ...extraPanes] };
      if (method === "pane.process_info") {
        const pids = panes[p["pane_id"] as string];
        if (!pids) throw new Error("unreadable");
        return { type: "pane_process_info", process_info: { foreground_processes: pids.map((pid) => ({ pid, argv: ["tmux"] })) } };
      }
      if (method === "pane.report_agent") authorities.set(p["pane_id"] as string, { source: p["source"] as string, agent: p["agent"] as string, state: p["state"] });
      if (method === "pane.release_agent") {
        const held = authorities.get(p["pane_id"] as string);
        // Herdr rejects source OR agent mismatches without mutation.
        if (held?.source === p["source"] && held.agent === p["agent"]) authorities.delete(p["pane_id"] as string);
      }
      return { type: "ok" };
    },
  };
  const of = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return {
    transport, panes, calls, failing, extraPanes, authorities,
    reports: () => of("pane.report_agent"),
    releases: () => of("pane.release_agent"),
    /** Holds every report until the returned function is called. */
    hold() { let open!: () => void; gate = new Promise<void>((r) => { open = r; }); return () => { gate = null; open(); }; },
  };
}

function rig(opts: {
  endpoints: Array<ReturnType<typeof herdr>>;
  clients: Array<{ pid: number; session: string }>;
  seats: Record<string, HerdrSeatActivity>;
}) {
  const clock = { now: 1_000_000 };
  const inventory = { fail: false, listings: 0 };
  const unresolvable = new Set<string>();
  const relay = new HerdrAgentStatusRelay({
    clients: {
      async listClientProcesses() {
        inventory.listings++;
        if (inventory.fail) throw new Error("tmux unreadable");
        return opts.clients;
      },
    },
    resolve: (session) => {
      if (unresolvable.has(session)) throw new Error("store unreadable");
      return opts.seats[session] ?? { activity: null, runtime: null };
    },
    transports: () => opts.endpoints.map((e) => e.transport),
    sweep: false,
    now: () => clock.now,
  });
  return { relay, clock, inventory, unresolvable, ...opts };
}

const jcodeRig = (state: AgentActivityState = "running") => {
  const h = herdr({ p1: [501] });
  return { h, ...rig({ endpoints: [h], clients: [{ pid: 501, session: "dev-impl" }], seats: { "dev-impl": { activity: activity(state), runtime: "jcode" } } }) };
};

afterEach(() => { vi.useRealTimers(); });

describe("herdrAgentState", () => {
  it("maps OpenRig activity to Herdr states and never fakes idle", () => {
    expect(herdrAgentState(activity("running"))).toBe("working");
    expect(herdrAgentState(activity("idle"))).toBe("idle");
    expect(herdrAgentState(activity("needs_input"))).toBe("blocked");
    expect(herdrAgentState(activity("unknown"))).toBe("unknown");
    expect(herdrAgentState(null)).toBe("unknown");
  });
});

describe("HerdrAgentStatusRelay", () => {
  it.each(["detached", "builtin"])("recovers a previous daemon's report after restart when %s", async (mode) => {
    const h = herdr({ p1: [501] });
    const clients = [{ pid: 501, session: "s" }];
    const seats = { s: { activity: activity("running"), runtime: "jcode" } as HerdrSeatActivity };
    const first = rig({ endpoints: [h], clients, seats });
    await first.relay.sweep();
    first.relay.stop();
    if (mode === "detached") h.panes["p1"] = [];
    else seats.s.runtime = "claude-code";
    const restarted = rig({ endpoints: [h], clients, seats });
    restarted.clock.now++;
    h.failing.add("pane.release_agent");
    await restarted.relay.sweep();
    expect(h.authorities.get("p1")?.source).toBe(HERDR_COMMUNITY_SOURCE);
    h.failing.clear();
    await restarted.relay.sweep();
    expect(h.authorities.has("p1")).toBe(false);
    expect(h.releases().at(-1)).toMatchObject({ source: HERDR_COMMUNITY_SOURCE, agent: "jcode" });
    expect(h.reports()).toHaveLength(1);
  });

  it.each(["jcode", "claude"])("preserves a foreign reporter labelled %s during restart recovery", async (agent) => {
    const h = herdr({ p1: [] });
    const foreign = { source: "other-reporter", agent, state: "blocked" };
    h.authorities.set("p1", foreign);
    const r = rig({ endpoints: [h], clients: [], seats: {} });
    await r.relay.sweep();
    expect(h.releases()).toEqual([{ pane_id: "p1", source: HERDR_COMMUNITY_SOURCE, agent, seq: 1_000_000 }]);
    expect(h.authorities.get("p1")).toEqual(foreign);
    expect(h.reports()).toEqual([]);
    expect(h.calls.some((call) => call.method === "pane.clear_agent_authority")).toBe(false);
  });

  it("keeps previous-daemon authority until process and seat inventories are readable", async () => {
    const h = herdr({ p1: null });
    h.authorities.set("p1", { source: HERDR_COMMUNITY_SOURCE, agent: "jcode", state: "working" });
    const r = rig({ endpoints: [h], clients: [{ pid: 501, session: "s" }], seats: {} });
    await r.relay.sweep();
    h.panes["p1"] = [501];
    r.unresolvable.add("s");
    await r.relay.sweep();
    expect(h.releases()).toEqual([]);
    r.unresolvable.clear();
    await r.relay.sweep();
    expect(h.authorities.has("p1")).toBe(false);
  });

  it("reports a community harness seat to the pane running its tmux client", async () => {
    const { h, relay } = jcodeRig();
    await relay.sweep();
    expect(h.calls[0]).toEqual({ method: "pane.list", params: {} });
    expect(h.reports()).toEqual([{ pane_id: "p1", source: HERDR_COMMUNITY_SOURCE, agent: "jcode", state: "working", seq: 1_000_000 }]);
    expect(HERDR_COMMUNITY_SOURCE).toBe("openrig-community");
    expect(JSON.stringify(h.calls)).not.toContain("resume_argv");
  });

  it("names an arbitrary custom harness as OpenRig names it", async () => {
    const h = herdr({ p1: [7], p2: [8] });
    const r = rig({
      endpoints: [h],
      clients: [{ pid: 7, session: "a" }, { pid: 8, session: "b" }],
      seats: { a: { activity: activity("idle"), runtime: "My Harness v2" }, b: { activity: activity("needs_input"), runtime: "opencode" } },
    });
    await r.relay.sweep();
    expect(h.reports().map((p) => [p["pane_id"], p["agent"], p["state"]])).toEqual([["p1", "My Harness v2", "idle"], ["p2", "opencode", "blocked"]]);
  });

  it("leaves built-in runtimes, runtime-less sessions and unrelated panes alone", async () => {
    const h = herdr({ claude: [1], codex: [2], pi: [3], bare: [4], shell: [999], empty: [] });
    const r = rig({
      endpoints: [h],
      clients: [{ pid: 1, session: "c" }, { pid: 2, session: "x" }, { pid: 3, session: "p" }, { pid: 4, session: "n" }],
      seats: {
        c: { activity: activity("running"), runtime: "claude-code" }, x: { activity: activity("running"), runtime: "codex" },
        p: { activity: activity("running"), runtime: "pi" }, n: { activity: activity("running"), runtime: null },
      },
    });
    await r.relay.sweep();
    expect(h.reports()).toEqual([]);
    expect(h.releases()).toEqual([]);
  });

  it("attributes by pid, never by the pane's label, among several foreground processes", async () => {
    // Pane labels are not used to attribute a viewer, only its foreground pid is.
    const h = herdr({ p1: [10, 11, 12], p2: [20] });
    h.authorities.set("p1", { source: "other-reporter", agent: "claude", state: "idle" });
    h.authorities.set("p2", { source: "other-reporter", agent: "jcode", state: "idle" });
    const r = rig({
      endpoints: [h],
      clients: [{ pid: 12, session: "s1" }, { pid: 77, session: "s2" }],
      seats: { s1: { activity: activity("running"), runtime: "jcode" }, s2: { activity: activity("running"), runtime: "jcode" } },
    });
    await r.relay.sweep();
    expect(h.reports().map((p) => p["pane_id"])).toEqual(["p1"]);
  });

  it("reports to every viewer of a seat on every endpoint, each endpoint with its own cache", async () => {
    const a = herdr({ p1: [1], p2: [2] });
    const b = herdr({ p1: [3] }); // same pane id as on endpoint a
    const seats = { s: { activity: activity("running"), runtime: "jcode" } as HerdrSeatActivity };
    const r = rig({ endpoints: [a, b], clients: [1, 2, 3].map((pid) => ({ pid, session: "s" })), seats });
    await r.relay.sweep();
    expect(a.reports().map((p) => p["pane_id"])).toEqual(["p1", "p2"]);
    expect(b.reports().map((p) => p["pane_id"])).toEqual(["p1"]);
    // Endpoint b loses its viewer: only b releases, a is untouched.
    b.panes["p1"] = [];
    await r.relay.sweep();
    expect(b.releases().map((p) => p["pane_id"])).toEqual(["p1"]);
    expect(a.releases()).toEqual([]);
    expect(a.reports()).toHaveLength(2);
  });

  it("clears to unknown when OpenRig stops knowing the activity", async () => {
    const { h, relay, seats } = jcodeRig("running");
    await relay.sweep();
    seats["dev-impl"] = { activity: null, runtime: "jcode" };
    await relay.sweep();
    expect(h.reports().map((p) => p["state"])).toEqual(["working", "unknown"]);
    expect(h.releases()).toEqual([]);
  });

  it("skips unchanged states and keeps seq growing when the clock doesn't", async () => {
    const { h, relay, seats } = jcodeRig("running");
    await relay.sweep();
    await relay.sweep();
    expect(h.reports()).toHaveLength(1);
    seats["dev-impl"] = { activity: activity("idle"), runtime: "jcode" };
    await relay.sweep();
    expect(h.reports().map((p) => p["seq"])).toEqual([1_000_000, 1_000_001]);
  });

  it("releases when the viewer is gone, and stops tracking a pane Herdr dropped", async () => {
    const { h, relay } = jcodeRig();
    await relay.sweep();
    h.panes["p1"] = [900];
    await relay.sweep();
    expect(h.releases()).toEqual([{ pane_id: "p1", source: HERDR_COMMUNITY_SOURCE, agent: "jcode", seq: 1_000_001 }]);
    await relay.sweep();
    expect(h.releases()).toHaveLength(1);

    h.panes["p1"] = [501];
    await relay.sweep();
    delete h.panes["p1"];
    await relay.sweep();
    expect(h.releases()).toHaveLength(1); // the pane is gone, there's nothing to release
  });

  it("releases when the pane is rebound to a built-in seat, and swaps agents for another harness", async () => {
    const h = herdr({ p1: [1] });
    const r = rig({
      endpoints: [h],
      clients: [{ pid: 1, session: "j" }, { pid: 2, session: "c" }, { pid: 3, session: "o" }],
      seats: {
        j: { activity: activity("running"), runtime: "jcode" }, c: { activity: activity("running"), runtime: "claude-code" },
        o: { activity: activity("idle"), runtime: "opencode" },
      },
    });
    await r.relay.sweep();
    h.panes["p1"] = [2];
    await r.relay.sweep();
    expect(h.releases().map((p) => p["agent"])).toEqual(["jcode"]);
    expect(h.reports()).toHaveLength(1);

    h.panes["p1"] = [1];
    await r.relay.sweep();
    h.panes["p1"] = [3];
    await r.relay.sweep();
    expect(h.releases().map((p) => p["agent"])).toEqual(["jcode", "jcode"]);
    expect(h.reports().at(-1)).toMatchObject({ agent: "opencode", state: "idle" });
    const order = h.calls.filter((c) => /report_agent|release_agent/.test(c.method)).map((c) => c.method).slice(-2);
    expect(order).toEqual(["pane.release_agent", "pane.report_agent"]);
  });

  it("keeps the last-good mapping while any inventory is unreadable, with no false release", async () => {
    const { h, relay, inventory } = jcodeRig();
    await relay.sweep();

    inventory.fail = true; // tmux clients unreadable
    await relay.sweep();
    inventory.fail = false;

    h.panes["p1"] = null; // pane processes unreadable
    await relay.sweep();

    h.panes["p1"] = [501];
    h.failing.add("pane.list"); // pane list unreadable
    await relay.sweep();
    h.failing.delete("pane.list");

    expect(h.releases()).toEqual([]);
    // Readable again and truly gone: now it is released.
    h.panes["p1"] = [];
    await relay.sweep();
    expect(h.releases()).toHaveLength(1);
  });

  it("retries a report Herdr didn't accept, and a release it didn't accept", async () => {
    const { h, relay, seats } = jcodeRig();
    h.failing.add("pane.report_agent");
    await expect(relay.sweep()).resolves.toBeUndefined();
    h.failing.delete("pane.report_agent");
    await relay.sweep();
    expect(h.reports()).toHaveLength(2);
    await relay.sweep();
    expect(h.reports()).toHaveLength(2);

    // A failed change, then back to the last accepted state: Herdr may show either, so it is sent again.
    seats["dev-impl"] = { activity: activity("idle"), runtime: "jcode" };
    h.failing.add("pane.report_agent");
    await relay.sweep();
    h.failing.delete("pane.report_agent");
    seats["dev-impl"] = { activity: activity("running"), runtime: "jcode" };
    await relay.sweep();
    expect(h.reports().map((p) => p["state"])).toEqual(["working", "working", "idle", "working"]);

    h.panes["p1"] = [];
    h.failing.add("pane.release_agent");
    await relay.sweep();
    h.failing.delete("pane.release_agent");
    await relay.sweep();
    await relay.sweep();
    expect(h.releases()).toHaveLength(2);
  });

  it("serializes passes and coalesces calls made during one", async () => {
    const { h, relay, seats, inventory } = jcodeRig();
    const open = h.hold();
    const first = relay.sweep();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    seats["dev-impl"] = { activity: activity("needs_input"), runtime: "jcode" };
    const followers = [relay.sweep(), relay.sweep(), relay.sweep()];
    expect(new Set(followers).size).toBe(1);
    expect(inventory.listings).toBe(1);
    open();
    await Promise.all([first, ...followers]);
    expect(inventory.listings).toBe(2);
    expect(h.reports().map((p) => p["state"])).toEqual(["working", "blocked"]);
  });

  it("sends nothing more once stopped, even with a pass in flight", async () => {
    const h = herdr({ p1: [1], p2: [2] });
    const r = rig({
      endpoints: [h], clients: [{ pid: 1, session: "s" }, { pid: 2, session: "s" }],
      seats: { s: { activity: activity("running"), runtime: "jcode" } },
    });
    const open = h.hold();
    const first = r.relay.sweep();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    const queued = r.relay.sweep();
    r.relay.stop();
    open();
    await Promise.all([first, queued]);
    const settled = h.calls.length;
    expect(h.reports()).toHaveLength(1);
    await r.relay.sweep();
    await r.relay.activityChanged();
    expect(h.calls).toHaveLength(settled);
  });

  it("replays an unchanged state after the replay interval, so a restarted Herdr shows it again", async () => {
    const { h, relay, clock } = jcodeRig();
    await relay.sweep();
    clock.now += HERDR_STATUS_REPLAY_MS - 1;
    await relay.sweep();
    expect(h.reports()).toHaveLength(1);
    clock.now += 1;
    await relay.sweep();
    expect(h.reports()).toHaveLength(2);
    expect(h.reports()[1]).toMatchObject({ state: "working", seq: 1_000_000 + HERDR_STATUS_REPLAY_MS });
  });

  it("sweeps every five seconds once started, and not after stop or when turned off", async () => {
    vi.useFakeTimers();
    const h = herdr({ p1: [501] });
    const seats: Record<string, HerdrSeatActivity> = { s: { activity: activity("running"), runtime: "jcode" } };
    const make = (sweep?: boolean) => new HerdrAgentStatusRelay({
      clients: { async listClientProcesses() { return [{ pid: 501, session: "s" }]; } },
      resolve: (session) => seats[session]!, transports: () => [h.transport], sweep,
    });
    const relay = make();
    relay.start();
    relay.start();
    expect(HERDR_STATUS_SWEEP_MS).toBe(5_000);
    // Existing viewers are found at start, not five seconds later.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HERDR_STATUS_SWEEP_MS - 1);
    expect(h.reports()).toHaveLength(1);
    seats["s"] = { activity: activity("idle"), runtime: "jcode" };
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reports()).toHaveLength(2);
    relay.stop();
    relay.start();
    const settled = h.calls.length;
    await vi.advanceTimersByTimeAsync(HERDR_STATUS_SWEEP_MS * 3);
    expect(h.calls).toHaveLength(settled);

    const off = make(false);
    off.start();
    await vi.advanceTimersByTimeAsync(HERDR_STATUS_SWEEP_MS * 3);
    expect(h.calls).toHaveLength(settled);
    off.stop();
  });

  it("gathers activity changes into one pass, within a bound the changes can't extend", async () => {
    vi.useFakeTimers();
    const { h, relay, seats, inventory } = jcodeRig();
    const first = relay.activityChanged();
    expect(inventory.listings).toBe(0);
    await vi.advanceTimersByTimeAsync(HERDR_STATUS_DEBOUNCE_MS - 1);
    seats["dev-impl"] = { activity: activity("needs_input"), runtime: "jcode" };
    expect(relay.activityChanged()).toBe(first);
    expect(inventory.listings).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(inventory.listings).toBe(1);
    expect(h.reports().map((p) => p["state"])).toEqual(["blocked"]);

    // A later change starts a new wait.
    seats["dev-impl"] = { activity: activity("idle"), runtime: "jcode" };
    const second = relay.activityChanged();
    expect(second).not.toBe(first);
    await vi.advanceTimersByTimeAsync(HERDR_STATUS_DEBOUNCE_MS);
    await second;
    expect(h.reports().map((p) => p["state"])).toEqual(["blocked", "idle"]);
  });

  it("drops a pending activity change on stop, and settles its promise", async () => {
    vi.useFakeTimers();
    const { h, relay } = jcodeRig();
    const pending = relay.activityChanged();
    relay.stop();
    await expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(HERDR_STATUS_DEBOUNCE_MS * 2);
    await relay.activityChanged();
    expect(h.calls).toEqual([]);
  });

  it("treats a client list with one unreadable entry as unread", async () => {
    const { h, relay, clients } = jcodeRig();
    await relay.sweep();
    for (const bad of [{ pid: "77", session: "x" }, { pid: 0, session: "x" }, { pid: 1.5, session: "x" }, { pid: 77, session: "" }, { pid: 77 }, null]) {
      clients.length = 0; // the viewer's own entry is missing too: a partial list must not release it
      clients.push(bad as never);
      await relay.sweep();
    }
    expect(h.releases()).toEqual([]);
    expect(h.calls.filter((c) => c.method === "pane.list")).toHaveLength(1);
    clients.length = 0;
    await relay.sweep();
    expect(h.releases()).toHaveLength(1);
  });

  it("treats a pane list with one unreadable entry as unread", async () => {
    const { h, relay } = jcodeRig();
    await relay.sweep();
    h.panes["p1"] = [];
    for (const bad of [{ agent: "jcode" }, { pane_id: 7 }, { pane_id: "" }, null]) {
      h.extraPanes.splice(0, 1, bad);
      await relay.sweep();
    }
    expect(h.releases()).toEqual([]);
    expect(h.calls.filter((c) => c.method === "pane.process_info")).toHaveLength(1);
    h.extraPanes.length = 0;
    await relay.sweep();
    expect(h.releases()).toHaveLength(1);
  });

  it("treats a process list with one unreadable entry as unread, for that pane only", async () => {
    const h = herdr({ p1: [1], p2: [2] });
    const r = rig({
      endpoints: [h], clients: [{ pid: 1, session: "a" }, { pid: 2, session: "b" }],
      seats: { a: { activity: activity("running"), runtime: "jcode" }, b: { activity: activity("running"), runtime: "opencode" } },
    });
    await r.relay.sweep();
    h.panes["p2"] = [];
    for (const bad of ["1", -1, 0, 1.5, null, undefined]) {
      h.panes["p1"] = [900, bad]; // the client is gone from what can be read, but the list is incomplete
      await r.relay.sweep();
    }
    expect(h.releases().map((p) => p["pane_id"])).toEqual(["p2"]);
    h.panes["p1"] = [900];
    await r.relay.sweep();
    expect(h.releases().map((p) => p["pane_id"])).toEqual(["p2", "p1"]);
  });

  it("keeps the last-good state when a seat can't be resolved, and reports again once it can", async () => {
    const { h, relay, seats, unresolvable } = jcodeRig();
    await relay.sweep();
    unresolvable.add("dev-impl");
    seats["dev-impl"] = { activity: activity("idle"), runtime: "jcode" };
    await expect(relay.sweep()).resolves.toBeUndefined();
    expect(h.reports()).toHaveLength(1);
    expect(h.releases()).toEqual([]);
    unresolvable.delete("dev-impl");
    await relay.sweep();
    expect(h.reports().map((p) => p["state"])).toEqual(["working", "idle"]);
    expect(h.releases()).toEqual([]);
  });

  it("doesn't let one unresolvable seat hold back other panes", async () => {
    const h = herdr({ p1: [1], p2: [2] });
    const r = rig({
      endpoints: [h], clients: [{ pid: 1, session: "a" }, { pid: 2, session: "b" }],
      seats: { a: { activity: activity("running"), runtime: "jcode" }, b: { activity: activity("idle"), runtime: "opencode" } },
    });
    r.unresolvable.add("a");
    await r.relay.sweep();
    expect(h.reports().map((p) => p["pane_id"])).toEqual(["p2"]);
  });

  it("keys the cache by a transport's `key`, so a fresh transport object for the same endpoint still releases", async () => {
    const h = herdr({ p1: [501] });
    const r = rig({ endpoints: [h], clients: [{ pid: 501, session: "s" }], seats: { s: { activity: activity("running"), runtime: "jcode" } } });
    const keyed = () => Object.assign({ ...h.transport }, { key: "/tmp/herdr.sock" });
    const relay = new HerdrAgentStatusRelay({
      clients: { async listClientProcesses() { return r.clients; } },
      resolve: (session) => r.seats[session]!, transports: () => [keyed()], sweep: false, now: () => r.clock.now,
    });
    await relay.sweep();
    await relay.sweep();
    expect(h.reports()).toHaveLength(1);
    h.panes["p1"] = [];
    await relay.sweep();
    expect(h.releases()).toHaveLength(1);
  });
});
