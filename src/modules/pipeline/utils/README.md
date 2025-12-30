# Pipeline Utils Module
## Overview
Pipeline utils module contains utility functions used by the Hub Pipeline bridge and orchestration layer.
## Directory Structure
```src/modules/pipeline/utils/
├── colored- logger. ts         # Colored logging utilities for pipeline output
├── debug- logger. ts           # Debug logging and tracing utilities
└── transformation- engine. ts  # Transformation utility helpers```## Key Components### ColoredLoggerProvides colored console output for pipeline stages and events.### DebugLoggerStructured debug logging with configurable verbosity levels.
## Usage```typescriptimport { ColoredLogger } from './colored-logger. js';const logger = new ColoredLogger();logger.info('Pipeline started');```## Related Documentation
- `src/modules/llmswitch/` - Main pipeline bridge and loader
