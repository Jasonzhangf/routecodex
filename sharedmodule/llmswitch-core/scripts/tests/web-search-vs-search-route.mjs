import { RoutingClassifier } from '../../dist/router/virtual-router/classifier.js';
import { buildRoutingFeatures } from '../../dist/router/virtual-router/features.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildRequestFromCommand(command) {
  return {
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'run command' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: command })
            }
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for information'
        }
      }
    ]
  };
}

function classify(requestId, req) {
  const features = buildRoutingFeatures(req, { requestId });
  const classifier = new RoutingClassifier({});
  return { features, result: classifier.classify(features) };
}

async function main() {
  const caseGitLog = classify(
    'route-case-git-log',
    buildRequestFromCommand('git log --oneline --since="2026-02-11T13:00:00" --until="2026-02-11T15:00:00"')
  );
  assert(caseGitLog.features.lastAssistantToolCategory === 'search', 'git log should classify as search tool');
  assert(caseGitLog.result.routeName === 'search', `git log should route to search, got ${caseGitLog.result.routeName}`);

  const caseBdSearch = classify(
    'route-case-bd-search',
    buildRequestFromCommand('bd --no-db search "web_search" --limit 20')
  );
  assert(caseBdSearch.features.lastAssistantToolCategory === 'search', 'bd search should classify as search tool');
  assert(caseBdSearch.result.routeName === 'search', `bd search should route to search, got ${caseBdSearch.result.routeName}`);

 const caseWebIntent = classify('route-case-web-intent', {
   model: 'gpt-test',
   messages: [{ role: 'user', content: 'Please search the web for latest news today' }]
 });
   assert(caseWebIntent.result.routeName === 'web_search', `web intent should route to web_search (via keywords), got ${caseWebIntent.result.routeName}`);
   assert(caseWebIntent.result.reasoning.includes('web_search:intent-keyword'), 'web intent reason should be intent-keyword');

   // Test: web_search tool declared WITHOUT intent keywords should still route to web_search
   const caseToolDeclaredNoIntent = classify('route-case-tool-declared-no-intent', {
     model: 'gpt-test',
     messages: [{ role: 'user', content: 'Hello, how are you?' }],
     tools: [
       {
         type: 'function',
         function: {
           name: 'web_search',
           description: 'Search the web for information'
         }
       }
     ]
   });
   assert(caseToolDeclaredNoIntent.result.routeName === 'web_search', `tool declared without intent should route to web_search, got ${caseToolDeclaredNoIntent.result.routeName}`);

  const caseNoStickyWebSearch = classify('route-case-no-sticky-websearch', {
    model: 'gpt-test',
    messages: [
      { role: 'user', content: '继续' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_4',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ query: 'latest news' })
            }
          }
        ]
      }
    ],
    tools: []
  });
  assert(caseNoStickyWebSearch.features.lastAssistantToolCategory === 'websearch', 'web_search call should classify as websearch tool');
  assert(
    caseNoStickyWebSearch.result.routeName === 'web_search',
    'previous web_search tool category should keep web_search route'
  );

  const caseContinueExecutionWithDeclaredWebSearch = classify('route-case-continue-exec-with-websearch-declared', {
    model: 'gpt-test',
    messages: [
      { role: 'user', content: '继续执行' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_5',
            type: 'function',
            function: {
              name: 'continue_execution',
              arguments: '{}'
            }
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for information'
        }
      }
    ]
  });
  assert(
    caseContinueExecutionWithDeclaredWebSearch.features.lastAssistantToolCategory === 'other',
    'continue_execution should classify as other tool'
  );
  assert(
    caseContinueExecutionWithDeclaredWebSearch.result.routeName === 'tools',
    `continue_execution followup should stay on tools route, got ${caseContinueExecutionWithDeclaredWebSearch.result.routeName}`
  );

  const caseEchoWithDeclaredWebSearch = classify('route-case-echo-with-websearch-declared', {
    model: 'gpt-test',
    messages: [
      { role: 'user', content: '继续执行' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_6',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'echo 分析僵尸进程来源：' })
            }
          }
        ]
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for information'
        }
      }
    ]
  });
  assert(caseEchoWithDeclaredWebSearch.features.lastAssistantToolCategory === 'other', 'echo should classify as other tool');
  assert(
    caseEchoWithDeclaredWebSearch.result.routeName === 'tools',
    `other tool followup should stay on tools route, got ${caseEchoWithDeclaredWebSearch.result.routeName}`
  );

  const caseRead = classify('route-case-read', {
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_2',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'cat package.json' })
            }
          }
        ]
      }
    ],
    tools: []
  });
  assert(caseRead.features.lastAssistantToolCategory === 'read', 'cat should classify as read tool');
  assert(caseRead.result.routeName === 'thinking', `read continuation should route to thinking, got ${caseRead.result.routeName}`);

  const caseWrite = classify('route-case-write', {
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'patch it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_3',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH" })
            }
          }
        ]
      }
    ],
    tools: []
  });
  assert(caseWrite.features.lastAssistantToolCategory === 'write', 'apply_patch should classify as write tool');
  assert(caseWrite.result.routeName === 'coding', `write continuation should route to coding, got ${caseWrite.result.routeName}`);

  console.log('[web-search-vs-search-route] ok', {
    gitLogRoute: caseGitLog.result.routeName,
    bdSearchRoute: caseBdSearch.result.routeName,
    webIntentRoute: caseWebIntent.result.routeName,
    toolDeclaredNoIntentRoute: caseToolDeclaredNoIntent.result.routeName,
    noStickyWebSearchRoute: caseNoStickyWebSearch.result.routeName,
    continueExecutionRoute: caseContinueExecutionWithDeclaredWebSearch.result.routeName,
    echoRoute: caseEchoWithDeclaredWebSearch.result.routeName,
    readRoute: caseRead.result.routeName,
    writeRoute: caseWrite.result.routeName
  });
}

main().catch((error) => {
  console.error('[web-search-vs-search-route] failed', error);
  process.exit(1);
});
