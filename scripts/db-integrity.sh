#!/bin/bash
# Run integrity checks on the production database via kubectl exec.
# Read-only, non-invasive. Runs against the live pod using better-sqlite3.
#
# Usage: ./scripts/db-integrity.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/db-common.sh
source "${SCRIPT_DIR}/db-common.sh"

check_kubectl

echo "Database Integrity Report (Remote)"
echo "Pod: ${POD_NAME}"
echo "Database: ${REMOTE_DB_PATH}"
echo "Date: $(date)"
echo ""

# Run all checks in a single node -e invocation to minimize kubectl exec overhead.
# The node script outputs formatted text and exits with code 1 if issues are found.
kubectl exec "${POD_NAME}" -- node -e "
const Database = require('better-sqlite3');
let db;
try {
  db = new Database('${REMOTE_DB_PATH}', { readonly: true });
} catch (e) {
  console.log('Error: Could not open database: ' + e.message);
  process.exit(1);
}

let issues = 0;

// 1. quick_check
console.log('1. PRAGMA quick_check');
try {
  const rows = db.pragma('quick_check');
  const results = rows.map(r => r.quick_check);
  if (results.length === 1 && results[0] === 'ok') {
    console.log('   Status: PASSED');
  } else {
    console.log('   Status: FAILED');
    console.log('   Details:');
    results.slice(0, 10).forEach(r => console.log('   ' + r));
    if (results.length > 10) console.log('   ... (' + results.length + ' total issues)');
    issues++;
  }
} catch (e) {
  console.log('   Status: ERROR');
  console.log('   ' + e.message);
  issues++;
}

// 2. foreign_key_check
console.log('');
console.log('2. PRAGMA foreign_key_check');
try {
  const fkRows = db.pragma('foreign_key_check');
  if (fkRows.length === 0) {
    console.log('   Status: PASSED (no violations)');
  } else {
    console.log('   Status: FAILED');
    console.log('   Violations: ' + fkRows.length);
    fkRows.slice(0, 10).forEach(v => console.log('   ' + JSON.stringify(v)));
    if (fkRows.length > 10) console.log('   ... (truncated)');
    issues++;
  }
} catch (e) {
  console.log('   Status: ERROR');
  console.log('   ' + e.message);
  issues++;
}

// 3. Table row counts
console.log('');
console.log('3. Table Row Counts');
try {
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all();
  let total = 0;
  const entries = [];
  for (const t of tables) {
    try {
      const row = db.prepare('SELECT COUNT(*) as c FROM \"' + t.name + '\"').get();
      entries.push([t.name, String(row.c)]);
      total += row.c;
    } catch (e) {
      entries.push([t.name, 'ERROR']);
    }
  }
  const maxName = Math.max(...entries.map(e => e[0].length), 5);
  const maxCount = Math.max(...entries.map(e => e[1].length), 5);
  entries.forEach(([name, count]) => {
    console.log('   ' + name.padEnd(maxName + 2) + count.padStart(maxCount));
  });
  console.log('   ' + '---'.padEnd(maxName + 2) + '---'.padStart(maxCount));
  console.log('   ' + 'TOTAL'.padEnd(maxName + 2) + String(total).padStart(maxCount));
} catch (e) {
  console.log('   Error: ' + e.message);
}

// 4. DB config
console.log('');
console.log('4. Database Configuration');
try {
  console.log('   Journal mode:   ' + db.pragma('journal_mode')[0].journal_mode);
  console.log('   Page size:      ' + db.pragma('page_size')[0].page_size);
  console.log('   Page count:     ' + db.pragma('page_count')[0].page_count);
  console.log('   Freelist count: ' + db.pragma('freelist_count')[0].freelist_count);
} catch (e) {
  console.log('   Error: ' + e.message);
}

db.close();

// 5. Overall health
console.log('');
console.log('5. Overall Health Status');
if (issues === 0) {
  console.log('   Status: HEALTHY');
  console.log('   The database appears to be in good condition.');
} else {
  console.log('   Status: ISSUES DETECTED');
  console.log('   Review the findings above. Consider running:');
  console.log('     ./scripts/db-recover.sh');
}
console.log('');

process.exit(issues > 0 ? 1 : 0);
"
