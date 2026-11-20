// A seat launched for a community harness keeps that harness where the seat itself continues: a handover that launches
// its successor through the preset, a reconcile (re-link) of the seat's own session, and a bind onto the seat. A
// different occupant (a person's shell joined with attach --self, a discovered handover successor) is not classified as
// the harness. The harness is launch provenance, so it is kept only from the seat's own latest session and never
// invented from a runtime name. The previous conversation is never copied: nothing here observes which conversation an
// adopted pane holds.
//
// What these tests exercise: the real SessionRegistry, ClaimService, SelfAttachService, SeatHandoverService,
// SuccessorSessionLauncher and CommunityHarnessRuntimeAdapter over a migrated SQLite database, with presets read from
// a scratch folder. What is simulated: tmux (a stub adapter), the process table, and the harness's launcher (the stub
// writes the launch record a real launcher would). No harness process is started.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { PiCommunityRuntimeAdapter } from "../src/adapters/pi-community-runtime-adapter.js";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter, seatAdapter, withCommunityHarnessResolver } from "../src/adapters/community-harness-runtime-adapter.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { RuntimeAdapter, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Two harness names, so nothing here depends on one harness: an invented one, and the one the defect was found on.
const HARNESSES = ["synth-harness", "jcode"] as const;
const SEAT = "dev-impl@seat-rig";
const OLD_CONVERSATION = "chat-before";

interface SessionRecord {
  id: string; status: string; origin: string; agent_app: string | null; agent_runner: number | null;
  resume_type: string | null; resume_token: string | null; resume_provenance: string | null; resume_last_verified: string | null;
}

describe("a community harness's seat keeps its harness when its session row is replaced", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let presets: string;
  let results: string;
  const scratch: string[] = [];

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    presets = mkdtempSync(join(tmpdir(), "openrig-lifecycle-presets-"));
    results = mkdtempSync(join(tmpdir(), "openrig-lifecycle-results-"));
    scratch.push(presets, results);
  });

  afterEach(() => {
    db.close();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function installPreset(harness: string, extra = "launch_result: true\nresume: true\n"): void {
    writeFileSync(join(presets, `${harness}.yaml`), `format: 1\nname: ${harness}\ncommand: ${harness}-launch --serve\nmaintainer: Example Maintainer\nlimits: []\n${extra}`);
  }

  /** A seat with one running session. `launchedFor` records that session as launched for the harness, with a conversation
   *  its launcher reported; without it the seat only names the runtime (a free-text runtime, as a self-attach leaves it). */
  function seedSeat(runtime: string, opts: { launchedFor?: string; runner?: boolean; bound?: boolean } = {}) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime, cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    if (opts.bound !== false) sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%0" });
    if (opts.launchedFor) {
      sessionRegistry.recordCommunityHarnessSelection(session.id, opts.launchedFor, opts.runner ?? false);
      sessionRegistry.recordLauncherReportedToken(session.id, `community:${opts.launchedFor}`, OLD_CONVERSATION);
    }
    return { rig, node, sessionId: session.id };
  }

  function sessions(nodeId: string): SessionRecord[] {
    return db.prepare(`SELECT id, status, origin, agent_app, agent_runner, resume_type, resume_token, resume_provenance, resume_last_verified
      FROM sessions WHERE node_id = ? ORDER BY id`).all(nodeId) as SessionRecord[];
  }
  const latest = (nodeId: string): SessionRecord => sessions(nodeId).at(-1)!;

  function durableRows(): string {
    const tables = ["nodes", "sessions", "bindings", "discovered_sessions", "events", "occupant_tenures"] as const;
    return JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])));
  }

  /** The daemon's adapter map: built-ins, and a community harness's adapter while its preset is installed. `launcher`
   *  is the stand-in for the harness's own launcher: what it writes to its launch record, or nothing. */
  function adapters(launcher: (harness: string, attempt: string) => unknown = (harness, attempt) => ({ format: 1, attempt, harness, nativeRef: "chat-new", producer: "stub-launcher 1.0" })) {
    const sendShellCommand = vi.fn(async (_session: string, command: string) => {
      const file = /OPENRIG_LAUNCH_RESULT='([^']+)'/.exec(command)?.[1];
      const attempt = /OPENRIG_LAUNCH_ATTEMPT=(\S+)/.exec(command)?.[1];
      const harness = /(\S+)-launch --serve/.exec(command)?.[1];
      const record = file && attempt && harness ? launcher(harness, attempt) : undefined;
      if (file && record !== undefined) writeFileSync(file, JSON.stringify(record));
      return { ok: true as const };
    });
    const builtIns: Record<string, RuntimeAdapter> = { codex: { runtime: "codex" } as unknown as RuntimeAdapter };
    const map = withCommunityHarnessResolver(builtIns, {
      presetsDir: () => presets, launchResultRoot: () => results, launchResultWait: { timeoutMs: 40, intervalMs: 5 },
      tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
    });
    return { map, sendShellCommand };
  }

  /** What every relaunch path asks: the adapter for this seat, from its runtime and its latest session's harness. */
  function relaunchAdapter(nodeId: string, map = adapters().map): RuntimeAdapter | undefined {
    const node = db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(nodeId) as { runtime: string | null };
    return seatAdapter(map, node.runtime, latest(nodeId).agent_app);
  }

  /** The registry write a reconcile, a bind and a launched handover make: the seat itself continues. */
  const relink = (nodeId: string) => sessionRegistry.registerClaimedSession(nodeId, SEAT, "adopt", undefined, { keepCommunityHarness: true });

  describe("registerClaimedSession (every re-link path's one writer)", () => {
    it("records no harness unless the caller says the seat continues: a different occupant isn't classified as the harness", () => {
      installPreset("synth-harness");
      const { node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      sessionRegistry.markSuperseded(sessionId);

      const claimed = sessionRegistry.registerClaimedSession(node.id, SEAT);

      expect(claimed.communityHarness).toBeUndefined();
      expect(latest(node.id)).toMatchObject({ agent_app: null, agent_runner: null, resume_token: null });
    });

    it.each(HARNESSES)("keeps %s on the new row, with no runner and no conversation, so the seat's adapter still resolves", harness => {
      installPreset(harness);
      const { node, sessionId } = seedSeat(harness, { launchedFor: harness, runner: true });
      sessionRegistry.markSuperseded(sessionId);

      const claimed = relink(node.id);

      expect(claimed.communityHarness).toBe(harness);
      expect(latest(node.id)).toMatchObject({ id: claimed.id, origin: "claimed", agent_app: harness, agent_runner: 0,
        resume_type: null, resume_token: null, resume_provenance: null, resume_last_verified: null });
      // The retiring row is left as it was: its conversation stays its own.
      expect(sessions(node.id)[0]).toMatchObject({ status: "superseded", agent_app: harness, agent_runner: 1, resume_token: OLD_CONVERSATION });
      expect(relaunchAdapter(node.id)).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
    });

    it("keeps the harness across repeated re-links (the three reconciles that broke each seat)", () => {
      installPreset("jcode");
      const { node } = seedSeat("jcode", { launchedFor: "jcode" });
      for (let i = 0; i < 3; i++) {
        for (const row of sessions(node.id).filter(row => row.status === "running")) sessionRegistry.markSuperseded(row.id);
        relink(node.id);
      }
      expect(sessions(node.id).map(row => row.agent_app)).toEqual(["jcode", "jcode", "jcode", "jcode"]);
      expect(sessions(node.id).slice(1).every(row => row.resume_token === null)).toBe(true);
      expect(relaunchAdapter(node.id)).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
    });

    it.each(HARNESSES)("does not promote a free-text %s runtime: a seat whose latest session recorded no harness gets none", harness => {
      installPreset(harness);
      const { node, sessionId } = seedSeat(harness);
      sessionRegistry.markSuperseded(sessionId);

      const claimed = relink(node.id);

      expect(claimed.communityHarness).toBeUndefined();
      expect(latest(node.id)).toMatchObject({ agent_app: null, agent_runner: null, resume_token: null });
      // The installed preset alone selects nothing: the existing refusal stands.
      expect(relaunchAdapter(node.id)).toBeUndefined();
    });

    it("gives a seat with no session at all no harness", () => {
      installPreset("synth-harness");
      const rig = rigRepo.createRig("seat-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "synth-harness", cwd: "/project" });
      relink(node.id);
      expect(latest(node.id).agent_app).toBeNull();
      expect(relaunchAdapter(node.id)).toBeUndefined();
    });

    it("reads only the latest session: an older harness row doesn't restore one a later row lost", () => {
      installPreset("jcode");
      const { node, sessionId } = seedSeat("jcode", { launchedFor: "jcode" });
      sessionRegistry.markSuperseded(sessionId);
      // The state the defect left behind: a claimed row with no harness after the launched one.
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, origin, startup_status) VALUES ('zzzz-lost', ?, ?, 'superseded', 'claimed', 'ready')")
        .run(node.id, SEAT);

      relink(node.id);

      expect(latest(node.id).agent_app).toBeNull();
    });

    it.each([["a built-in runtime", "codex"], ["another community harness", "other-harness"]])(
      "drops the harness once the seat's runtime is %s", (_case, runtime) => {
        installPreset("synth-harness");
        installPreset("other-harness");
        const { node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
        sessionRegistry.markSuperseded(sessionId);
        db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, node.id);

        relink(node.id);

        expect(latest(node.id).agent_app).toBeNull();
      });

    it("writes the harness with the row, so a rolled-back transaction leaves neither", () => {
      installPreset("synth-harness");
      const { node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const before = durableRows();
      const tx = db.transaction(() => {
        sessionRegistry.markSuperseded(sessionId);
        relink(node.id);
        throw new Error("later step failed");
      });
      expect(() => tx()).toThrow("later step failed");
      expect(durableRows()).toBe(before);
      expect(sessions(node.id)).toHaveLength(1);
    });
  });

  describe("rig reconcile-session", () => {
    const started = "Sat Jan  1 12:00:00 2000";
    function claimService(opts: { paneCommand?: string; rows?: NativeProcessRow[] } = {}) {
      const calls: string[] = [];
      const record = <T>(name: string, value: T) => vi.fn(async () => { calls.push(name); return value; });
      const tmuxAdapter = {
        hasSession: record("hasSession", true),
        listPanes: record("listPanes", [{ id: "%5", index: 0, cwd: "/project", width: 80, height: 24, active: true }]),
        getPaneCommand: record("getPaneCommand", opts.paneCommand ?? "node"),
        getPanePid: record("getPanePid", 900),
        setSessionOption: record("setSessionOption", { ok: true as const }),
        getSessionOption: record("getSessionOption", null),
        startPipePane: record("startPipePane", { ok: true as const }),
        sendText: record("sendText", { ok: true as const }),
        sendKeys: record("sendKeys", { ok: true as const }),
        killSession: record("killSession", { ok: true as const }),
      } as unknown as TmuxAdapter;
      const service = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter,
        listProcesses: () => opts.rows ?? [] });
      return { service, calls };
    }

    it.each(HARNESSES)("re-links a %s seat with its harness kept and no conversation copied, and says so", async harness => {
      installPreset(harness);
      const { node, sessionId } = seedSeat(harness, { launchedFor: harness, runner: true });
      const { service, calls } = claimService();

      const result = await service.reconcileSession({ sessionName: SEAT });

      expect(result).toMatchObject({ ok: true, result: { continuity: "unverified", resumeMetadata: { status: "missing" } } });
      if (!result.ok) return;
      expect(result.result.resumeMetadata?.guidance).toContain(`keeps community harness "${harness}"`);
      expect(result.result.resumeMetadata?.guidance).toContain("was not copied");
      // The fresh launch that records a new conversation needs the adopted session released first, and says so.
      expect(result.result.resumeMetadata?.guidance).toMatch(/rig unclaim 'dev-impl@seat-rig', end the harness process and its tmux session, then rig seat launch 'dev-impl@seat-rig' --fresh/);
      expect(result.result.resumeMetadata?.guidance).not.toContain("set-resume-token");
      expect(sessions(node.id)).toHaveLength(2);
      expect(sessions(node.id)[0]).toMatchObject({ id: sessionId, status: "superseded", resume_token: OLD_CONVERSATION });
      expect(latest(node.id)).toMatchObject({ id: result.result.sessionId, status: "running", origin: "claimed", agent_app: harness,
        agent_runner: 0, resume_type: null, resume_token: null, resume_provenance: null });
      // The seat can be launched again: the defect left it with no adapter here.
      expect(relaunchAdapter(node.id)).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
      // Still a no-launch, no-input reconcile.
      expect(calls).not.toContain("sendText");
      expect(calls).not.toContain("sendKeys");
      expect(calls).not.toContain("killSession");
    });

    it("does not copy the previous conversation from a process started with --resume: its command can be stale", async () => {
      installPreset("jcode");
      const { node } = seedSeat("jcode", { launchedFor: "jcode" });
      // The pane's process was started to reopen the recorded conversation, then switched to another inside its own UI.
      // Its command still names the old one, so the command is not evidence of the conversation it holds now.
      const rows: NativeProcessRow[] = [
        { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: started },
        { pid: 901, ppid: 900, command: `jcode --resume ${OLD_CONVERSATION} --no-update`, argv: ["jcode", "--resume", OLD_CONVERSATION, "--no-update"],
          pgid: 901, tpgid: 901, executableName: "jcode", startedAt: started },
      ];
      const { service } = claimService({ paneCommand: "jcode", rows });

      const result = await service.reconcileSession({ sessionName: SEAT });

      expect(result).toMatchObject({ ok: true, result: { continuity: "unverified", resumeMetadata: { status: "missing" } } });
      expect(latest(node.id)).toMatchObject({ agent_app: "jcode", resume_type: null, resume_token: null, resume_provenance: null, resume_last_verified: null });
    });

    it("re-links a pane at a bare shell with the harness kept, and reports that the harness isn't shown to be running", async () => {
      installPreset("synth-harness");
      const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const { service } = claimService({ paneCommand: "zsh" });

      const result = await service.reconcileSession({ sessionName: SEAT });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.projectionDrift).toContain(`runtime unverified: the pane is at a shell ("zsh"), so community harness "synth-harness" isn't shown to be running`);
      expect(latest(node.id)).toMatchObject({ agent_app: "synth-harness", resume_token: null });
    });

    it.each([["codex", "codex"], ["claude", "claude-code"]] as const)(
      "reports a harness seat whose pane is proven to run %s as drift: re-linked, harness kept, nothing recorded about that process", async (executable, runtime) => {
        installPreset("synth-harness");
        const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
        const rows: NativeProcessRow[] = [
          { pid: 900, ppid: 1, command: "/bin/sh /tmp/launch.sh", pgid: 900, tpgid: 901, executableName: "sh", startedAt: started },
          { pid: 901, ppid: 900, command: `${executable} --resume 11111111-2222-3333-4444-555555555555`,
            ...(executable === "codex" ? { argv: ["codex", "resume", "11111111-2222-3333-4444-555555555555"] } : {}),
            pgid: 901, tpgid: 901, executableName: executable, startedAt: started },
        ];
        const { service } = claimService({ paneCommand: executable, rows });

        const result = await service.reconcileSession({ sessionName: SEAT });

        expect(result).toMatchObject({ ok: true, result: { continuity: "unverified", resumeMetadata: { status: "missing" } } });
        if (!result.ok) return;
        expect(result.result.projectionDrift.join("\n")).toContain(`runtime mismatch: the pane is running ${runtime}, but this seat was launched for community harness "synth-harness"`);
        // The other runtime's conversation is not taken as this harness's, and the old one is not copied.
        expect(latest(node.id)).toMatchObject({ agent_app: "synth-harness", agent_runner: 0, resume_type: null, resume_token: null, resume_provenance: null });
      });

    it("does not report a mismatch on the pane command alone: an unproven 'codex' name is not evidence", async () => {
      installPreset("synth-harness");
      const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const { service } = claimService({ paneCommand: "codex", rows: [] });
      const result = await service.reconcileSession({ sessionName: SEAT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.result.projectionDrift.join("\n")).not.toContain("runtime mismatch");
      expect(latest(node.id).agent_app).toBe("synth-harness");
    });

    it("leaves a free-text runtime's seat as it was: re-linked, no harness, no adapter", async () => {
      installPreset("synth-harness");
      const { node } = seedSeat("synth-harness");
      const { service } = claimService();

      const result = await service.reconcileSession({ sessionName: SEAT });

      expect(result.ok).toBe(true);
      expect(latest(node.id)).toMatchObject({ origin: "claimed", agent_app: null, agent_runner: null });
      expect(relaunchAdapter(node.id)).toBeUndefined();
    });

    it("rolls the whole re-link back when a later step of its transaction fails", async () => {
      installPreset("synth-harness");
      const { node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const { service } = claimService();
      const before = durableRows();
      vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("event store unavailable"); });

      const result = await service.reconcileSession({ sessionName: SEAT });

      expect(result).toMatchObject({ ok: false, code: "reconcile_error" });
      expect(durableRows()).toBe(before);
      expect(sessions(node.id)).toEqual([expect.objectContaining({ id: sessionId, status: "running", agent_app: "synth-harness", resume_token: OLD_CONVERSATION })]);
    });
  });

  describe("claim (bind) and self-attach", () => {
    it("a bind onto a harness seat that lost its binding keeps the harness and copies no conversation", async () => {
      installPreset("synth-harness");
      const { rig, node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness", bound: false });
      sessionRegistry.markDetached(sessionId);
      const discovered = discoveryRepo.upsertDiscoveredSession({ tmuxSession: "organic-session", tmuxPane: "%3", runtimeHint: "unknown", confidence: "high", cwd: "/project" });
      const tmuxAdapter = { hasSession: vi.fn(async () => true), setSessionOption: vi.fn(async () => ({ ok: true as const })),
        getSessionOption: vi.fn(async () => null), startPipePane: vi.fn(async () => ({ ok: true as const })),
        probeSession: vi.fn(async () => ({ state: "present" })), capturePaneContent: vi.fn(async () => ""),
        sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
      const service = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter });

      const result = await service.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.impl" });

      expect(result.ok).toBe(true);
      expect(latest(node.id)).toMatchObject({ origin: "claimed", agent_app: "synth-harness", agent_runner: 0, resume_type: null, resume_token: null });
      expect(relaunchAdapter(node.id)).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
    });

    it("a bind's rollback leaves no session row and no harness", async () => {
      installPreset("synth-harness");
      const { rig, node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness", bound: false });
      sessionRegistry.markDetached(sessionId);
      const discovered = discoveryRepo.upsertDiscoveredSession({ tmuxSession: "organic-session", tmuxPane: "%3", runtimeHint: "unknown", confidence: "high", cwd: "/project" });
      const service = new ClaimService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus });
      const before = durableRows();
      vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("event store unavailable"); });

      const result = await service.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.impl" });

      expect(result).toMatchObject({ ok: false, code: "claim_error" });
      expect(durableRows()).toBe(before);
      expect(sessions(node.id)).toHaveLength(1);
    });

    function selfAttach() {
      return new SelfAttachService({ db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus });
    }

    it("a self-attach onto a harness seat is a different occupant: it isn't classified as the harness, and no conversation is copied", async () => {
      installPreset("synth-harness");
      const { rig, node, sessionId } = seedSeat("synth-harness", { launchedFor: "synth-harness", bound: false });
      sessionRegistry.markDetached(sessionId);

      const result = await selfAttach().attachToNode({ rigId: rig.id, logicalId: "dev.impl", runtime: "synth-harness",
        context: { attachmentType: "tmux", tmuxSession: "person-shell" } });

      expect(result.ok).toBe(true);
      expect(latest(node.id)).toMatchObject({ origin: "claimed", agent_app: null, agent_runner: null, resume_token: null });
    });

    it("a self-attach that only declares the runtime's name selects no preset, on an existing seat or a new member", async () => {
      installPreset("synth-harness");
      const rig = rigRepo.createRig("seat-rig");
      const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
      const existing = rigRepo.addNode(rig.id, "dev.impl", { runtime: "synth-harness", podId: pod.id });
      const service = selfAttach();

      expect((await service.attachToNode({ rigId: rig.id, logicalId: "dev.impl", runtime: "synth-harness",
        context: { attachmentType: "tmux", tmuxSession: "person-shell" } })).ok).toBe(true);
      const created = await service.attachToPod({ rigId: rig.id, podNamespace: "dev", memberName: "guest", runtime: "synth-harness",
        context: { attachmentType: "tmux", tmuxSession: "guest-shell" } });
      expect(created.ok).toBe(true);

      expect(latest(existing.id).agent_app).toBeNull();
      expect(relaunchAdapter(existing.id)).toBeUndefined();
      if (created.ok) {
        expect(latest(created.nodeId).agent_app).toBeNull();
        expect(relaunchAdapter(created.nodeId)).toBeUndefined();
      }
    });
  });

  describe("rig handover", () => {
    let listPanes: ReturnType<typeof vi.fn>;
    let respawnPane: ReturnType<typeof vi.fn>;
    let signalPaneProcess: ReturnType<typeof vi.fn>;
    let killSession: ReturnType<typeof vi.fn>;
    let setRemainOnExit: ReturnType<typeof vi.fn>;
    let sendText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
      respawnPane = vi.fn(async () => ({ ok: true }));
      signalPaneProcess = vi.fn(async () => ({ ok: true }));
      killSession = vi.fn(async () => ({ ok: true }));
      setRemainOnExit = vi.fn(async () => ({ ok: true }));
      sendText = vi.fn(async () => ({ ok: true }));
    });

    function handoverService(map: Record<string, RuntimeAdapter>): SeatHandoverService {
      const tmuxAdapter = { hasSession: vi.fn(async () => true), createSession: vi.fn(async () => ({ ok: true })), listPanes, killSession,
        respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead: vi.fn(async () => true), sendText,
        sendKeys: vi.fn(async () => ({ ok: true })), capturePaneScreen: vi.fn(async () => "predecessor screen tail"),
        getDefaultShell: vi.fn(async () => "/bin/zsh"), getPaneCommand: vi.fn(async () => "zsh") } as unknown as TmuxAdapter;
      return new SeatHandoverService({ db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter,
        now: () => new Date("2026-04-24T18:30:00.000Z"), runtimeAdapters: map,
        occupantInvalidator: { invalidateRetiringOccupant: vi.fn() }, activityOracle: { declareOccupantSwap: vi.fn() },
        predecessorRecapResolver: (() => ({ unavailableReason: "test: no record" })) as never,
        readinessTimeoutMs: 50, sleep: async () => {} });
    }

    function expectIncumbentUntouched(): void {
      expect(signalPaneProcess).not.toHaveBeenCalled();
      expect(respawnPane).not.toHaveBeenCalled();
      expect(setRemainOnExit).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    }

    /** The dry run and the real run of the same handover: one refusal, and nothing changed by either. */
    async function refusedBothWays(service: SeatHandoverService, source?: string) {
      const before = durableRows();
      const dryRun = await service.handover({ seatRef: SEAT, reason: "context-wall", dryRun: true, ...(source ? { source } : {}) });
      const real = await service.handover({ seatRef: SEAT, reason: "context-wall", ...(source ? { source } : {}) });
      expect(dryRun).toMatchObject({ ok: false, code: "successor_runtime_unsupported" });
      expect(real).toEqual(dryRun);
      expect(durableRows()).toBe(before);
      expectIncumbentUntouched();
      if (dryRun.ok) throw new Error("unreachable");
      expect(dryRun.message).toContain("Nothing was changed: the current occupant is still running");
      return dryRun;
    }

    it.each(HARNESSES)("hands a %s seat over: the successor is launched through its preset and records its harness, its runner and its own conversation", async harness => {
      installPreset(harness);
      const { node, sessionId } = seedSeat(harness, { launchedFor: harness });
      const { map, sendShellCommand } = adapters();
      const service = handoverService(map);

      const plan = await service.handover({ seatRef: SEAT, reason: "context-wall", dryRun: true });
      expect(plan).toMatchObject({ ok: true, plan: { willMutate: false, runtimeAdapter: { status: "resolved_unverified" } } });
      expectIncumbentUntouched();

      const result = await service.handover({ seatRef: SEAT, reason: "context-wall" });

      expect(result).toMatchObject({ ok: true, result: { mutated: true, sideEffects: { departingProcess: "ended-graceful" } } });
      expect(signalPaneProcess).toHaveBeenCalledWith("%9", "TERM");
      expect(sendShellCommand).toHaveBeenCalledTimes(1);
      expect(sendShellCommand.mock.calls[0]![1]).toContain(`${harness}-launch --serve`);
      expect(sessions(node.id)).toHaveLength(2);
      expect(sessions(node.id)[0]).toMatchObject({ id: sessionId, status: "superseded", agent_app: harness, resume_token: OLD_CONVERSATION });
      // The successor's conversation is the one its own launch reported, unverified; the retiring one is not copied.
      expect(latest(node.id)).toMatchObject({ status: "running", origin: "launched", agent_app: harness, agent_runner: 0,
        resume_type: `community:${harness}`, resume_token: "chat-new", resume_provenance: "launcher", resume_last_verified: null });
      expect(relaunchAdapter(node.id, map)).toBeInstanceOf(CommunityHarnessRuntimeAdapter);
    });

    it.each(["fresh", "rebuild", `fork:${SEAT}`])("refuses contained OpenShell %s handover without touching viewer or guest", async source => {
      seedSeat("openshell-claude", { launchedFor: "openshell-claude" });
      const containedLaunch = vi.fn();
      const adapter = new CommunityHarnessRuntimeAdapter("openshell-claude", {
        tmux: {} as TmuxAdapter,
        environmentStartup: { launch: containedLaunch } as never,
      });
      // Normal contained startup remains available. Only the unsupported handover transition is blocked.
      expect(await adapter.preflightLaunch({} as NodeBinding)).toEqual({ ok: true });
      const result = await refusedBothWays(handoverService({ "openshell-claude": adapter }), source);
      expect(result.message).toContain("OpenShell handover is unsupported");
      expect(containedLaunch).not.toHaveBeenCalled();
    });

    it.each(["fresh", "rebuild"])("refuses wrapped hosted Pi %s handover before cutover", async source => {
      const adapter = hostedPiAdapter("/state/conversation.jsonl");
      const { node } = seedSeat("future-pi", { launchedFor: "future-pi" });
      db.prepare("UPDATE nodes SET launch_wrapper = ? WHERE id = ?")
        .run(JSON.stringify(["/usr/bin/env"]), node.id);
      const result = await refusedBothWays(handoverService({ "future-pi": adapter }), source);
      expect(result.message).toContain("launch_wrapper support unavailable");
      expect(adapter.launchHarness).not.toHaveBeenCalled();
    });

    function hostedPiAdapter(token: string, resumeType = "community:future-pi"): PiCommunityRuntimeAdapter {
      installPreset("future-pi", "protocol: pi-rpc\n");
      const found = loadCommunityHarnessPreset("future-pi", presets);
      if (!found.ok) throw new Error(found.message);
      const adapter = new PiCommunityRuntimeAdapter("future-pi", found.preset, {
        tmux: {} as TmuxAdapter, stateRoot: "/state", runnerEntryPath: "/runner.js",
        fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {} },
      });
      // The actual hosted adapter class determines protocol provenance. Only
      // the native runner boundary is simulated, as with opaque launch tests.
      vi.spyOn(adapter, "launchHarness").mockResolvedValue({ ok: true, resumeToken: token, resumeType });
      vi.spyOn(adapter, "checkReady").mockResolvedValue({ ready: true });
      return adapter;
    }

    it.each([
      "/state/dev-impl@seat-rig/conversation.jsonl",
      `/state/${"a".repeat(240)}/${"b".repeat(240)}/${"c".repeat(80)}.jsonl`,
    ])("keeps a hosted Pi successor's validated session-file token (%s)", async token => {
      const adapter = hostedPiAdapter(token);
      const { node } = seedSeat("future-pi", { launchedFor: "future-pi" });
      expect(await handoverService({ "future-pi": adapter }).handover({ seatRef: SEAT, source: "fresh", reason: "hosted runner" }))
        .toMatchObject({ ok: true });
      expect(latest(node.id)).toMatchObject({ agent_app: "future-pi", agent_runner: 2,
        resume_type: "community:future-pi", resume_token: token, resume_provenance: "scrape",
        resume_last_verified: expect.any(String) });
    });

    it.each([
      ["relative.jsonl", "community:future-pi"],
      ["/state/../conversation.jsonl", "community:future-pi"],
      ["/state/not-session.txt", "community:future-pi"],
      ["/state/conversation.jsonl", "community:another-harness"],
    ])("drops a hosted Pi launch's malformed or mismatched session token", async (token, type) => {
      const adapter = hostedPiAdapter(token!, type!);
      const { node } = seedSeat("future-pi", { launchedFor: "future-pi" });
      expect(await handoverService({ "future-pi": adapter }).handover({ seatRef: SEAT, source: "fresh", reason: "hosted runner" }))
        .toMatchObject({ ok: true });
      expect(latest(node.id)).toMatchObject({ agent_app: "future-pi", agent_runner: 2,
        resume_type: null, resume_token: null, resume_provenance: null, resume_last_verified: null });
    });

    it("hands the same seat over again: the successor of a handover is still a harness seat", async () => {
      installPreset("jcode");
      const { node } = seedSeat("jcode", { launchedFor: "jcode" });
      const service = handoverService(adapters().map);

      expect((await service.handover({ seatRef: SEAT, reason: "first" })).ok).toBe(true);
      expect(await service.handover({ seatRef: SEAT, reason: "second", dryRun: true })).toMatchObject({ ok: true });
      expect((await service.handover({ seatRef: SEAT, reason: "second" })).ok).toBe(true);

      expect(sessions(node.id).map(row => [row.status, row.agent_app])).toEqual([["superseded", "jcode"], ["superseded", "jcode"], ["running", "jcode"]]);
    });

    it("hands over a seat whose preset runs a runner and takes no launch wrapper (the jcode preset's shape), and records the runner", async () => {
      installPreset("jcode", "launch_result: true\nresume: true\nrunner: true\nfirst_input: true\npasses_model: true\n");
      const { node } = seedSeat("jcode", { launchedFor: "jcode", runner: true });
      const service = handoverService(adapters().map);

      expect(await service.handover({ seatRef: SEAT, reason: "context-wall", dryRun: true })).toMatchObject({ ok: true });
      const result = await service.handover({ seatRef: SEAT, reason: "context-wall" });

      expect(result).toMatchObject({ ok: true });
      expect(latest(node.id)).toMatchObject({ origin: "launched", agent_app: "jcode", agent_runner: 1, resume_token: "chat-new", resume_provenance: "launcher" });
    });

    it("records a conversation OpenRig named as passed, not reported", async () => {
      installPreset("synth-harness", "names_conversation: true\nresume: true\n");
      const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const service = handoverService(adapters().map);

      expect((await service.handover({ seatRef: SEAT, reason: "context-wall" })).ok).toBe(true);

      const row = latest(node.id);
      expect(row).toMatchObject({ agent_app: "synth-harness", resume_type: "community:synth-harness", resume_provenance: "passed", resume_last_verified: null });
      expect(row.resume_token).not.toBe(OLD_CONVERSATION);
    });

    it("keeps the harness and records no conversation when the launcher reports none", async () => {
      installPreset("synth-harness");
      const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const service = handoverService(adapters(() => undefined).map);

      expect((await service.handover({ seatRef: SEAT, reason: "context-wall" })).ok).toBe(true);

      expect(latest(node.id)).toMatchObject({ origin: "launched", agent_app: "synth-harness", resume_type: null, resume_token: null, resume_provenance: null });
    });

    it.each([
      ["another harness's type", { resumeToken: "chat-x", resumeType: "community:other-harness", resumeProvenance: "launcher" }],
      ["a built-in runtime's type", { resumeToken: "11111111-2222-3333-4444-555555555555", resumeType: "codex_id", resumeProvenance: "launcher" }],
      ["no stated source", { resumeToken: "chat-x", resumeType: "community:synth-harness" }],
      ["a token with a space", { resumeToken: "chat x", resumeType: "community:synth-harness", resumeProvenance: "launcher" }],
      ["a token with a control character", { resumeToken: "chat\u0007x", resumeType: "community:synth-harness", resumeProvenance: "launcher" }],
      ["a token over the length limit", { resumeToken: "c".repeat(513), resumeType: "community:synth-harness", resumeProvenance: "launcher" }],
    ])("drops a launch token with %s: the successor keeps its harness and records no conversation", async (_case, launched) => {
      installPreset("synth-harness");
      const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const { map } = adapters();
      const real = seatAdapter(map, "synth-harness", "synth-harness") as CommunityHarnessRuntimeAdapter;
      // The harness's own adapter, whose launch answers with a token the commit must not store.
      vi.spyOn(real, "launchHarness").mockResolvedValue({ ok: true, ...launched } as never);
      const withLaunch = { ...map, "synth-harness": real } as Record<string, RuntimeAdapter>;

      expect((await handoverService(withLaunch).handover({ seatRef: SEAT, reason: "context-wall" })).ok).toBe(true);

      expect(latest(node.id)).toMatchObject({ origin: "launched", agent_app: "synth-harness",
        resume_type: null, resume_token: null, resume_provenance: null, resume_last_verified: null });
    });

    it.each(HARNESSES)("refuses a %s seat whose preset isn't installed, in the dry run and the real run alike, before the incumbent is stopped", async harness => {
      seedSeat(harness, { launchedFor: harness });
      const refusal = await refusedBothWays(handoverService(adapters().map));
      expect(refusal.message).toContain(`Community harness "${harness}" has no usable preset installed`);
    });

    it("refuses a seat whose preset is no longer usable", async () => {
      writeFileSync(join(presets, "synth-harness.yaml"), "format: 1\nname: synth-harness\ncommand: a | b\nmaintainer: x\nlimits: []\n");
      seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const refusal = await refusedBothWays(handoverService(adapters().map));
      expect(refusal.message).toContain("no usable preset installed");
    });

    it("refuses a free-text runtime's seat even with the preset installed: a name alone selects no adapter", async () => {
      installPreset("synth-harness");
      seedSeat("synth-harness");
      const refusal = await refusedBothWays(handoverService(adapters().map));
      expect(refusal.message).toContain(`doesn't record community harness "synth-harness"`);
    });

    it("refuses a built-in runtime with no adapter the same way", async () => {
      seedSeat("codex");
      const refusal = await refusedBothWays(handoverService({}));
      expect(refusal.message).toContain(`No runtime adapter for "codex"`);
    });

    it("refuses a fork of a launch-only harness before the incumbent is stopped", async () => {
      installPreset("synth-harness");
      seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const refusal = await refusedBothWays(handoverService(adapters().map), `fork:${SEAT}`);
      expect(refusal.message).toContain(`Fork is unsupported: community harness "synth-harness" is launch-only`);
    });

    it("refuses a seat launch wrapper its runner preset can't apply, which the launch itself would refuse after the stop", async () => {
      installPreset("synth-harness", "launch_result: true\nrunner: true\n");
      const { node } = seedSeat("synth-harness", { launchedFor: "synth-harness", runner: true });
      db.prepare("UPDATE nodes SET launch_wrapper = ? WHERE id = ?").run(JSON.stringify(["/usr/bin/env"]), node.id);
      const refusal = await refusedBothWays(handoverService(adapters().map));
      expect(refusal.message).toContain("launch_wrapper");
    });

    it("answers the refusal as a conflict over HTTP, for the dry run and the real run", async () => {
      seedSeat("synth-harness", { launchedFor: "synth-harness" });
      const { app } = createTestApp(db);
      const before = durableRows();
      for (const dryRun of [true, false]) {
        const res = await app.request(`/api/seat/handover/${encodeURIComponent(SEAT)}`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "context-wall", dryRun }) });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, code: "successor_runtime_unsupported" });
      }
      expect(durableRows()).toBe(before);
    });
  });

  describe("the community adapter's launch check", () => {
    const binding = { tmuxSession: SEAT } as NodeBinding;
    function adapter(harness: string, deps: Partial<ConstructorParameters<typeof CommunityHarnessRuntimeAdapter>[1]> = {}) {
      return new CommunityHarnessRuntimeAdapter(harness, { presetsDir: () => presets,
        tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand: vi.fn(async () => ({ ok: true as const })) }, ...deps });
    }

    it("passes a runner preset on a seat with no launch wrapper", async () => {
      installPreset("jcode", "launch_result: true\nrunner: true\n");
      expect(await adapter("jcode").preflightLaunch(binding)).toEqual({ ok: true });
    });

    it("refuses what the launch refuses for a seat launch wrapper", async () => {
      installPreset("jcode", "launch_result: true\nrunner: true\n");
      const wrapped = { ...binding, launchWrapper: ["/usr/bin/env"] } as NodeBinding;
      expect(await adapter("jcode").preflightLaunch(wrapped)).toEqual({ ok: false, error: "launch_wrapper unavailable; no agent started." });
      const withEnvironment = adapter("jcode", { seatLaunchEnvironment: { command: vi.fn(), resolveLaunchWrapper: vi.fn() } as never });
      expect(await withEnvironment.preflightLaunch(wrapped)).toMatchObject({ ok: false, error: expect.stringContaining("launch_wrapper unsupported") });
    });

    it("refuses a preset that isn't installed", async () => {
      expect(await adapter("synth-harness").preflightLaunch(binding)).toMatchObject({ ok: false });
    });
  });
});
