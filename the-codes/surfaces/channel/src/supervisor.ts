import { ForgeService } from '../../../forge/service.ts';
import { startPipeline } from '../../../forge/execute.ts';
import type { SupervisorRequest } from '../../../forge/supervisor.ts';

process.once('message', async (raw) => {
  const payload = raw as SupervisorRequest;
  let started = false;
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
      const tracked = await service.spawnTracked({ ...payload.request, ownerChecks: true, onPrepared: async (jobId) => {
        if (started) return;
        await new Promise<void>((resolve) => {
          process.once('message', () => { started = true; resolve(); });
          send({ kind: 'prepared', jobId });
        });
      } });
      send({ kind: 'ack', value: tracked.ack });
      await tracked.done;
    }
  } catch (error) {
    send({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    process.removeListener('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
});
