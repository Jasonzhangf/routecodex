# v2 Conversion Codecs

New codecs that adopt the unified conversion pipeline live here. Each codec
should:

1. Import hook contracts from `../hooks/protocol-hooks`.
2. Implement the inbound + outbound hooks using protocol-specific logic only.
3. Register itself through the legacy codec registry until parity with the v1
   implementation is proven (the registry can select v2 via profile config).

Keep per-protocol files scoped within this folder so the legacy codecs remain
untouched while we iterate.***
