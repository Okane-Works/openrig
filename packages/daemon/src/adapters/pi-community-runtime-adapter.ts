import type { CommunityHarnessPreset } from "../domain/community-harness-presets.js";
import { validateSessionFileFormat } from "../domain/resume-token-validation.js";
import type { NodeBinding } from "../domain/runtime-adapter.js";
import { PiRuntimeAdapter, type PiRuntimeAdapterDeps } from "./pi-runtime-adapter.js";

/**
 * A community harness that speaks Pi's RPC protocol (e.g. OmO Native on senpi, Prime Agent, or other Pi forks).
 * Runs through OpenRig's Pi runner inside the seat's pane with full structured activity, typed RPC prompt/steer,
 * session file tracking, and resume capabilities.
 */
export class PiCommunityRuntimeAdapter extends PiRuntimeAdapter {
  override readonly runtime: string;
  readonly communityHarness: string;
  readonly preset: CommunityHarnessPreset;

  constructor(
    runtime: string,
    preset: CommunityHarnessPreset,
    deps: PiRuntimeAdapterDeps,
  ) {
    super(deps);
    this.runtime = runtime;
    this.communityHarness = runtime;
    this.preset = preset;
  }

  static fromPiAdapter(pi: PiRuntimeAdapter, runtime: string, preset: CommunityHarnessPreset): PiCommunityRuntimeAdapter {
    return new PiCommunityRuntimeAdapter(runtime, preset, pi.getCommunityDeps());
  }

  /** Whether this launch's preset declares an OpenRig-aware runner, recorded on the session with the launch. */
  runner(): boolean {
    return true;
  }

  /** What `launchHarness` would refuse from the seat alone, checked while the predecessor still runs: a Pi fork
   *  can't apply a seat launch wrapper, so a nonempty one is refused with the launch's own error. */
  async preflightLaunch(binding: NodeBinding): Promise<{ ok: true } | { ok: false; error: string }> {
    return binding.launchWrapper?.length
      ? { ok: false, error: "launch_wrapper support unavailable; no agent started." }
      : { ok: true };
  }

  protected override get commandName(): string | undefined {
    return this.preset.command;
  }

  protected override get resumeType(): string {
    return `community:${this.runtime}`;
  }

  protected override validateToken(rawToken: unknown): { ok: true; token: string; resumeType: string } | { ok: false; error: string } {
    const res = validateSessionFileFormat(rawToken, this.runtime);
    if (!res.ok) return res;
    return { ok: true, token: res.token, resumeType: this.resumeType };
  }
}
