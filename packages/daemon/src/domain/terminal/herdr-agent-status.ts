import { isCommunityHarnessRuntime } from "../built-in-runtimes.js";
import type { AgentActivity } from "../types.js";
import type { HerdrTransport } from "./herdr-transport.js";

/**
 * Herdr shows a pane's agent and its state from what it detects or is told about that pane. A viewer pane runs only
 * a tmux client. The harness itself (Jcode, a Jcode role variant, or any custom runtime name) runs in a pane of
 * OpenRig's tmux server, so whatever Herdr integration it has cannot name the Herdr pane that views it, and Herdr
 * does not recognise it through the client. This relays the activity OpenRig already resolves for a seat to the Herdr
 * panes whose foreground process is a tmux client of that seat's session.
 *
 * A pane is attributed by process id only: Herdr's foreground pids for the pane against the client pids of the
 * daemon's own tmux server. Titles and agent labels are never read. Built-in runtimes are never reported here: Herdr
 * shows those viewers by its own means, and a held report would replace that.
 *
 * Every reading is all or nothing. A client list, pane list or process list with one entry that can't be read is
 * treated as unread, as is a seat that can't be resolved: what was last reported stays, and nothing is released.
 */

/** The source every report and release carries. Stable, so a later daemon releases what an earlier one held. */
export const HERDR_COMMUNITY_SOURCE = "openrig-community";
/** How often panes are looked at again without an activity change: to reach a new viewer and retry a failed report. */
export const HERDR_STATUS_SWEEP_MS = 5_000;
/** How often an unchanged state is sent again, so a restarted Herdr server that kept its pane ids shows it again. */
export const HERDR_STATUS_REPLAY_MS = 30_000;
/** How long activity changes are gathered before one pass serves them all. The wait runs from the first change and
 *  is never extended, so a seat that keeps changing still shows within this bound. */
export const HERDR_STATUS_DEBOUNCE_MS = 100;

export type HerdrAgentState = "working" | "idle" | "blocked" | "unknown";

/** The daemon's tmux adapter, as far as the relay uses it: the client processes of its tmux server. */
export interface HerdrStatusClients {
  listClientProcesses(): Promise<Array<{ pid: number; session: string }>>;
}

/** A seat's activity and runtime at one reading. */
export interface HerdrSeatActivity { activity: AgentActivity | null; runtime: string | null }

export interface HerdrAgentStatusRelayDeps {
  clients: HerdrStatusClients;
  /** A seat's current activity and runtime, resolved the way `rig ps --nodes` resolves them. */
  resolve: (sessionName: string) => HerdrSeatActivity;
  /** The Herdr endpoints to report to, read at each sweep. A transport may carry a string `key` naming its endpoint;
   *  without one the object itself is the endpoint, so it must be the same object from sweep to sweep. */
  transports: () => readonly HerdrTransport[];
  /** False turns the periodic sweep off; `activityChanged` and `sweep` still work. */
  sweep?: boolean;
  now?: () => number;
}

/** The Herdr state for an OpenRig activity. No activity, or an unknown one, is `unknown`, never idle. */
export function herdrAgentState(activity: AgentActivity | null | undefined): HerdrAgentState {
  switch (activity?.state) {
    case "running": return "working";
    case "idle": return "idle";
    case "needs_input": return "blocked";
    default: return "unknown";
  }
}

/** What Herdr holds for a pane, as far as the last accepted report says. */
interface Held {
  agent: string;
  /** Null when a later report failed, so what Herdr shows is no longer known and the next sweep sends again. */
  state: HerdrAgentState | null;
  acceptedAt: number;
}

type Reading<T> = { ok: true; value: T } | { ok: false };

export class HerdrAgentStatusRelay {
  private readonly clients: HerdrStatusClients;
  private readonly resolve: (sessionName: string) => HerdrSeatActivity;
  private readonly transports: () => readonly HerdrTransport[];
  private readonly sweeps: boolean;
  private readonly now: () => number;
  /** Per endpoint, what each of its panes holds. Pane ids of two endpoints never share an entry. */
  private readonly held = new Map<unknown, Map<string, Held>>();
  private lastSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private debounce: { promise: Promise<void>; timer: ReturnType<typeof setTimeout>; done: () => void } | null = null;

  constructor(deps: HerdrAgentStatusRelayDeps) {
    this.clients = deps.clients;
    this.resolve = deps.resolve;
    this.transports = deps.transports;
    this.sweeps = deps.sweep !== false;
    this.now = deps.now ?? Date.now;
  }

  /** Looks at the viewers that already exist, then starts the periodic sweep. A stopped relay stays stopped. */
  start(): void {
    if (this.stopped || this.timer || !this.sweeps) return;
    this.timer = setInterval(() => { void this.sweep(); }, HERDR_STATUS_SWEEP_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  /** A seat's activity changed: bring the panes up to date shortly, instead of at the next sweep. Changes within
   *  the debounce share one pass. Resolves when that pass is over, or at once when the relay stops. */
  activityChanged(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.debounce) return this.debounce.promise;
    let done!: () => void;
    const promise = new Promise<void>((resolve) => { done = resolve; });
    const timer = setTimeout(() => {
      this.debounce = null;
      void this.sweep().then(done);
    }, HERDR_STATUS_DEBOUNCE_MS);
    timer.unref?.();
    this.debounce = { promise, timer, done };
    return promise;
  }

  /** One pass over every endpoint. Passes never overlap: calls made during a pass share one pass after it, which
   *  reads state fresh, so nothing that changed meanwhile is missed. Never rejects. */
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) {
      this.running = this.pass().catch(() => {}).finally(() => { this.running = null; });
      return this.running;
    }
    if (!this.queued) {
      this.queued = this.running.then(() => {
        this.queued = null;
        return this.sweep();
      });
    }
    return this.queued;
  }

  /** Stops the sweep. A pass in flight sends nothing more once its current call returns. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.debounce) {
      clearTimeout(this.debounce.timer);
      this.debounce.done();
      this.debounce = null;
    }
  }

  private async pass(): Promise<void> {
    let transports: readonly HerdrTransport[];
    let sessionByPid: Map<number, string>;
    try {
      transports = this.transports();
      // Without the client inventory no pane can be attributed, so nothing is reported and nothing released.
      const listed: unknown = await this.clients.listClientProcesses();
      if (!Array.isArray(listed)) return;
      sessionByPid = new Map();
      for (const client of listed) {
        const pid = (client as { pid?: unknown } | null)?.pid;
        const session = (client as { session?: unknown } | null)?.session;
        // One client that can't be read could be any pane's viewer, so the whole list is unread.
        if (!isPid(pid) || typeof session !== "string" || !session) return;
        sessionByPid.set(pid, session);
      }
    } catch {
      return;
    }
    if (this.stopped) return;
    const keys = new Set(transports.map(endpointKey));
    for (const key of this.held.keys()) if (!keys.has(key)) this.held.delete(key);
    await Promise.all(transports.map((transport) => this.passEndpoint(transport, sessionByPid).catch(() => {})));
  }

  private async passEndpoint(transport: HerdrTransport, sessionByPid: Map<number, string>): Promise<void> {
    const panes = await read(async () => {
      const listed = (await transport.request("pane.list", {}))["panes"];
      if (!Array.isArray(listed)) throw new Error("no panes");
      return listed.map((p): string => {
        const id = (p as { pane_id?: unknown } | null)?.pane_id;
        if (typeof id !== "string" || !id) throw new Error("pane without an id");
        return id;
      });
    });
    // An unreadable pane list keeps every held pane as it is, for the next sweep.
    if (!panes.ok || this.stopped) return;
    const key = endpointKey(transport);
    const held = this.held.get(key) ?? new Map<string, Held>();
    this.held.set(key, held);
    // A pane Herdr no longer lists took its agent state with it.
    const live = new Set(panes.value);
    for (const paneId of held.keys()) if (!live.has(paneId)) held.delete(paneId);

    for (const paneId of panes.value) {
      if (this.stopped) return;
      const pids = await read(async () => {
        const info = (await transport.request("pane.process_info", { pane_id: paneId }))["process_info"];
        const foreground = (info as { foreground_processes?: unknown } | null | undefined)?.foreground_processes;
        if (!Array.isArray(foreground)) throw new Error("no foreground processes");
        return foreground.map((p): number => {
          const pid = (p as { pid?: unknown } | null)?.pid;
          if (!isPid(pid)) throw new Error("process without a pid");
          return pid;
        });
      });
      // Unreadable processes prove nothing about the pane: its last-good state stays, with no release.
      if (!pids.ok) continue;
      if (this.stopped) return;
      const want = this.wanted(pids.value, sessionByPid);
      if (!want.ok) continue;
      await this.settle(transport, held, paneId, want.value);
    }
  }

  /** What a pane with these foreground pids should show: a community harness seat's agent and state, or nothing.
   *  Unread when a seat it views can't be resolved, since that seat may be the one already reported. */
  private wanted(pids: number[], sessionByPid: Map<number, string>): Reading<{ agent: string; state: HerdrAgentState } | null> {
    let want: { agent: string; state: HerdrAgentState } | null = null;
    for (const pid of pids) {
      const session = sessionByPid.get(pid);
      if (session === undefined) continue;
      let seat: HerdrSeatActivity;
      try { seat = this.resolve(session); } catch { return { ok: false }; }
      // A built-in runtime is Herdr's own to show; a session with no runtime isn't a known harness seat.
      if (!seat || !isCommunityHarnessRuntime(seat.runtime)) continue;
      want ??= { agent: seat.runtime, state: herdrAgentState(seat.activity) };
    }
    return { ok: true, value: want };
  }

  private async settle(
    transport: HerdrTransport, held: Map<string, Held>, paneId: string, want: { agent: string; state: HerdrAgentState } | null,
  ): Promise<void> {
    const had = held.get(paneId);
    if (had && had.agent !== want?.agent) {
      // The viewer left, or the pane now views another seat: what was reported for the old agent is withdrawn.
      try {
        await transport.request("pane.release_agent", { pane_id: paneId, source: HERDR_COMMUNITY_SOURCE, agent: had.agent, seq: this.seq() });
      } catch {
        return; // Still held; the next sweep tries the release again before anything else for this pane.
      }
      held.delete(paneId);
      if (this.stopped) return;
    }
    if (!want) return;
    const current = held.get(paneId);
    const now = this.now();
    if (current && current.state === want.state && now - current.acceptedAt < HERDR_STATUS_REPLAY_MS) return;
    try {
      await transport.request("pane.report_agent", {
        pane_id: paneId, source: HERDR_COMMUNITY_SOURCE, agent: want.agent, state: want.state, seq: this.seq(),
      });
      held.set(paneId, { agent: want.agent, state: want.state, acceptedAt: now });
    } catch {
      // Not accepted. An earlier state may still show, so the pane stays held (to be released later) but unsettled.
      if (current) current.state = null;
    }
  }

  /** A timestamp that only ever grows, so Herdr never drops a report as older than the one before it. */
  private seq(): number {
    this.lastSeq = Math.max(this.now(), this.lastSeq + 1);
    return this.lastSeq;
  }
}

const endpointKey = (transport: HerdrTransport): unknown => {
  const key = (transport as { key?: unknown }).key;
  return typeof key === "string" && key ? key : transport;
};

const isPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;

async function read<T>(fn: () => Promise<T>): Promise<Reading<T>> {
  try { return { ok: true, value: await fn() }; } catch { return { ok: false }; }
}
