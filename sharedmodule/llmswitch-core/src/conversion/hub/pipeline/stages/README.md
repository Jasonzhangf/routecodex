# Hub Pipeline Stage Catalog

This directory documents the refactored Hub Pipeline stage skeleton. Every provider flow (requests/responses) is expressed as three coarse segments and every stage adopts the
`<flow>_<segment>_stage<n>_<verb>` naming convention. Each subdirectory contains the contract and future implementation notes for that stage.

## Segments

- `req_inbound`: entry payload → ChatEnvelope (parse, semantic mapping, context capture)
- `req_process`: governance + routing
- `req_outbound`: ChatEnvelope → provider wire payload
- `resp_inbound`: provider payload/SSE → ChatEnvelope
- `resp_process`: governance + finalization
- `resp_outbound`: ChatEnvelope → client protocol/SSE output

See individual READMEs under each stage for behavior and dependencies.
