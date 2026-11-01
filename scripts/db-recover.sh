#!/bin/bash
# Full database recovery pipeline: backup, rebuild, and deploy in one operation.
# Rebuilds directly on the PVC volume to avoid slow network transfers.
#
# Usage: ./scripts/db-recover.sh
#
# Steps:
#   1. Create recovery pod (stays Pending until PVC is free)
#   2. Scale down StatefulSet to free PVC
#   3. Wait for recovery pod to become Ready
#   4. Install sqlite3 on recovery pod
#   5. Back up corrupt files on volume
#   6. Checkpoint WAL (best-effort)
#   7. Confirm corruption on volume
#   8. Rebuild database on volume (.recover or .dump)
#   9. Verify rebuilt database
#  10. Compare row counts
#  11. Confirm deployment (interactive)
#  12. Swap rebuilt DB into place
#  13. Scale up StatefulSet
#  14. Wait for readiness
#  15. Verify deployment via node -e
#  16. Clean up recovery pod

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/db-common.sh
source "${SCRIPT_DIR}/db-common.sh"

check_kubectl

# State tracking for cleanup
SCALED_DOWN=0
ORIGINAL_REPLICAS=1
RECOVERY_POD_CREATED=0
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
CORRUPT_BACKUP_DIR="/data/corrupt-bak-${TIMESTAMP}"
REBUILT_DB_PATH="/data/mod-bot-rebuilt.sqlite3"

cleanup() {
    echo ""
    echo "=== Cleanup ==="

    # Delete recovery pod FIRST — it holds the RWO PVC and must release it
    # before the StatefulSet pod can mount the volume.
    if [[ ${RECOVERY_POD_CREATED} -eq 1 ]]; then
        echo "Deleting recovery pod (to free PVC)..."
        kubectl delete pod "${RECOVERY_POD_NAME}" --ignore-not-found=true 2>/dev/null || true
        # Wait briefly for pod termination so PVC is released
        kubectl wait --for=delete pod/"${RECOVERY_POD_NAME}" --timeout=60s 2>/dev/null || true
    fi

    if [[ ${SCALED_DOWN} -eq 1 ]]; then
        echo "Scaling StatefulSet back up to ${ORIGINAL_REPLICAS} replicas..."
        kubectl scale statefulset "${STATEFULSET_NAME}" --replicas="${ORIGINAL_REPLICAS}" 2>/dev/null || true
    fi

    if [[ ${SCALED_DOWN} -eq 1 || ${RECOVERY_POD_CREATED} -eq 1 ]]; then
        echo ""
        echo "Corrupt backup remains on volume at: ${CORRUPT_BACKUP_DIR}"
        echo "You may need to inspect it manually."
    fi
}
trap cleanup EXIT

echo "Database Recovery Pipeline"
echo "Date: ${TIMESTAMP}"
echo ""
echo "This script will:"
echo "  - Create a recovery pod attached to the data volume"
echo "  - Scale down production (bot will be offline)"
echo "  - Rebuild the database on the volume"
echo "  - Scale production back up"
echo ""
read -p "Continue? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    trap - EXIT
    exit 0
fi

# ─── Step 1: Create recovery pod ───────────────────────────────────────────────
log_step "Creating recovery pod (will stay Pending until PVC is free)"

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${RECOVERY_POD_NAME}
spec:
  containers:
  - name: recovery
    image: alpine:latest
    command: ["sleep", "3600"]
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: ${PVC_NAME}
  restartPolicy: Never
EOF
RECOVERY_POD_CREATED=1
echo "Recovery pod created (Pending)"

# ─── Step 2: Scale down StatefulSet ────────────────────────────────────────────
log_step "Scaling down ${STATEFULSET_NAME}"

ORIGINAL_REPLICAS=$(kubectl get statefulset "${STATEFULSET_NAME}" -o jsonpath='{.spec.replicas}')
echo "Current replicas: ${ORIGINAL_REPLICAS}"

kubectl scale statefulset "${STATEFULSET_NAME}" --replicas=0
SCALED_DOWN=1
echo "Waiting for pod to terminate..."
kubectl wait --for=delete pod/"${POD_NAME}" --timeout=120s 2>/dev/null || true
echo "StatefulSet scaled down"

# ─── Step 3: Wait for recovery pod ────────────────────────────────────────────
log_step "Waiting for recovery pod to become Ready"

kubectl wait --for=condition=Ready pod/"${RECOVERY_POD_NAME}" --timeout=120s
echo "Recovery pod is Ready"

# ─── Step 4: Install sqlite3 ──────────────────────────────────────────────────
log_step "Installing sqlite3 on recovery pod"

kubectl exec "${RECOVERY_POD_NAME}" -- apk add --no-cache sqlite 2>&1 | tail -1
echo "sqlite3 installed"

# ─── Step 5: Back up corrupt files ────────────────────────────────────────────
log_step "Backing up corrupt files on volume"

kubectl exec "${RECOVERY_POD_NAME}" -- mkdir -p "${CORRUPT_BACKUP_DIR}"
kubectl exec "${RECOVERY_POD_NAME}" -- sh -c "
    cp '${REMOTE_DB_PATH}' '${CORRUPT_BACKUP_DIR}/' 2>/dev/null || true
    cp '${REMOTE_DB_PATH}-wal' '${CORRUPT_BACKUP_DIR}/' 2>/dev/null || true
    cp '${REMOTE_DB_PATH}-shm' '${CORRUPT_BACKUP_DIR}/' 2>/dev/null || true
    ls -lh '${CORRUPT_BACKUP_DIR}/'
"
echo "Corrupt files backed up to ${CORRUPT_BACKUP_DIR}"

# ─── Step 6: Checkpoint WAL ──────────────────────────────────────────────────
log_step "Attempting WAL checkpoint (best-effort)"

if kubectl exec "${RECOVERY_POD_NAME}" -- sqlite3 "${REMOTE_DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);" 2>&1; then
    echo "WAL checkpoint succeeded"
else
    echo "WAL checkpoint failed (expected if database is corrupt)"
fi

# ─── Step 7: Confirm corruption ──────────────────────────────────────────────
log_step "Checking database integrity on volume"

QUICK_CHECK=$(kubectl exec "${RECOVERY_POD_NAME}" -- sqlite3 "${REMOTE_DB_PATH}" "PRAGMA quick_check;" 2>&1 || true)
echo "${QUICK_CHECK}" | head -5

if [[ "${QUICK_CHECK}" == "ok" ]]; then
    echo ""
    echo "WARNING: Database passed quick_check — it may not be corrupt."
    read -p "Continue with rebuild anyway? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted. Scaling back up."
        # cleanup trap handles scale-up
        exit 0
    fi
fi

# ─── Step 8: Rebuild database on volume ──────────────────────────────────────
log_step "Rebuilding database on volume"

# Remove any leftover rebuilt file
kubectl exec "${RECOVERY_POD_NAME}" -- rm -f "${REBUILT_DB_PATH}"

# Test if .recover is available by trying it against a temp empty DB
RECOVER_AVAILABLE=0
if kubectl exec "${RECOVERY_POD_NAME}" -- sh -c "
    sqlite3 /tmp/test-recover.db 'CREATE TABLE t(x);' && \
    sqlite3 /tmp/test-recover.db '.recover' >/dev/null 2>&1 && \
    rm -f /tmp/test-recover.db
" 2>/dev/null; then
    RECOVER_AVAILABLE=1
fi

REBUILD_METHOD=""
if [[ ${RECOVER_AVAILABLE} -eq 1 ]]; then
    echo "Using .recover (preferred for corrupt databases)..."
    if kubectl exec "${RECOVERY_POD_NAME}" -- sh -c "
        sqlite3 '${REMOTE_DB_PATH}' '.recover' | sqlite3 '${REBUILT_DB_PATH}'
    " 2>&1; then
        REBUILD_METHOD=".recover"
        echo "Rebuild via .recover succeeded"
    else
        echo ".recover failed, falling back to .dump..."
    fi
fi

if [[ -z "${REBUILD_METHOD}" ]]; then
    echo "Using .dump..."
    if kubectl exec "${RECOVERY_POD_NAME}" -- sh -c "
        sqlite3 '${REMOTE_DB_PATH}' '.dump' | sqlite3 '${REBUILT_DB_PATH}'
    " 2>&1; then
        REBUILD_METHOD=".dump"
        echo "Rebuild via .dump succeeded"
    else
        echo "Error: Both .recover and .dump failed" >&2
        echo "Manual intervention required. Corrupt backup at: ${CORRUPT_BACKUP_DIR}" >&2
        exit 1
    fi
fi

# ─── Step 9: Verify rebuilt database ─────────────────────────────────────────
log_step "Verifying rebuilt database"

REBUILT_INTEGRITY=$(kubectl exec "${RECOVERY_POD_NAME}" -- sqlite3 "${REBUILT_DB_PATH}" "PRAGMA integrity_check;" 2>&1)
if [[ "${REBUILT_INTEGRITY}" == "ok" ]]; then
    echo "  Integrity check: PASSED"
else
    echo "  Integrity check: FAILED"
    echo "  ${REBUILT_INTEGRITY}" | head -5
    echo ""
    echo "WARNING: Rebuilt database has integrity issues."
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

REBUILT_FK=$(kubectl exec "${RECOVERY_POD_NAME}" -- sqlite3 "${REBUILT_DB_PATH}" "PRAGMA foreign_key_check;" 2>&1)
if [[ -z "${REBUILT_FK}" ]]; then
    echo "  Foreign key check: PASSED"
else
    echo "  Foreign key check: VIOLATIONS FOUND"
    echo "  ${REBUILT_FK}" | head -5
fi

# ─── Step 10: Compare row counts ─────────────────────────────────────────────
log_step "Comparing row counts (corrupt vs rebuilt)"

kubectl exec "${RECOVERY_POD_NAME}" -- sh -c "
TABLES=\$(sqlite3 '${REMOTE_DB_PATH}' \"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;\" 2>/dev/null)

printf '%-30s %10s %10s %10s\n' 'Table' 'Corrupt' 'Rebuilt' 'Diff'
printf '%-30s %10s %10s %10s\n' '-----' '-------' '-------' '----'

TOTAL_CORRUPT=0
TOTAL_REBUILT=0

for TABLE in \${TABLES}; do
    CORRUPT_COUNT=\$(sqlite3 '${REMOTE_DB_PATH}' \"SELECT COUNT(*) FROM \\\"\${TABLE}\\\";\" 2>/dev/null || echo 'ERR')
    REBUILT_COUNT=\$(sqlite3 '${REBUILT_DB_PATH}' \"SELECT COUNT(*) FROM \\\"\${TABLE}\\\";\" 2>/dev/null || echo '0')

    if [ \"\${CORRUPT_COUNT}\" = 'ERR' ]; then
        DIFF='N/A'
    else
        DIFF=\$((REBUILT_COUNT - CORRUPT_COUNT))
        TOTAL_CORRUPT=\$((TOTAL_CORRUPT + CORRUPT_COUNT))
    fi
    TOTAL_REBUILT=\$((TOTAL_REBUILT + REBUILT_COUNT))

    printf '%-30s %10s %10s %10s\n' \"\${TABLE}\" \"\${CORRUPT_COUNT}\" \"\${REBUILT_COUNT}\" \"\${DIFF}\"
done

printf '%-30s %10s %10s %10s\n' '-----' '-------' '-------' '----'
printf '%-30s %10s %10s %10s\n' 'TOTAL' \"\${TOTAL_CORRUPT}\" \"\${TOTAL_REBUILT}\" \"\$((TOTAL_REBUILT - TOTAL_CORRUPT))\"
"

# ─── Step 11: Confirm deployment ─────────────────────────────────────────────
log_step "Confirm deployment"

CORRUPT_SIZE=$(kubectl exec "${RECOVERY_POD_NAME}" -- ls -lh "${REMOTE_DB_PATH}" 2>/dev/null | awk '{print $5}')
REBUILT_SIZE=$(kubectl exec "${RECOVERY_POD_NAME}" -- ls -lh "${REBUILT_DB_PATH}" 2>/dev/null | awk '{print $5}')

echo ""
echo "  Rebuild method:  ${REBUILD_METHOD}"
echo "  Corrupt DB size: ${CORRUPT_SIZE}"
echo "  Rebuilt DB size: ${REBUILT_SIZE}"
echo "  Corrupt backup:  ${CORRUPT_BACKUP_DIR}"
echo ""
echo "This will replace the production database with the rebuilt copy."
read -p "Deploy rebuilt database? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted. Corrupt backup remains at: ${CORRUPT_BACKUP_DIR}"
    echo "Rebuilt DB remains at: ${REBUILT_DB_PATH}"
    exit 0
fi

# ─── Step 12: Swap into place ────────────────────────────────────────────────
log_step "Swapping rebuilt database into place"

kubectl exec "${RECOVERY_POD_NAME}" -- sh -c "
    mv '${REBUILT_DB_PATH}' '${REMOTE_DB_PATH}'
    rm -f '${REMOTE_DB_PATH}-wal' '${REMOTE_DB_PATH}-shm'
"
echo "Database swapped"

# ─── Step 13: Scale up StatefulSet ───────────────────────────────────────────
log_step "Scaling up ${STATEFULSET_NAME}"

kubectl scale statefulset "${STATEFULSET_NAME}" --replicas="${ORIGINAL_REPLICAS}"
SCALED_DOWN=0
echo "StatefulSet scaling up to ${ORIGINAL_REPLICAS} replicas"

# ─── Step 14: Wait for readiness ─────────────────────────────────────────────
log_step "Waiting for pod readiness"

kubectl wait --for=condition=Ready pod/"${POD_NAME}" --timeout=300s
echo "Pod ${POD_NAME} is Ready"

# ─── Step 15: Verify deployment ──────────────────────────────────────────────
log_step "Verifying deployment"

# Give the app a moment to initialize
sleep 3

kubectl exec "${POD_NAME}" -- node -e "
const Database = require('better-sqlite3');
const db = new Database('${REMOTE_DB_PATH}', { readonly: true });

// quick_check
const rows = db.pragma('quick_check');
const results = rows.map(r => r.quick_check);
if (results.length === 1 && results[0] === 'ok') {
  console.log('Integrity check: PASSED');
} else {
  console.log('Integrity check: FAILED');
  results.slice(0, 5).forEach(r => console.log('  ' + r));
  process.exitCode = 1;
}

// FK check
const fkRows = db.pragma('foreign_key_check');
if (fkRows.length === 0) {
  console.log('Foreign key check: PASSED');
} else {
  console.log('Foreign key check: ' + fkRows.length + ' violations');
  process.exitCode = 1;
}

// Row count
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all();
let total = 0;
for (const t of tables) {
  try { total += db.prepare('SELECT COUNT(*) as c FROM \"' + t.name + '\"').get().c; } catch(e) {}
}
console.log('Total rows: ' + total);

db.close();
"

# ─── Step 16: Clean up recovery pod ──────────────────────────────────────────
log_step "Cleaning up recovery pod"

kubectl delete pod "${RECOVERY_POD_NAME}" --wait=false
RECOVERY_POD_CREATED=0
echo "Recovery pod deleted"

# Disarm the cleanup trap since we've handled everything
trap - EXIT

echo ""
echo "=== Recovery Complete ==="
echo "The database has been rebuilt and deployed successfully."
echo "Corrupt backup preserved at: ${CORRUPT_BACKUP_DIR} (on the volume)"
