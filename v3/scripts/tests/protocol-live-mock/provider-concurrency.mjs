// Compatibility facade for the protocol-live-mock matrix.
//
// The issue-745f6e9 provider-concurrency cases now assert request independence
// and typed provider-failure isolation. The implementation lives in
// `provider-independence.mjs`; this module keeps the historical import path.

export * from './provider-independence.mjs';
