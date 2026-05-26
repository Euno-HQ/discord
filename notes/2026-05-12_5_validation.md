# Metrics validation — 2026-05-12T23:08:23.302Z
source: /Users/vcarl/workspace/mod-bot/.worktrees/metrics-research/prod-mod-bot.sqlite3

| # | id | check | actual | status |
|---|---|---|---|---|
| 1 | CS1 | spam back-fill rate ≤ 5% | 0.43% (3/703) | OK |
| 2 | CS2 | resolved_at == resolution count | 12 == 12 | OK |
| 3 | CS3 | distinct voters < records (if records > 5) | 5 / 21 | OK |
| 4 | CS4 | anonReport never has staff_id | 0 rows | OK |
| 5 | CS5 | matched mod_actions don't target bot | 0 pairs | OK |
| 6 | CS6a | bot not in mod_actions.executor_id | 0 rows | OK |
| 7 | CS6b | bot in reported_messages.staff_id (informational) | 700 rows | INFO |
| 8 | CS6c | bot not in escalation voters | 0 rows | OK |
| 9 | CS7 | sent_at in [2015, now+1d], min ≤ max | MIN=2024-10-08T15:17:54.182Z MAX=2026-05-12T16:40:55.333Z | OK |
| 10 | SCHEMA | kysely_migration count in {29,30} | 29 | OK |
| 11 | CORRUPT | corrupt reported_messages == 82 | 82 | OK |
| 12 | DEL-LOG | deletion_log_threads CURRENT_TIMESTAMP rows | 1606 | INFO |

summary: 12 checks — 10 OK, 0 FLAG, 2 INFO (exit 0)
