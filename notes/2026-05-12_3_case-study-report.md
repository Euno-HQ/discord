# Reactiflux case study — 2026-05-12T23:08:23.128Z
source: /Users/vcarl/workspace/mod-bot/.worktrees/metrics-research/prod-mod-bot.sqlite3
guild: 102860784329052160

## CS1 spam interruptions (interrupt_min = events × 2)
| window | events | interrupt_min |
|---|---|---|
| 30d | 113 | 226 |
| 90d | 247 | 494 |
| life | 700 | — |
cohort_floor: 2025-07-26

## CS2 escalations
initiated: 12 | resolved: 12 (100.0%)
resolution mix: 8 track, 2 ban, 1 restrict, 1 kick
scheduled (n=9): 28–350.7h, avg 104.9h
unscheduled (n=3): 2.9–16.1h, avg 9h
cohort_floor: 2025-12-04

## CS3 escalation voter participation
distinct voters: 5
active mods (denom): 19
participation: 26.3%

## CS4 reports by reason × source
| reason | staff | anonymous |
|---|---|---|
| anonReport | — | 629 |
| track | 1,353 | — |
| spam | 700 | 3 |

## CS5 reports → enforcement (24h, cohort_floor=2026-02-20)
| reason | n_reports | resolved_24h | pct |
|---|---|---|---|
| spam | 229 | 23 | 10.0% |
| anonReport | 128 | 21 | 16.4% |
| track | 106 | 8 | 7.5% |
| total | 463 | 52 | 11.2% |

## CS6 monthly active mods (bot excluded; active = mod_action ∪ track-report ∪ vote)
| ym | n |
|---|---|
| 2025-07 | 5 |
| 2025-08 | 15 |
| 2025-09 | 13 |
| 2025-10 | 17 |
| 2025-11 | 16 |
| 2025-12 | 13 |
| 2026-01 | 18 |
| 2026-02 | 17 |
| 2026-03 | 11 |
| 2026-04 | 8 |
| 2026-05 (MTD) | 6 |
peak: 18 in 2026-01

## CS7 message volume
| window | n |
|---|---|
| 30d | 31,640 |
| 90d | 89,503 |
| life | 828,589 |

### top categories (30d)
| category | msgs_30d |
|---|---|
| Social | 23,629 |
| Community | 3,236 |
| Need Help | 1,737 |
| Reactiflux | 1,005 |
| React General | 964 |
