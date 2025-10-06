#!/usr/bin/env node
import { completeQwenOAuth } from '../dist/modules/pipeline/modules/provider/qwen-oauth.js';

async function main() {
  console.log('Starting Qwen OAuth device flow. A verification URL and user code will be shown below.');
  console.log('Please open the URL in a browser and enter the code to authorize. This may require a Qwen account.');
  const token = await completeQwenOAuth({ openBrowser: false });
  console.log('Token stored. Summary:', {
    has_access_token: !!token?.access_token,
    expires_at: token?.expires_at
  });
}

main().catch(err => { console.error('Qwen OAuth failed:', err?.message || String(err)); process.exit(1); });

