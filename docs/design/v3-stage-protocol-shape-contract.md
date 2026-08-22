# V3 stage protocol shape contract

Machine truth: `docs/architecture/manifests/v3.stage_protocol_shape_contract.yml`.

| Mode | Stage | Entry | Exit | Conversion permission |
| --- | --- | --- | --- | --- |
| Direct | request policy / wire / transport | entry protocol | same entry protocol | none |
| Direct | provider response / client response | entry protocol | same entry protocol | none |
| Relay | ReqInbound01 | source wire | source wire | parse only |
| Relay | ReqInbound02 | source wire | canonical Chat + registered extension | adjacent inbound codec only |
| Relay | Req03 through Req07 | canonical Chat + registered extension | same canonical Chat shape | none |
| Relay | ProviderReqCompat06 | canonical Chat + registered extension | selected provider semantic | adjacent outbound codec only |
| Relay | Req08 / Req09 | selected provider semantic/wire | selected provider wire | transport compatibility only |
| Relay | ProviderResp01 / Compat02 | selected provider wire | selected provider wire | parse framing only |
| Relay | RespInbound02 | selected provider wire | canonical Chat response | adjacent inbound codec only |
| Relay | Resp03 / Resp04 | canonical Chat response | same canonical Chat response | none |
| Relay | RespOutbound05 | canonical Chat response | client entry protocol | adjacent outbound codec only |
| Relay | ServerResp06 | client entry protocol | same client protocol | framing only |

Every stage is bound to one real builder/parser and its exact Rust owner file in
the manifest; a symbol found in another stage or another source file does not
satisfy the gate. Direct and Relay
are mutually exclusive contracts: Direct may not import or invoke Hub protocol
conversion; Relay must not carry raw source/provider payload through canonical
Chat stages. RouteCodex control fields are forbidden in every business shape.

The compile entry `build:v3-cli` runs `verify:v3-architecture-ci` before Cargo.
That umbrella runs this contract verifier and its mutation fixtures, so a missing
stage, changed shape, unbound owner, unregistered conversion point, Direct codec
dependency, or missing build wiring stops the build.
