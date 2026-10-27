/** Exit codes and the usage error shared by the CLI command modules. */

export const EXIT = { ok: 0, usage: 1, failed: 2, notFound: 3, spawnFailed: 4 } as const;

/** A mistake in how the command was invoked: reported without a stack, exit code `EXIT.usage`. */
export class UsageError extends Error {}
