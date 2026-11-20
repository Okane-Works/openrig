import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execCommand } from "../src/adapters/tmux-exec.js";
import { withCommunityHarnessResolver, seatAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { listNativeProcessesOrThrow, processArgv } from "../src/domain/native-process-lineage.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// Explicit opt-in: real Jcode and tmux, but private homes, sockets, database and
// local-only model endpoint. Never attach to the operator's daemon or storage.
const enabled = process.env.OPENRIG_TEST_JCODE_NATIVE === "1";
const run = promisify(execFile);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

describe.skipIf(!enabled)("community lifecycle with real isolated Jcode", () => {
  it("relinks conservatively, launches fresh, resumes, and hands over without losing selection", async () => {
    const jcode = process.env.OPENRIG_TEST_JCODE_BIN ?? "jcode";
    execFileSync(jcode, ["--version"], { timeout: 5000 });
    execFileSync("tmux", ["-V"], { timeout: 5000 });
    const root = fs.mkdtempSync(path.join(process.env.JCODE_SCRATCH_DIR ?? os.tmpdir(), "openrig-jcode-native-"));
    const tmuxSocket = path.join(root, "t.sock");
    const jcodeSocket = path.join(root, "j.sock");
    const home = path.join(root, "home");
    const jcodeHome = path.join(root, "jcode");
    const presets = path.join(root, "openrig", "community-harnesses");
    for (const dir of [home, jcodeHome, presets]) fs.mkdirSync(dir, { recursive: true });
    const requests: string[] = [];
    const model = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model", owned_by: "fixture" }] }));
      } else if (req.url?.endsWith("/chat/completions")) {
        // Production startup/handover can submit a first turn. Answer entirely
        // on localhost, without loading credentials or contacting a provider.
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const streaming = (JSON.parse(body) as { stream?: boolean }).stream;
          if (streaming) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const delta of [{ role: "assistant", content: "Disposable lifecycle fixture ready." }, {}]) {
              res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
                choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : "stop" }] })}\n\n`);
            }
            res.end("data: [DONE]\n\n");
          } else {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model: "fixture",
              choices: [{ index: 0, message: { role: "assistant", content: "Disposable lifecycle fixture ready." }, finish_reason: "stop" }] }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const port = (model.address() as { port: number }).port;
    const env: Record<string, string> = {
      HOME: home, SHELL: "/bin/sh", PATH: process.env.PATH ?? "/usr/bin:/bin",
      OPENRIG_HOME: path.join(root, "openrig"), JCODE_HOME: jcodeHome,
      JCODE_TEST_SESSION: "1", JCODE_OPENAI_COMPAT_API_BASE: `http://127.0.0.1:${port}/v1`,
      JCODE_OPENAI_COMPAT_API_KEY_NAME: "OPENRIG_FIXTURE_MODEL_KEY",
      OPENRIG_FIXTURE_MODEL_KEY: "fixture", JCODE_OPENAI_COMPAT_DEFAULT_MODEL: "fixture",
    };
    // Keep the provider and all storage isolation on the command too: the
    // adapter also exercises in-place handover's clean-environment respawn.
    const scrub = ["OPENRIG_ACTIVITY_HOOK_TOKEN", "OPENRIG_RUN_ID", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT",
      "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_ENV", "JCODE_CLIENT_HERDR_PANE_ID", "JCODE_CLIENT_HERDR_SOCKET_PATH"]
      .map(key => `-u ${key}`).join(" ");
    const command = `/usr/bin/env ${scrub} ${Object.entries(env).map(([k,v]) => `${k}=${quote(v)}`).join(" ")} ${quote(jcode)} --no-update --socket ${quote(jcodeSocket)} --provider openai-compatible --model fixture`;
    fs.writeFileSync(path.join(presets, "jcode.yaml"), `format: 1\nname: jcode\ncommand: ${JSON.stringify(command)}\nmaintainer: native-test\nlaunch_result: true\nresume: true\n`);
    const tmux = new TmuxAdapter(execCommand, undefined, undefined, ["-S", tmuxSocket, "-f", "/dev/null"]);
    vi.stubEnv("OPENRIG_HOME", env.OPENRIG_HOME!);
    vi.stubEnv("HOME", home);
    const db = createFullTestDb();
    try {
      const rigs = new RigRepository(db);
      const sessions = new SessionRegistry(db);
      const discovery = new DiscoveryRepository(db);
      const rig = rigs.createRig("native-fixture");
      const pod = new PodRepository(db).createPod(rig.id, "dev", "Disposable native fixture");
      const node = rigs.addNode(rig.id, "dev.impl", { runtime: "jcode", cwd: root, podId: pod.id });
      const name = "dev-impl@native-fixture";
      expect(await tmux.createSession("fixture-anchor", root, env)).toMatchObject({ ok: true });
      expect(await tmux.createSession(name, root, env)).toMatchObject({ ok: true });
      const pane = (await tmux.listPanes(name))[0]!.id;
      const maps = withCommunityHarnessResolver({}, {
        tmux, presetsDir: () => presets, launchResultRoot: () => path.join(root, "results"),
        launchResultWait: { timeoutMs: 20000, intervalMs: 100 },
      });
      expect(seatAdapter(maps, "jcode", null)).toBeUndefined();
      const adapter = seatAdapter(maps, "jcode", "jcode")!;
      const binding: NodeBinding = {
        id: "fixture-binding", nodeId: node.id, tmuxSession: name, tmuxWindow: "0", tmuxPane: pane,
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: new Date().toISOString(), cwd: root,
      };
      const first = await adapter.launchHarness(binding, { name });
      expect(first, await tmux.capturePaneContent(name)).toMatchObject({ ok: true, resumeType: "community:jcode" });
      expect(first.resumeToken).toBeTruthy();
      let row = sessions.registerSession(node.id, name);
      sessions.updateStatus(row.id, "running");
      sessions.updateStartupStatus(row.id, "ready", new Date().toISOString());
      sessions.recordCommunityHarnessSelection(row.id, "jcode", false);
      sessions.recordLauncherReportedToken(row.id, "community:jcode", first.resumeToken!);
      const record = (stage: string, id: string) => {
        const state = db.prepare("SELECT origin, agent_app, resume_type, (resume_token IS NOT NULL) AS token_present FROM sessions WHERE id = ?").get(id);
        console.log(`Native Jcode ${stage}: ${JSON.stringify(state)}`);
      };
      record("launched", row.id);
      sessions.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane });

      // Real native client is alive, but its old launch record cannot establish
      // which conversation a user might have selected since launch.
      const claim = new ClaimService({ db, rigRepo: rigs, sessionRegistry: sessions,
        discoveryRepo: discovery, eventBus: new EventBus(db), tmuxAdapter: tmux });
      const relinked = await claim.reconcileSession({ sessionName: name });
      expect(relinked, JSON.stringify(relinked)).toMatchObject({ ok: true });
      row = sessions.getSessionsForRig(rig.id).find(s => s.status === "running")!;
      expect(row.communityHarness).toBe("jcode");
      expect(row.resumeToken).toBeNull();
      record("reconciled", row.id);
      expect(seatAdapter(maps, "jcode", row.communityHarness)).toBeDefined();

      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'jcode')").run(node.id);
      const eventBus = new EventBus(db);
      const nodeLauncher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: sessions, eventBus,
        tmuxAdapter: tmux, sessionEnv: env });
      const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry: sessions, eventBus, tmuxAdapter: tmux });
      const lifecycle = new SeatLifecycleService({ db, rigRepo: rigs, sessionRegistry: sessions,
        eventBus, tmuxAdapter: tmux, nodeLauncher, startupOrchestrator, runtimeAdapters: maps });
      // Adopted processes are deliberately not owned by seat --stop. End only
      // our disposable process, then let the real fresh-launch service clean
      // absent history and create its new managed occupant.
      const rigLifecycle = new RigLifecycleService({ db, rigRepo: rigs, sessionRegistry: sessions,
        discoveryRepo: discovery, eventBus, queueRepo: new QueueRepository(db, eventBus), tmuxAdapter: tmux });
      expect(await rigLifecycle.unclaimSession(row.id)).toMatchObject({ ok: true });
      expect(await tmux.killSession(name)).toMatchObject({ ok: true });
      const fresh = await lifecycle.launchFresh({ seatRef: name, fresh: true, reason: "isolated acceptance" });
      expect(fresh, JSON.stringify(fresh)).toMatchObject({ ok: true });
      row = sessions.getSessionsForRig(rig.id).find(s => s.status === "running")!;
      expect(row.resumeType).toBe("community:jcode");
      const freshToken = row.resumeToken!;
      record("fresh", row.id);
      expect(freshToken).toBeTruthy();
      expect(freshToken).not.toBe(first.resumeToken);

      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({ db, rigRepo: rigs, sessionRegistry: sessions,
        eventBus, snapshotRepo, checkpointStore });
      const snapshot = snapshotCapture.captureSnapshot(rig.id, "native-fixture");
      expect(await tmux.killSession(name)).toMatchObject({ ok: true });
      const restore = new RestoreOrchestrator({ db, rigRepo: rigs, sessionRegistry: sessions, eventBus,
        snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: new ClaudeResumeAdapter(tmux), codexResume: new CodexResumeAdapter(tmux) });
      const restored = await restore.restore(snapshot.id, { adapters: maps });
      expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
      row = sessions.getSessionsForRig(rig.id).find(s => s.status === "running")!;
      expect(row, JSON.stringify(restored)).toBeDefined();
      expect(row.resumeToken).toBe(freshToken);
      record("restored", row.id);
      expect(row.resumeType).toBe("community:jcode");

      const service = new SeatHandoverService({
        db, rigRepo: rigs, sessionRegistry: sessions, discoveryRepo: discovery,
        eventBus: new EventBus(db), tmuxAdapter: tmux, runtimeAdapters: maps,
        sessionEnv: env, readinessTimeoutMs: 20000,
      });
      const paneBeforeRefusal = await tmux.getPanePid(name);
      const liveClientPids = async () => {
        const rows = await listNativeProcessesOrThrow();
        const descendants = new Set([paneBeforeRefusal]);
        for (let i = 0; i < rows.length; i++) {
          let changed = false;
          for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
            descendants.add(row.pid);
            changed = true;
          }
          if (!changed) break;
        }
        return rows.filter(row => descendants.has(row.pid) && processArgv(row.command).includes(jcodeSocket))
          .map(row => row.pid).sort((a, b) => a - b);
      };
      const clientBeforeRefusal = await liveClientPids();
      expect(clientBeforeRefusal.length).toBeGreaterThan(0);
      const presetPath = path.join(presets, "jcode.yaml");
      fs.renameSync(presetPath, `${presetPath}.disabled`);
      try {
        const refusedPreview = await service.handover({ seatRef: name, source: "fresh", reason: "isolated refusal proof", dryRun: true });
        const refused = await service.handover({ seatRef: name, source: "fresh", reason: "isolated refusal proof" });
        expect(refusedPreview).toMatchObject({ ok: false });
        expect(refused).toMatchObject({ ok: false });
        expect(await tmux.getPanePid(name)).toBe(paneBeforeRefusal);
        expect(await liveClientPids()).toEqual(clientBeforeRefusal);
      } finally {
        fs.renameSync(`${presetPath}.disabled`, presetPath);
      }
      const preview = await service.handover({ seatRef: name, source: "fresh", reason: "isolated native acceptance", dryRun: true });
      expect(preview).toMatchObject({ ok: true });
      const handed = await service.handover({ seatRef: name, source: "fresh", reason: "isolated native acceptance" });
      expect(handed, JSON.stringify(handed)).toMatchObject({ ok: true });
      const latest = sessions.getSessionsForRig(rig.id).find(s => s.status === "running")!;
      expect(latest.communityHarness).toBe("jcode");
      expect(latest.resumeType).toBe("community:jcode");
      expect(latest.resumeToken).toBeTruthy();
      expect(latest.resumeToken).not.toBe(freshToken);
      record("handed-over", latest.id);
      expect(requests.every(url => url.endsWith("/models") || url.endsWith("/chat/completions"))).toBe(true);
    } finally {
      await run("tmux", ["-S", tmuxSocket, "kill-server"]).catch(() => {});
      await run(jcode, ["--no-update", "--socket", jcodeSocket, "server", "stop"], { env: { ...env }, timeout: 15000 }).catch(() => {});
      db.close();
      vi.unstubAllEnvs();
      model.closeAllConnections();
      await new Promise<void>(resolve => model.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
