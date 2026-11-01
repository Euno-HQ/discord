#!/bin/bash
# Shared constants and utilities for database maintenance scripts.
# Source this file: source "$(dirname "$0")/db-common.sh"
# These constants are consumed by the scripts that source this file, which
# the linter can't see when checking this file on its own.
# shellcheck disable=SC2034

STATEFULSET_NAME="mod-bot-set"
POD_NAME="mod-bot-set-0"
PVC_NAME="mod-bot-pvc-mod-bot-set-0"
REMOTE_DB_PATH="/data/mod-bot.sqlite3"
RECOVERY_POD_NAME="db-recovery-temp"

STEP_COUNTER=0

log_step() {
    STEP_COUNTER=$((STEP_COUNTER + 1))
    echo ""
    echo "=== Step ${STEP_COUNTER}: $1 ==="
}

check_kubectl() {
    if ! command -v kubectl &>/dev/null; then
        echo "Error: kubectl is not installed or not in PATH" >&2
        exit 1
    fi
    if ! kubectl cluster-info &>/dev/null; then
        echo "Error: Cannot connect to Kubernetes cluster" >&2
        exit 1
    fi
}

check_sqlite3_local() {
    if ! command -v sqlite3 &>/dev/null; then
        echo "Error: sqlite3 is not installed or not in PATH" >&2
        exit 1
    fi
}
