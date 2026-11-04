#!/bin/bash
# Backup the production database using better-sqlite3's backup API.
# Produces a single consistent file without needing to copy WAL/SHM.
#
# Usage: ./scripts/db-backup.sh [destination]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/db-common.sh
source "${SCRIPT_DIR}/db-common.sh"

check_kubectl
check_sqlite3_local

REMOTE_BACKUP_PATH="/data/mod-bot-backup-tmp.sqlite3"

# Determine destination path
if [[ $# -ge 1 ]]; then
    DESTINATION="$1"
else
    TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
    DESTINATION="./mod-bot-backup-${TIMESTAMP}.sqlite3"
fi

# Cleanup: remove temp file from pod on exit
cleanup() {
    echo "Cleaning up temporary backup on pod..."
    kubectl exec "${POD_NAME}" -- rm -f "${REMOTE_BACKUP_PATH}" 2>/dev/null || true
}
trap cleanup EXIT

echo "Backing up database from ${POD_NAME}"
echo "  Source: ${POD_NAME}:${REMOTE_DB_PATH}"
echo "  Destination: ${DESTINATION}"
echo ""

log_step "Creating consistent backup on pod via better-sqlite3"
kubectl exec "${POD_NAME}" -- node -e "
const Database = require('better-sqlite3');
const db = new Database('${REMOTE_DB_PATH}', { readonly: true });
db.backup('${REMOTE_BACKUP_PATH}')
  .then(() => {
    db.close();
    console.log('Backup created successfully on pod');
  })
  .catch(err => {
    db.close();
    console.error('Backup failed: ' + err.message);
    process.exit(1);
  });
"

log_step "Downloading backup to local machine"
kubectl cp "${POD_NAME}:${REMOTE_BACKUP_PATH}" "${DESTINATION}"

FILE_SIZE=$(du -h "${DESTINATION}" | cut -f1)
echo "  File: ${DESTINATION}"
echo "  Size: ${FILE_SIZE}"

log_step "Running local integrity check"
INTEGRITY=$(sqlite3 "${DESTINATION}" "PRAGMA quick_check;" 2>&1)
if [[ "${INTEGRITY}" == "ok" ]]; then
    echo "  Integrity: PASSED"
else
    echo "  Integrity: ISSUES DETECTED"
    echo "  Run ./scripts/db-integrity.sh for details on the production database"
    echo "  The backup may reflect pre-existing corruption in the source."
fi

echo ""
echo "Backup complete: ${DESTINATION}"
