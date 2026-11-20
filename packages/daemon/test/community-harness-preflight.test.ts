import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(failure: string) {
  const dir = mkdtempSync(join(tmpdir(), "community-preflight-"));
  scratch.push(dir);
  writeFileSync(join(dir, "synth.yaml"), "format: 1\nname: synth\ncommand: synth-launch\nmaintainer: Example\nlimits: []\n");
  const executable = join(dir, "wrapper");
  writeFileSync(executable, "#!/bin/sh\nexec \"$@\"\n");
  chmodSync(executable, failure === "not executable" ? 0o644 : 0o755);
  const wrapper = [failure === "missing executable" ? "missing-wrapper" : "wrapper", "--"];
  const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
  const tmux = { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand };
  const environment = new SeatLaunchEnvironment(tmux as unknown as TmuxAdapter,
    { PATH: failure === "missing PATH" ? "" : dir }, dir);
  const resolveLaunchWrapper = vi.spyOn(environment, "resolveLaunchWrapper");
  const adapter = new CommunityHarnessRuntimeAdapter("synth", { tmux, presetsDir: () => dir, seatLaunchEnvironment: environment });
  return { adapter, wrapper, resolveLaunchWrapper, sendShellCommand };
}

const failures = ["missing executable", "not executable", "missing PATH"];
describe("community harness launch-wrapper preflight", () => {
  it.each(failures)("matches launch refusal for %s", async failure => {
    const { adapter, wrapper, resolveLaunchWrapper, sendShellCommand } = fixture(failure);
    const binding = { tmuxSession: "dev@rig", launchWrapper: wrapper } as NodeBinding;
    const result = await adapter.preflightLaunch(binding);
    expect(result).toEqual({ ok: false, error: "launch_wrapper unavailable; no agent started." });
    expect(await adapter.launchHarness(binding, { name: "dev@rig" })).toEqual(result);
    expect(resolveLaunchWrapper).toHaveBeenCalledWith(wrapper);
    expect(sendShellCommand).not.toHaveBeenCalled();
  });

  it("resolves supported wrappers but leaves unwrapped seats alone", async () => {
    const { adapter, wrapper, resolveLaunchWrapper } = fixture("valid");
    expect(await adapter.preflightLaunch({ launchWrapper: wrapper } as NodeBinding)).toEqual({ ok: true });
    expect(resolveLaunchWrapper).toHaveReturnedWith([expect.stringContaining("/wrapper"), "--"]);
    resolveLaunchWrapper.mockClear();
    expect(await adapter.preflightLaunch({} as NodeBinding)).toEqual({ ok: true });
    expect(resolveLaunchWrapper).not.toHaveBeenCalled();
  });

  it.each(failures)("refuses preview and real handover before stopping incumbent for %s", async failure => {
    const { adapter, wrapper, sendShellCommand } = fixture(failure);
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const rig = rigRepo.createRig("seat-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "synth", cwd: "/project" });
      const seatRef = "dev-impl@seat-rig";
      const session = sessionRegistry.registerSession(node.id, seatRef);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: seatRef, tmuxPane: "%0" });
      sessionRegistry.recordCommunityHarnessSelection(session.id, "synth", false);
      db.prepare("UPDATE nodes SET launch_wrapper = ? WHERE id = ?").run(JSON.stringify(wrapper), node.id);
      const stop = vi.fn(async () => ({ ok: true }));
      const tmux = { hasSession: vi.fn(async () => true),
        listPanes: vi.fn(async () => [{ id: "%0", index: 0, cwd: "/project", width: 80, height: 24, active: true }]),
        signalPaneProcess: stop, respawnPane: stop, killSession: stop, setRemainOnExit: stop,
        sendText: stop, sendKeys: stop, createSession: stop,
        capturePaneScreen: vi.fn(async () => "incumbent"), getPaneCommand: vi.fn(async () => "node"),
        getDefaultShell: vi.fn(async () => "/bin/zsh") } as unknown as TmuxAdapter;
      const service = new SeatHandoverService({ db, rigRepo, sessionRegistry,
        discoveryRepo: new DiscoveryRepository(db), eventBus: new EventBus(db), tmuxAdapter: tmux,
        runtimeAdapters: { synth: adapter },
        occupantInvalidator: { invalidateRetiringOccupant: vi.fn() },
        activityOracle: { declareOccupantSwap: vi.fn() },
        predecessorRecapResolver: (() => ({ unavailableReason: "test" })) as never });
      const snapshot = () => JSON.stringify(["nodes", "sessions", "bindings", "events", "occupant_tenures"]
        .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
      const before = snapshot();
      const preview = await service.handover({ seatRef, reason: "context-wall", dryRun: true });
      const real = await service.handover({ seatRef, reason: "context-wall" });
      expect(preview).toMatchObject({ ok: false, code: "successor_runtime_unsupported", message: expect.stringContaining("launch_wrapper unavailable") });
      expect(real).toEqual(preview);
      expect(snapshot()).toBe(before);
      expect(stop).not.toHaveBeenCalled();
      expect(sendShellCommand).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
