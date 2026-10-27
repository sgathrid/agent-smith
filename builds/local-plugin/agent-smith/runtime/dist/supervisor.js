import {F as ForgeService}from'./chunk-service.js';import {s as startPipeline,m as markAcceptancePending,e as settleAcceptance}from'./chunk-execute.js';import'node:child_process';import'node:url';import'node:timers/promises';import'node:fs';import'node:path';import'node:fs/promises';import'node:crypto';import'node:os';import'node:readline';/** One execution owner per launch; deliberately independent of MCP transport. */
process.once('message', async (raw) => {
    const payload = raw;
    let started = false;
    // Before the preparation barrier, a vanished caller means there is no launch.
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
            const prepared = [];
            const checks = payload.request.checks;
            const tracked = await service.spawnTracked({ ...payload.request, onPrepared: async (jobId) => {
                    prepared.push(jobId);
                    if (checks?.length)
                        markAcceptancePending(payload.repo, jobId);
                    if (started)
                        return; // Continuations rebind through resolveHead, without an MCP owner.
                    await new Promise((resolve) => {
                        process.once('message', () => { started = true; resolve(); });
                        send({ kind: 'prepared', jobId });
                    });
                } });
            send({ kind: 'ack', value: tracked.ack });
            const manifest = await tracked.done;
            if (checks?.length) {
                await settleAcceptance({
                    repo: payload.repo, finalJobId: manifest.jobId, preparedJobIds: prepared,
                    succeeded: manifest.status === 'succeeded', checks, baseDir: manifest.cwd,
                });
            }
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