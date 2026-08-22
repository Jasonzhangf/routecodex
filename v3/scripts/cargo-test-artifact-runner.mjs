#!/usr/bin/env node
import { runV3CargoTest } from './run-v3-cargo-test.mjs';

process.exitCode = await runV3CargoTest(process.argv.slice(2));
