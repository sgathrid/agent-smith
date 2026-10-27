/** One execution owner per launch; deliberately independent of MCP transport. */
import { ForgeService } from '../../../forge/service.ts';
import { startPipeline } from '../../../forge/execute.ts';
import { existsSync } from 'node:fs';
import { FILES, jobFile } from '../../../forge/format.ts';
import { pendingAcceptance, runAcceptance, writeAcceptance } from '../../../forge/checks.ts';
import type { SupervisorRequest } from '../../../forge/supervisor.ts';
import type { StageCheck } from '../../../pipeline/types.ts';

/** How often a running check set looks for the job's cancel marker; the pump polls at the same order. */
const CANCEL_POLL_MS = 200;

/**
 * Run the checks, aborting them when `cancel` writes the job's marker. The in-process path
 * aborts through an AbortController; the marker is the only signal a detached supervisor gets.
 */
async function runCancelableAcceptance(repo: string, jobId: string, succeeded: boolean, checks: StageCheck[], baseDir: string) {
  const controller = new AbortController();
  const marker = jobFile(repo, jobId, FILES.cancel);
  const check = () => { if (existsSync(marker)) controller.abort(); };
  check();
  const timer = setInterval(check, CANCEL_POLL_MS);
  try { return await runAcceptance({ repo, jobId, succeeded, checks, baseDir, signal: controller.signal }); }
  finally { clearInterval(timer); }
}

process.once('message', async (raw) => {
  const payload = raw as SupervisorRequest;
  let started = false;
  // Before the preparation barrier, a vanished caller means there is no launch.
  const disconnected = () => { if (!started) process.exit(1); };
  process.on('disconnect', disconnected);
  const send = (message: unknown) => { if (process.connected) process.send?.(message); };
  try {
    const service = new ForgeService({ repo: payload.repo });
    if (payload.kind === 'pipeline') {
      started = true;
      const run = startPipeline(service, payload.spec, payload.options);
      send({ kind: 'ack', value: { runId: run.runId, recordPath: run.recordPath } });
      await run.done;
    } else {
      const prepared: string[] = [];
      const checks = payload.request.checks as StageCheck[] | undefined;
      const tracked = await service.spawnTracked({ ...payload.request, onPrepared: async (jobId) => {
        prepared.push(jobId);
        if (checks?.length) writeAcceptance(payload.repo, jobId, pendingAcceptance(checks));
        if (started) return; // Continuations rebind through resolveHead, without an MCP owner.
        await new Promise<void>((resolve) => {
          process.once('message', () => { started = true; resolve(); });
          send({ kind: 'prepared', jobId });
        });
      } });
      send({ kind: 'ack', value: tracked.ack });
      const manifest = await tracked.done;
      if (checks?.length) {
        writeAcceptance(payload.repo, manifest.jobId, await runCancelableAcceptance(payload.repo, manifest.jobId, manifest.status === 'succeeded', checks, manifest.cwd));
        for (const id of prepared) if (id !== manifest.jobId) {
          writeAcceptance(payload.repo, id, { state: 'unchecked', checks: [], reason: 'superseded by steered turn' });
        }
      }
    }
  } catch (error) {
    send({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    process.removeListener('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
});
