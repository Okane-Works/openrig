import { describe, expect, it, vi } from "vitest";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { PiCommunityRuntimeAdapter } from "../src/adapters/pi-community-runtime-adapter.js";
import type { CommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

function makeAdapter() {
  const tmux = {
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "node"),
    sendShellCommand: vi.fn(async () => ({ ok: true as const, code: "ok" })),
    capturePaneContent: vi.fn(async () => "[pi-runner] READY"),
    listPanes: vi.fn(async () => [{ id: "%1" }]),
  };
  const resolveLaunchWrapper = vi.fn((wrapper: string[]) => wrapper);
  const pi = new PiRuntimeAdapter({
    tmux: tmux as any,
    fsOps: {
      readFile: (p: string) => { throw new Error(`ENOENT: ${p}`); },
      writeFile: () => {},
      exists: () => false,
      mkdirp: () => {},
      listFiles: () => [] as string[],
      statMode: () => 0o644,
      chmod: () => {},
    },
    stateRoot: "/state/pi",
    runnerEntryPath: "/dist/adapters/pi-runner.js",
    trustPosture: "no-approve",
    sleep: async () => {},
    newLaunchId: () => "test-launch-id-1",
    // A seat launch environment is wired, so the refusal is about the Pi fork, not a missing environment.
    seatLaunchEnvironment: { resolveLaunchWrapper, command: vi.fn(async (_s: string, cmd: string) => cmd) } as any,
  });
  const preset = { name: "senpi", command: "senpi", runner: true } as unknown as CommunityHarnessPreset;
  return { adapter: PiCommunityRuntimeAdapter.fromPiAdapter(pi, "senpi", preset), tmux, resolveLaunchWrapper };
}

function binding(launchWrapper?: string[]): NodeBinding {
  return {
    nodeId: "node-1",
    tmuxSession: "dev-impl@rig",
    cwd: "/work",
    ...(launchWrapper ? { launchWrapper } : {}),
  } as unknown as NodeBinding;
}

describe("PiCommunityRuntimeAdapter.preflightLaunch", () => {
  it("passes a seat with no launch wrapper", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.preflightLaunch(binding())).toEqual({ ok: true });
  });

  it("passes a seat with an empty launch wrapper", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.preflightLaunch(binding([]))).toEqual({ ok: true });
  });

  it("refuses a nonempty launch wrapper with the error the launch itself gives, touching nothing", async () => {
    const { adapter, tmux, resolveLaunchWrapper } = makeAdapter();
    const wrapped = binding(["sandbox-exec", "-f", "profile.sb"]);

    const checked = await adapter.preflightLaunch(wrapped);
    expect(checked).toEqual({ ok: false, error: "launch_wrapper support unavailable; no agent started." });

    const launched = await adapter.launchHarness(wrapped, { name: "dev-impl@rig" });
    expect(launched.ok).toBe(false);
    expect(checked).toEqual({ ok: false, error: (launched as { error: string }).error });

    expect(resolveLaunchWrapper).not.toHaveBeenCalled();
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });
});
