#!/usr/bin/env node
import { createIFlowOAuth } from '../dist/modules/pipeline/modules/provider/iflow-oauth.js';

async function main() {
  console.log('Starting iFlow OAuth device flow. A verification URL and user code will be shown below.');
  const oauth = createIFlowOAuth();
  // Start device flow
  const device = await oauth.startDeviceCodeFlow(true);
  console.log('Please open this URL and enter the code to authorize:');
  console.log('Verification URL:', device.verification_uri || device.verification_url || 'N/A');
  console.log('User Code:', device.user_code);
  // Poll for token
  const token = await oauth.pollForToken(device.device_code, device.code_verifier);
  await oauth.saveToken();
  console.log('Token stored. Summary:', {
    has_access_token: !!token?.access_token,
    expires_at: token?.expiry_date || token?.expires_at
  });
}

main().catch(err => { console.error('iFlow OAuth failed:', err?.message || String(err)); process.exit(1); });

