const path = require('path');

// Map sharedmodule imports to npm-installed @jsonstudio/llms for CI
module.exports = {
  '^../../sharedmodule/llmswitch-core/src/(.*)$': '@jsonstudio/llms/dist/$1',
  '^../../../../sharedmodule/llmswitch-core/dist/(.*)$': '@jsonstudio/llms/dist/$1'
};
