// Placeholder target for the module wiring smoke's linker.
//
// The linker resolves every specifier in the view graph. Specifiers that are not
// sibling view modules (the browser/platform code the view relies on) are
// pointed here so that a missing platform module is never reported as a wiring
// failure. This file is never executed and is never served; it lives outside
// app/ so it cannot be fetched as an asset.
export default undefined;
