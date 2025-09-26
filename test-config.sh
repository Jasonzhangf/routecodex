#!/bin/bash

# Start the server in background and capture output
ROUTECODEX_CONFIG=~/.routecodex/config/modelscope.json npm start > server-output.log 2>&1 &

# Wait a moment for server to start
sleep 3

# Check the log for pipeline count
echo "Checking pipeline count in logs..."
grep -E "pipelineCount: [0-9]+" server-output.log || grep -E "pipeline-created" server-output.log | wc -l

# Kill the server process
pkill -f "npm start" || true
sleep 1

echo "Server output:"
cat server-output.log | tail -20
