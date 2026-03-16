# ASCII Architecture Diagrams

## Current Architecture (Single Pod)

```
                    Internet
                       |
                       v
               +---------------+
               |   Ingress     |
               | (nginx-ingr)  |
               +---------------+
                       |
                       v
               +---------------+
               |   Service     |
               |  (ClusterIP)  |
               +---------------+
                       |
                       v
     +----------------------------------+
     |      StatefulSet (1 replica)     |
     |                                  |
     |  +----------------------------+  |
     |  |   mod-bot Pod              |  |
     |  |                            |  |
     |  |  - Discord.js Gateway      |  |
     |  |  - HTTP Server (Express)   |  |
     |  |  - SQLite Database         |  |
     |  |                            |  |
     |  +----------------------------+  |
     |           |                      |
     |           v                      |
     |  +----------------------------+  |
     |  |  Persistent Volume         |  |
     |  |  (1Gi ReadWriteOnce)       |  |
     |  |  mod-bot.sqlite3           |  |
     |  +----------------------------+  |
     +----------------------------------+
                       |
                       | WebSocket
                       v
              +----------------+
              |  Discord API   |
              +----------------+

PROBLEM: Cannot scale to 2+ replicas because:
- SQLite file cannot be shared across pods
- ReadWriteOnce volume can only be mounted by one pod
- No built-in replication mechanism
```

## Proposed Architecture (Multi-Pod with Guild-Based Sharding)

```
                              Internet
                                 |
                                 v
                      +--------------------+
                      |   Load Balancer    |
                      | (nginx-ingress)    |
                      +--------------------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
    +----------+            +----------+            +----------+
    |   HTTP   |            |   HTTP   |            |   HTTP   |
    | Service  |            | Service  |            | Service  |
    |  Pod 1   |            |  Pod 2   |            |  Pod N   |
    +----------+            +----------+            +----------+
    (Deployment: 2-10 replicas, HPA enabled)
         |                       |                       |
         +-----------------------+-----------------------+
                                 |
                  +--------------+---------------+
                  |                              |
                  v                              v
         +------------------+           +------------------+
         |  Config Service  |           |  Config Service  |
         |      Pod 1       |           |      Pod 2       |
         +------------------+           +------------------+
         (Deployment: 2 replicas)
                  |                              |
                  v                              v
         +------------------------------------------+
         |         PostgreSQL Database              |
         |    (Guild → Pod assignments)             |
         +------------------------------------------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
    +----------+            +----------+            +----------+
    | Gateway  |            | Gateway  |            | Gateway  |
    |  Pod 0   |            |  Pod 1   |            |  Pod N   |
    |          |            |          |            |          |
    | Guilds   |            | Guilds   |            | Guilds   |
    |  0-99    |            | 100-199  |            |  N-M     |
    |          |            |          |            |          |
    | SQLite   |            | SQLite   |            | SQLite   |
    |   DB0    |            |   DB1    |            |   DBN    |
    +----------+            +----------+            +----------+
    | Litestr  |            | Litestr  |            | Litestr  |
    |  Sidecar |            |  Sidecar |            |  Sidecar |
    +----------+            +----------+            +----------+
    (StatefulSet: 3-10 replicas)
         |                       |                       |
         v                       v                       v
    +----------+            +----------+            +----------+
    | Volume 0 |            | Volume 1 |            | Volume N |
    |  (1Gi)   |            |  (1Gi)   |            |  (1Gi)   |
    +----------+            +----------+            +----------+
         |                       |                       |
         +-----------------------+-----------------------+
                                 |
                  Continuous Backup (Litestream)
                                 v
                      +--------------------+
                      | S3 / Object Store  |
                      |  (Backup Storage)  |
                      +--------------------+
                                 |
         +-----------------------+-----------------------+
         |                       |                       |
         v                       v                       v
    Discord Gateway          Discord Gateway        Discord Gateway
    (guilds 0-99)            (guilds 100-199)       (guilds N-M)


KEY FEATURES:
✓ Multiple gateway pods, each handles subset of guilds
✓ Each pod has its own SQLite database
✓ Config service tracks guild→pod assignments
✓ HTTP service routes requests to correct pod
✓ Litestream provides continuous backup
✓ Can scale by adding more gateway pods
```

## Request Flow: Discord Event

```
Discord API
    |
    | Event for Guild 42
    |
    v
Gateway Pod 0 (handles guilds 0-99)
    |
    | 1. Receive event
    | 2. Check: Is guild 42 assigned to me?
    | 3. Yes → Process event
    |
    v
SQLite DB 0
    |
    | Write event data
    |
    v
Litestream Sidecar
    |
    | Continuous replication
    |
    v
S3 Backup
```

## Request Flow: HTTP Request

```
User Browser
    |
    | GET /guild/42/dashboard
    |
    v
Load Balancer
    |
    v
HTTP Service Pod (any pod)
    |
    | 1. Extract guild_id: 42
    |
    v
Config Service
    |
    | 2. Query: Which pod handles guild 42?
    | 3. Response: Pod 0
    |
    v
HTTP Service Pod
    |
    | 4. Route request to gateway-0
    |
    v
Gateway Pod 0
    |
    | 5. Query local SQLite DB
    |
    v
SQLite DB 0
    |
    | 6. Return guild data
    |
    v
HTTP Service Pod
    |
    | 7. Render response
    |
    v
Load Balancer
    |
    v
User Browser
```

## Request Flow: Discord Interaction (Command)

```
User (Discord Client)
    |
    | /setup command in Guild 150
    |
    v
Discord API
    |
    | POST /webhooks/discord
    | Payload: { guild_id: "150", ... }
    |
    v
Load Balancer
    |
    v
HTTP Service Pod (any pod)
    |
    | 1. Verify webhook signature
    | 2. Extract guild_id: 150
    |
    v
Config Service
    |
    | 3. Query: Which pod handles guild 150?
    | 4. Response: Pod 1
    |
    v
HTTP Service Pod
    |
    | 5. Forward to gateway-1
    |
    v
Gateway Pod 1
    |
    | 6. Process command
    | 7. Update settings
    |
    v
SQLite DB 1
    |
    | 8. Write changes
    |
    v
Gateway Pod 1
    |
    | 9. Respond to Discord
    |
    v
Discord API
    |
    v
User (Discord Client)
```

## Guild Reassignment Flow

```
Admin / Autoscaler
    |
    | Request: Move guild 42 from Pod 0 → Pod 1
    |
    v
Config Service
    |
    | 1. Mark guild 42 as "migrating"
    |
    v
Gateway Pod 0
    |
    | 2. Stop processing guild 42 events
    | 3. Drain in-flight requests
    | 4. Export guild 42 data
    |
    v
Config Service
    |
    | 5. Transfer data
    |
    v
Gateway Pod 1
    |
    | 6. Import guild 42 data
    | 7. Verify data integrity
    |
    v
Config Service
    |
    | 8. Update assignment: guild 42 → Pod 1
    | 9. Mark as "active"
    |
    v
Gateway Pod 1
    |
    | 10. Start processing guild 42 events
    |
    v
COMPLETE
```

## Scaling Diagram

```
INITIAL STATE (3 gateway pods):
+---------+  +---------+  +---------+
| Pod 0   |  | Pod 1   |  | Pod 2   |
| 33 glds |  | 33 glds |  | 34 glds |
| ████    |  | ████    |  | █████   |
+---------+  +---------+  +---------+

ADD GUILD 101:
Config Service assigns to Pod 0 (least loaded)

+---------+  +---------+  +---------+
| Pod 0   |  | Pod 1   |  | Pod 2   |
| 34 glds |  | 33 glds |  | 34 glds |
| ████    |  | ████    |  | █████   |
+---------+  +---------+  +---------+

SCALE UP (add Pod 3):
Rebalance guilds automatically

+---------+  +---------+  +---------+  +---------+
| Pod 0   |  | Pod 1   |  | Pod 2   |  | Pod 3   |
| 25 glds |  | 25 glds |  | 25 glds |  | 26 glds |
| ███     |  | ███     |  | ███     |  | ███     |
+---------+  +---------+  +---------+  +---------+

REBALANCING PROCESS:
1. Config Service detects new pod
2. Calculates optimal distribution
3. Moves guilds 75-99 from Pod 0 → Pod 3
4. Moves guilds 75-99 from Pod 1 → Pod 3
5. Moves guilds 75-99 from Pod 2 → Pod 3
6. Each move: Stop → Export → Import → Start
```

## Failure Scenarios

### Scenario 1: Gateway Pod Failure
```
BEFORE:
+---------+  +---------+  +---------+
| Pod 0   |  | Pod 1   |  | Pod 2   |
| RUNNING |  | RUNNING |  | RUNNING |
+---------+  +---------+  +---------+

Pod 1 CRASHES:
+---------+  +---------+  +---------+
| Pod 0   |  | Pod 1   |  | Pod 2   |
| RUNNING |  |   ❌    |  | RUNNING |
+---------+  +---------+  +---------+

RECOVERY (automatic by Kubernetes):
1. K8s detects pod failure
2. Restarts pod 1
3. Litestream restores from S3
4. Config Service marks pod 1 as active
5. Pod 1 resumes processing

AFTER (< 30 seconds):
+---------+  +---------+  +---------+
| Pod 0   |  | Pod 1   |  | Pod 2   |
| RUNNING |  | RUNNING |  | RUNNING |
+---------+  +---------+  +---------+
```

### Scenario 2: Config Service Failure
```
HTTP Service has cached assignments:
- In-memory cache with 5 minute TTL
- Can continue routing for 5 minutes
- Config Service has 2 replicas (HA)
- K8s restarts failed pod

Impact: Minimal (cached data, fast recovery)
```

### Scenario 3: HTTP Service Overload
```
BEFORE (normal load):
HTTP Service: 2 pods @ 40% CPU

TRAFFIC SPIKE:
HTTP Service: 2 pods @ 90% CPU
    ↓
HPA detects high CPU
    ↓
Scale to 4 pods
    ↓
HTTP Service: 4 pods @ 45% CPU

AFTER SPIKE:
Traffic returns to normal
    ↓
HPA waits 5 minutes (stabilization)
    ↓
Scale down to 2 pods
    ↓
HTTP Service: 2 pods @ 40% CPU
```

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Data Layer                         │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │  SQLite 0    │  │  SQLite 1    │  │ SQLite N │ │
│  │              │  │              │  │          │ │
│  │ Guilds 0-99  │  │ Guilds 100+  │  │ Guilds..│ │
│  └──────────────┘  └──────────────┘  └──────────┘ │
│         ↓                 ↓                 ↓      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ Litestream 0 │  │ Litestream 1 │  │Litestr N │ │
│  └──────────────┘  └──────────────┘  └──────────┘ │
│         ↓                 ↓                 ↓      │
│         └─────────────────┴─────────────────┘      │
│                           ↓                        │
│                   ┌──────────────┐                 │
│                   │  S3 Backup   │                 │
│                   └──────────────┘                 │
└─────────────────────────────────────────────────────┘
                           ↑
                           │
                   ┌──────────────┐
                   │ PostgreSQL   │
                   │ (Config DB)  │
                   │              │
                   │ - Assignments│
                   │ - Pod Health │
                   └──────────────┘
```

## Monitoring Architecture

```
┌─────────────────────────────────────────────────────┐
│              Prometheus / Grafana                   │
└─────────────────────────────────────────────────────┘
    ↑        ↑        ↑        ↑        ↑        ↑
    │        │        │        │        │        │
┌───────┐┌───────┐┌───────┐┌───────┐┌───────┐┌───────┐
│HTTP-1 ││HTTP-2 ││Gate-0 ││Gate-1 ││Config ││Ingrss │
└───────┘└───────┘└───────┘└───────┘└───────┘└───────┘

Metrics Collected:
- HTTP request latency (P50, P95, P99)
- Gateway event processing time
- Guild distribution across pods
- Config service query latency
- Litestream replication lag
- Pod CPU/Memory usage
- Error rates

Alerts:
⚠️ Pod unhealthy for > 1 minute
⚠️ Guild distribution imbalanced > 20%
⚠️ Replication lag > 10 seconds
⚠️ HTTP P99 latency > 1 second
⚠️ Error rate > 1%
```
