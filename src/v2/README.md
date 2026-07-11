# V2 Architecture Module

## Overview

V2 architecture module documents legacy migration concepts only. New Hub Pipeline
snapshot recording is owned by `src/modules/llmswitch/bridge/snapshot-recorder.ts`
as host IO/observation and by native snapshot hooks for normalization, planning,
policy, and write execution.

## Do / Don't

**Do**

- Keep legacy V2 notes as historical migration context only.
- Use the current llmswitch bridge snapshot recorder factory when runtime code
  needs host snapshot IO.

**Don't**

- Restore the removed legacy snapshot recorder class or its deleted hub conversion path.
- Implement new conversion logic here; use the llmswitch-core/native owner.
- Store sensitive data in snapshots.
