# V2 Architecture Module
## Overview
V2 architecture module contains conversion and compatibility components for the RouteCodex V2 pipeline. This module bridges between different protocol versions and provides migration utilities.
## Directory Structure
```src/v2/
└── conversion/                 # Protocol conversion layer    └── hub/                  # Hub-level conversion utilities
        └── snapshot-recorder. ts  # Snapshot recording for V2 pipeline```## Key Components### Conversion LayerHandles protocol conversion between: - V1 to V2 format migration
- Hub Pipeline compatibility transformations
- Snapshot recording and replay### SnapshotRecorderRecords request/response snapshots for debugging, testing, and regression analysis.
## Usage```typescript
import { SnapshotRecorder } from './conversion/hub/snapshot-recorder. js';
const recorder = new SnapshotRecorder();await recorder.record(request, response);```## Do / Don't
**Do**
- Use for V1→V2 migration scenarios
- Record snapshots for debugging complex issues**Don't**
- Implement new conversion logic here (use llmswitch-core compat layer)
- Store sensitive data in snapshots
## Related Documentation
- `docs/v2-migration-guide.md` - Migration guide
- `sharedmodule/llmswitch-core/src/conversion/compat/` - Compatibility layer
