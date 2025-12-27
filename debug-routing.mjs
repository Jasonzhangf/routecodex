#!/usr/bin/env node
/**
 * Debug script to test routing normalization
 */

import { bootstrapVirtualRouterConfig } from '../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import fs from 'fs';

const configPath = process.env.HOME + '/.routecodex/config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

console.log('Testing routing normalization...\n');

try {
    const result = bootstrapVirtualRouterConfig(config);
    console.log('✅ Bootstrap successful!');
    console.log('\nRouting keys:', Object.keys(result.routing));
    console.log('\nDefault route:');
    console.log(JSON.stringify(result.routing.default, null, 2));
} catch (error) {
    console.error('❌ Bootstrap failed:');
    console.error(error.message);
    console.error(error.stack);
}
