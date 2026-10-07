#!/usr/bin/env node
// Requires a Node release with native TypeScript stripping (22.18+, 24+, 26+).
import { main } from '../the-codes/cli/cli.ts';
process.exitCode = await main(process.argv.slice(2));
