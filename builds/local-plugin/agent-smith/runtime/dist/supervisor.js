import {F as ForgeService}from'./chunk-service.js';import {s as startPipeline}from'./chunk-normalize.js';import'node:fs';import'node:child_process';import'node:url';import'node:timers/promises';import'node:path';import'node:crypto';import'node:fs/promises';import'node:os';import'node:readline';process.once('message', async (raw) => {
    const payload = raw;
    let started = false;
    const disconnected = () => { if (!started)
        process.exit(1); };
    process.on('disconnect', disconnected);
    const send = (message) => { if (process.connected)
        process.send?.(message); };
    try {
        const service = new ForgeService({ repo: payload.repo });
        if (payload.kind === 'pipeline') {
            started = true;
            const run = startPipeline(service, payload.spec, payload.options);
            send({ kind: 'ack', value: { runId: run.runId, recordPath: run.recordPath } });
            await run.done;
        }
        else {
            const tracked = await service.spawnTracked({ ...payload.request, ownerChecks: true, onPrepared: async (jobId) => {
                    if (started)
                        return;
                    await new Promise((resolve) => {
                        process.once('message', () => { started = true; resolve(); });
                        send({ kind: 'prepared', jobId });
                    });
                } });
            send({ kind: 'ack', value: tracked.ack });
            await tracked.done;
        }
    }
    catch (error) {
        send({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
    }
    finally {
        process.removeListener('disconnect', disconnected);
        if (process.connected)
            process.disconnect();
    }
});