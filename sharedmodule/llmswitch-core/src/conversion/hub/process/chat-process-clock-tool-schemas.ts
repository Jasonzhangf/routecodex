import type { HubOperation } from '../ops/operations.js';
import type { StandardizedTool } from '../types/standardized.js';
import {
  buildClockStandardToolAppendOperationsWithNative,
  buildClockToolAppendOperationsWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-clock-tool-schema-semantics.js';

const CLOCK_PARAMETERS: StandardizedTool['function']['parameters'] = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'schedule', 'update', 'list', 'cancel', 'clear'],
      description:
        'Get current time, or schedule/update/list/cancel/clear session-scoped reminders. Mandatory rule: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If reminders end up within 5 minutes of each other, reconsider and merge or retime them. Use clock.schedule for blocking waits that should not stall execution. If waiting 3 minutes or longer is required, use action="schedule" immediately. For complex reminders, write the context into clock.md using this template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项.'
    } as Record<string, unknown>,
    items: {
      type: 'array',
      description: 'For schedule/update: list of reminder payloads. update uses items[0] as patch source.',
      items: {
        type: 'object',
        properties: {
          dueAt: {
            type: 'string',
            description: 'ISO8601 datetime with timezone (e.g. 2026-01-21T20:30:00-08:00).'
          },
          task: {
            type: 'string',
            description: 'Reminder text that states the exact action to execute on wake-up (no vague placeholders).'
          },
          tool: {
            type: 'string',
            description: 'Optional suggested tool name (hint only).'
          },
          arguments: {
            type: 'string',
            description: 'Optional suggested tool arguments as a JSON string (hint only). Use "{}" when unsure.'
          }
        },
        required: ['dueAt', 'task', 'tool', 'arguments'],
        additionalProperties: false
      }
    },
    taskId: {
      type: 'string',
      description: 'For cancel/update: target taskId.'
    }
  },
  required: ['action', 'items', 'taskId'],
  additionalProperties: false
};

const CLOCK_TOOL: StandardizedTool = {
  type: 'function',
  function: {
    name: 'clock',
    description:
      'Time + Alarm for this session. Mandatory workflow: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If two reminders would be within 5 minutes, merge or retime them instead of keeping near-duplicate alarms. Use clock.schedule for any blocking wait so work can continue non-blockingly and you will get an interrupt reminder later. If waiting 3 minutes or longer is required, MUST call clock.schedule now (never promise to wait without scheduling). You may set multiple reminders when they are meaningfully different. For complex reminders, write clock.md before waiting and read it first when reminded. Required clock.md template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项. Format example: {"action":"list","items":[],"taskId":""} before {"action":"schedule","items":[{"dueAt":"<ISO8601>","task":"<exact follow-up action>","tool":"<tool-name-or-empty>","arguments":"<json-string-or-{}>"}],"taskId":""}. Use get/schedule/update/list/cancel/clear. Scheduled reminders are injected into future requests.',
    parameters: CLOCK_PARAMETERS,
    strict: true
  }
};

const CLOCK_STANDARD_TOOLS: StandardizedTool[] = [
  {
    type: 'function',
    function: {
      name: 'clock',
      description:
        'Time + Alarm for this session. Mandatory workflow: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If two reminders would be within 5 minutes, merge or retime them instead of keeping near-duplicate alarms. Use clock.schedule for any blocking wait so work can continue non-blockingly and you will get an interrupt reminder later. If waiting 3 minutes or longer is required, call clock.schedule now. You may set multiple reminders when they are meaningfully different. For complex reminders, write clock.md before waiting and read it first when reminded. Required clock.md template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项. Format example: {"action":"list","items":[],"taskId":""} before {"action":"schedule","items":[{"dueAt":"<ISO8601>","task":"<exact follow-up action>","tool":"<tool-name-or-empty>","arguments":"<json-string-or-{}>"}],"taskId":""}. Use schedule/update/list/cancel/clear.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get', 'schedule', 'update', 'list', 'cancel', 'clear']
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dueAt: { type: 'string' },
                task: { type: 'string' },
                tool: { type: 'string' },
                arguments: { type: 'string' }
              },
              required: ['dueAt', 'task', 'tool', 'arguments'],
              additionalProperties: false
            }
          },
          taskId: { type: 'string' }
        },
        required: ['action', 'items', 'taskId'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Runs a shell command and returns its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          workdir: { type: 'string' }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'exec_command',
      description: 'Execute a command in a PTY and return output.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          workdir: { type: 'string' },
          timeout_ms: { type: 'number' },
          max_output_tokens: { type: 'number' },
          yield_time_ms: { type: 'number' }
        },
        required: ['cmd'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a patch to repository files.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string' }
        },
        required: ['patch'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Update the task plan.',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                status: { type: 'string' }
              },
              required: ['step', 'status'],
              additionalProperties: false
            }
          }
        },
        required: ['plan'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description: 'View a local image by file path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_mcp_resources',
      description: 'List resources exposed by MCP servers.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          filter: { type: 'string' },
          root: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_mcp_resource_templates',
      description: 'List resource templates exposed by MCP servers.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          cursor: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_mcp_resource',
      description: 'Read a specific MCP resource by { server, uri }.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          uri: { type: 'string' }
        },
        required: ['server', 'uri'],
        additionalProperties: false
      }
    }
  }
];

export function buildClockToolAppendOperations(hasSessionId: boolean): HubOperation[] {
  return buildClockToolAppendOperationsWithNative(hasSessionId, CLOCK_TOOL) as HubOperation[];
}

export function buildClockStandardToolAppendOperations(): HubOperation[] {
  return buildClockStandardToolAppendOperationsWithNative(
    CLOCK_STANDARD_TOOLS as unknown as unknown[]
  ) as HubOperation[];
}
