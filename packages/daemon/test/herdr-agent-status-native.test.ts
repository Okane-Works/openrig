import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import { HerdrAgentStatusRelay, type HerdrSeatActivity } from "../src/domain/terminal/herdr-agent-status.js";
import { createHerdrSocketRpc, createHerdrSocketTransport } from "../src/domain/terminal/herdr-transport.js";

const run = promisify(execFile);

/** Opt-in proof against installed binaries. All state, sockets and processes are private to this test.
 * Run: OPENRIG_TEST_HERDR_NATIVE=1 npx vitest run packages/daemon/test/herdr-agent-status-native.test.ts
 * No agent credentials, real model prompts, existing tmux server or desktop views are used. */
it.skipIf(process.env.OPENRIG_TEST_HERDR_NATIVE !== "1" || process.platform === "win32")(
  "reports community activity to a real Herdr tmux viewer and releases it on detach",
  async () => {
    const root = mkdtempSync(path.join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), "hs-"));
    const socket = path.join(root, "herdr", "herdr.sock");
    const tmuxSocket = path.join(root, "tmux.sock");
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: root, SHELL: "/bin/sh" };
    for (const key of Object.keys(env)) if (key.startsWith("HERDR_") || key === "TMUX" || key === "TMUX_PANE") delete env[key];
    const server = spawn("herdr", ["server"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    server.stderr?.on("data", chunk => { errors += chunk; });
    server.on("error", error => { errors += error.message; });
    const transport = createHerdrSocketTransport(createHerdrSocketRpc(socket, 1000))();
    const clients = new TmuxAdapter(async () => { throw new Error("argv transport required"); }, undefined,
      execArgvCommand, ["-S", tmuxSocket]);
    let relay: HerdrAgentStatusRelay | undefined;
    const session = "jcode-smoke@disposable";
    const seat: HerdrSeatActivity = { runtime: "jcode-lead", activity: null };
    try {
      let answering = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await transport.probe()).alive) { answering = true; break; }
        if (server.exitCode !== null) break;
        await delay(100);
      }
      expect(answering, errors).toBe(true);
      await run("tmux", ["-S", tmuxSocket, "new-session", "-d", "-s", session, "sleep 120"], { env });
      const created = await transport.request("workspace.create", { cwd: root, label: "status-proof" });
      const workspaceId = (created.workspace as { workspace_id: string }).workspace_id;
      await transport.request("layout.apply", {
        workspace_id: workspaceId, tab_label: "disposable viewer", focus: false,
        root: { type: "pane", label: "not a seat identity", command: ["tmux", "-S", tmuxSocket, "attach", "-t", `=${session}`] },
      });
      let paneId: string | undefined;
      for (let attempt = 0; attempt < 50 && !paneId; attempt++) {
        const pids = new Set((await clients.listClientProcesses()).map(client => client.pid));
        const listed = await transport.request("pane.list", { workspace_id: workspaceId });
        for (const pane of listed.panes as Array<{ pane_id: string }>) {
          const reply = await transport.request("pane.process_info", { pane_id: pane.pane_id });
          const info = reply.process_info as { foreground_processes: Array<{ pid: number }> };
          if (info.foreground_processes.some(process => pids.has(process.pid))) paneId = pane.pane_id;
        }
        if (!paneId) await delay(100);
      }
      expect(paneId).toBeDefined();
      relay = new HerdrAgentStatusRelay({ clients, transports: () => [transport], resolve: name => {
        expect(name).toBe(session);
        return seat;
      }, sweep: false });
      for (const [activity, state] of [["running", "working"], ["idle", "idle"], ["needs_input", "blocked"], ["unknown", "unknown"]] as const) {
        seat.activity = { state: activity, reason: "native-proof", evidenceSource: "hook", sampledAt: new Date().toISOString(), evidence: null };
        await relay.sweep();
        const result = await transport.request("pane.get", { pane_id: paneId });
        const displayed = state === "idle" ? "done" : state;
        // An unfocused working-to-idle transition is Herdr's unseen completion (done).
        expect(result.pane).toMatchObject({ agent: "jcode-lead", agent_status: displayed });
        const agents = await transport.request("agent.list", {});
        expect(agents.agents).toEqual(expect.arrayContaining([expect.objectContaining({ pane_id: paneId, agent: "jcode-lead", agent_status: displayed })]));
      }
      await run("tmux", ["-S", tmuxSocket, "detach-client", "-s", `=${session}`], { env });
      await relay.sweep();
      const listed = await transport.request("pane.list", {});
      expect((listed.panes as Array<{ agent?: string }>).some(pane => pane.agent === "jcode-lead")).toBe(false);
      console.log("Native Herdr proof: working, idle, blocked, unknown and detach clearing passed on private sockets.");
    } finally {
      relay?.stop();
      await transport.request("server.stop", {}).catch(() => {});
      server.kill("SIGTERM");
      await run("tmux", ["-S", tmuxSocket, "kill-server"], { env }).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000,
);
