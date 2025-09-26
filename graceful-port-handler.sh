#!/bin/bash

# Graceful Port Handler Script
# Handles port conflicts by sending friendly stop signals before force killing

set -e

# Configuration
PORT=${1:-4006}
TIMEOUT=${2:-10}  # seconds to wait for graceful shutdown
SERVER_COMMAND="npm start"
SERVER_ARGS=""
CONFIG_FILE="~/.routecodex/config/modelscope.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Function to check if port is in use
is_port_in_use() {
    if lsof -ti :$PORT >/dev/null 2>&1; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Function to get PID of process using the port
get_port_pid() {
    lsof -ti :$PORT 2>/dev/null | head -1
}

# Function to get process name from PID
get_process_name() {
    if [[ -n "$1" ]]; then
        ps -p "$1" -o comm= 2>/dev/null || echo "unknown"
    else
        echo "unknown"
    fi
}

# Function to send SIGTERM (graceful shutdown)
send_graceful_stop() {
    local pid=$1
    if [[ -n "$pid" ]]; then
        print_status "Sending SIGTERM (graceful shutdown) to process $pid..."
        kill -TERM "$pid" 2>/dev/null || true
    fi
}

# Function to send SIGKILL (force kill)
send_force_kill() {
    local pid=$1
    if [[ -n "$pid" ]]; then
        print_warning "Sending SIGKILL (force kill) to process $pid..."
        kill -KILL "$pid" 2>/dev/null || true
    fi
}

# Function to check if process is still running
is_process_running() {
    if [[ -n "$1" ]]; then
        kill -0 "$1" 2>/dev/null
    else
        return 1
    fi
}

# Function to wait for process to stop
wait_for_process_stop() {
    local pid=$1
    local timeout=$2

    if [[ -z "$pid" ]]; then
        return 0
    fi

    print_status "Waiting for process $pid to stop (timeout: ${timeout}s)..."

    local elapsed=0
    while [[ $elapsed -lt $timeout ]]; do
        if ! is_process_running "$pid"; then
            print_success "Process $pid stopped gracefully"
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
        echo -n "."
    done

    echo ""
    return 1
}

# Function to cleanup background processes
cleanup() {
    print_status "Cleaning up background processes..."
    # Kill any background jobs we started
    jobs -p | xargs -r kill
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Main execution
main() {
    print_status "Graceful Port Handler - Port: $PORT"
    print_status "Timeout for graceful shutdown: ${TIMEOUT}s"
    print_status "Server command: ROUTECODEX_CONFIG=$CONFIG_FILE $SERVER_COMMAND $SERVER_ARGS"
    echo ""

    # Check if port is already in use
    if is_port_in_use; then
        local existing_pid=$(get_port_pid)
        local process_name=$(get_process_name "$existing_pid")

        print_warning "Port $PORT is already in use by process $existing_pid ($process_name)"

        # Try graceful shutdown first
        send_graceful_stop "$existing_pid"

        # Wait for graceful shutdown
        if wait_for_process_stop "$existing_pid" "$TIMEOUT"; then
            print_success "Port $PORT is now free"
        else
            print_warning "Graceful shutdown timed out, attempting force kill..."
            send_force_kill "$existing_pid"

            # Give it a moment to clean up
            sleep 2

            # Check if port is still in use
            if is_port_in_use; then
                print_error "Failed to free port $PORT even with force kill"
                exit 1
            else
                print_success "Port $PORT freed by force kill"
            fi
        fi
    else
        print_success "Port $PORT is free"
    fi

    # Give the system a moment to fully release the port
    sleep 1

    # Start the server
    print_status "Starting server on port $PORT..."
    echo "Command: ROUTECODEX_CONFIG=$CONFIG_FILE $SERVER_COMMAND $SERVER_ARGS"
    echo ""

    # Start the server in foreground with environment variable
    exec env ROUTECODEX_CONFIG="$CONFIG_FILE" $SERVER_COMMAND $SERVER_ARGS
}

# Run main function
main "$@"
