# Load Balancer Architecture Analysis

## Current Architecture

### Components
- **Discord Gateway Connection**: Single client connects to all guilds via Discord.js
- **HTTP Server**: Express server serving both web portal and Discord webhooks
- **Database**: SQLite with better-sqlite3 (single file: `/data/mod-bot.sqlite3`)
- **Deployment**: Kubernetes StatefulSet with 1 replica
- **Storage**: 1Gi ReadWriteOnce volume on DigitalOcean block storage

### Key Constraint: SQLite
SQLite is an embedded database that stores data in a single file. It does **not** support concurrent writes from multiple processes accessing the same file over a network filesystem. This is the primary blocker for horizontal scaling with traditional load balancing.

### Current Guild Access Pattern
The bot connects to Discord's gateway and receives events for ALL guilds it's added to. The Discord.js client maintains a single websocket connection (or multiple shards for very large bots) and handles events for all guilds through that connection.

Key code locations:
- `app/discord/client.server.ts`: Creates Discord.js client
- `app/discord/gateway.ts`: Initializes gateway and registers event handlers
- `app/discord/deployCommands.server.ts`: Deploys commands to all guilds

## SQLite Replication Solutions

### 1. Litestream
- **Description**: Continuous replication to S3, GCS, Azure Blob Storage
- **Pros**: Battle-tested, minimal overhead, point-in-time recovery
- **Cons**: Async replication (seconds delay), requires object storage, read replicas only
- **Use case**: Disaster recovery, not for multi-writer scaling

### 2. LiteFS
- **Description**: Distributed filesystem for SQLite by Fly.io
- **Pros**: FUSE-based, transparent to application, automatic leader election
- **Cons**: Single writer (leader), requires FUSE support, adds complexity
- **Use case**: Geographic distribution with single writer

### 3. rqlite
- **Description**: Distributed SQLite using Raft consensus
- **Pros**: True distributed writes, strong consistency, HTTP API
- **Cons**: Different API (HTTP/gRPC, not better-sqlite3), requires migration, latency overhead
- **Use case**: True distributed database needs

### 4. Marmot
- **Description**: Postgres-protocol compatible SQLite replication
- **Pros**: Real-time streaming replication, read replicas
- **Cons**: Still single writer, requires Postgres wire protocol support
- **Use case**: Read scaling only

### 5. Turso (libSQL)
- **Description**: Commercial fork of SQLite with replication
- **Pros**: Multi-region, managed service, SQLite compatible
- **Cons**: Vendor lock-in, requires libSQL client, costs
- **Use case**: Production multi-region deployments

## Recommended Architecture: Guild-Based Pod Assignment

### Concept
Since Discord bots can shard by guild, we can run multiple pods where each pod handles a subset of guilds. This avoids the multi-writer SQLite problem because each pod has its own SQLite database for its assigned guilds.

### Architecture Components

#### 1. Config Service (New)
- **Purpose**: Manages guild-to-pod assignments
- **Storage**: PostgreSQL or etcd for distributed configuration
- **API**: 
  - `GET /guild-assignments` - Returns current guild→pod mapping
  - `POST /reassign-guild` - Move guild to different pod
  - `GET /pod-health` - Health status of all gateway pods
- **Deployment**: Standard Deployment (stateless, can scale horizontally)

#### 2. Gateway Pods (Modified)
- **Purpose**: Connect to Discord gateway for assigned guilds only
- **Storage**: SQLite local to each pod (one DB per pod)
- **Environment Variables**:
  - `POD_ID`: Unique identifier for this pod
  - `CONFIG_SERVICE_URL`: URL of config service
  - `ASSIGNED_GUILDS`: Comma-separated guild IDs (or fetch from config service)
- **Deployment**: StatefulSet with multiple replicas, each with own volume
- **Scaling**: Manual or automated based on guild count per pod

#### 3. HTTP Service (Modified)
- **Purpose**: Handles webhooks and web portal
- **Routing**: Routes Discord interactions to appropriate gateway pod
- **Storage**: Read-only access to aggregated data OR routes to gateway pods
- **Deployment**: Standard Deployment (can scale horizontally)

### Discord.js Sharding Considerations
Discord.js supports automatic sharding when a bot reaches 2,500 guilds. We need to:
1. **Manually control shard assignment**: Use Discord.js ShardingManager or manual shard control
2. **Assign shard ranges to pods**: Each pod handles specific shard IDs
3. **Update on guild addition**: When bot joins new guild, config service assigns it to least-loaded pod

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Load Balancer / Ingress                  │
│                      (nginx-ingress-controller)                  │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 │ HTTP Traffic
                 │
                 ├─────────────────────┬──────────────────────┐
                 │                     │                      │
                 ▼                     ▼                      ▼
┌────────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐
│   HTTP Service Pods    │  │   HTTP Service Pods  │  │  Config Service │
│   (Deployment: 2+)     │  │   (Deployment: 2+)   │  │  (Deployment: 2)│
│                        │  │                      │  │                 │
│ - Webhooks             │  │ - Webhooks           │  │ - PostgreSQL DB │
│ - Web Portal           │  │ - Web Portal         │  │ - Guild→Pod map │
│ - Routes to Gateway    │  │ - Routes to Gateway  │  │ - Health checks │
└────────────────────────┘  └──────────────────────┘  └─────────────────┘
         │                           │                         │
         │                           │                         │
         └───────────────┬───────────┘                         │
                         │ Internal HTTP                       │
                         │                                     │
                         │                              Queries assignments
                         │                                     │
         ┌───────────────┼─────────────────────────────────────┘
         │               │                    │
         ▼               ▼                    ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Gateway Pod 0  │ │  Gateway Pod 1  │ │  Gateway Pod N  │
│ (StatefulSet)   │ │ (StatefulSet)   │ │ (StatefulSet)   │
│                 │ │                 │ │                 │
│ - Discord.js    │ │ - Discord.js    │ │ - Discord.js    │
│ - Guilds 0-99   │ │ - Guilds 100-199│ │ - Guilds N-M    │
│ - SQLite DB     │ │ - SQLite DB     │ │ - SQLite DB     │
│ - Local Volume  │ │ - Local Volume  │ │ - Local Volume  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
         │                   │                   │
         │                   │                   │
         └───────────────────┴───────────────────┘
                             │
                             │ Discord Gateway WebSocket
                             │
                             ▼
                    ┌─────────────────┐
                    │  Discord API    │
                    │  (External)     │
                    └─────────────────┘
```

### Traffic Flow

#### Discord Events (Guild-specific)
1. Discord Gateway sends event to Gateway Pod
2. Event is for guild X
3. Gateway Pod 0 handles it (if guild X is assigned to Pod 0)
4. Updates local SQLite database

#### HTTP Requests (Web Portal)
1. User makes request via Load Balancer
2. Nginx routes to any HTTP Service Pod
3. HTTP Service determines which guild is involved
4. Routes request to appropriate Gateway Pod (via internal Service)
5. Gateway Pod queries its SQLite and returns data

#### Discord Interactions (Commands, Buttons)
1. Discord sends interaction webhook to Load Balancer
2. Nginx routes to any HTTP Service Pod
3. HTTP Service extracts guild_id from interaction
4. Queries Config Service for pod assignment
5. Forwards to appropriate Gateway Pod
6. Gateway Pod processes command and responds

## Implementation Plan

### Phase 1: Config Service Setup
1. Create new PostgreSQL database for config service
2. Implement config service API (Node.js/Express)
3. Define schema:
   ```sql
   CREATE TABLE guild_assignments (
     guild_id VARCHAR(20) PRIMARY KEY,
     pod_id INT NOT NULL,
     assigned_at TIMESTAMP DEFAULT NOW(),
     last_heartbeat TIMESTAMP
   );
   
   CREATE TABLE pod_health (
     pod_id INT PRIMARY KEY,
     status VARCHAR(20),  -- 'active', 'draining', 'offline'
     guild_count INT,
     last_heartbeat TIMESTAMP,
     capacity INT DEFAULT 100
   );
   ```
4. Deploy config service to K8s

### Phase 2: Refactor Gateway Connection
1. Add environment variable support for guild filtering
2. Modify `app/discord/client.server.ts` to accept guild filter
3. Implement guild assignment fetch from config service
4. Add pod registration and heartbeat to config service
5. Filter Discord events by assigned guilds

### Phase 3: HTTP Service Routing
1. Create internal Service for gateway pods
2. Implement guild-based routing in HTTP service
3. Add config service client to route requests
4. Handle cases where guild assignment changes mid-request

### Phase 4: Kubernetes Manifests
1. Create new StatefulSet for gateway pods with N replicas
2. Create Deployment for HTTP service (separate from gateway)
3. Create Deployment for config service
4. Add PostgreSQL for config service (or use managed service)
5. Update Ingress to route to HTTP service
6. Add HPA (Horizontal Pod Autoscaler) for HTTP service

### Phase 5: Guild Reassignment Logic
1. Implement rebalancing algorithm (e.g., move guild from overloaded pod)
2. Add graceful guild transfer:
   - Stop processing events for guild on old pod
   - Export guild data from old pod's SQLite
   - Import to new pod's SQLite
   - Update config service
   - Start processing on new pod
3. Add admin API for manual guild reassignment

## Alternative: Simpler Approach with LiteFS

If true horizontal scaling isn't required immediately, we can use LiteFS for multi-region read replicas:

```
┌─────────────────────────────────────────┐
│         Load Balancer / Ingress          │
└────────────────┬────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
        ▼                 ▼
┌───────────────┐  ┌───────────────┐
│  Primary Pod  │  │  Replica Pod  │
│  (LiteFS)     │  │  (LiteFS)     │
│  Read/Write   │  │  Read Only    │
│  SQLite DB    │  │  SQLite DB    │
└───────────────┘  └───────────────┘
        │                 │
        └────────┬────────┘
                 │ LiteFS Replication
                 │
                 ▼
          Discord Gateway
```

This is simpler but only provides:
- Read scaling (multiple replicas serve read traffic)
- High availability (replica can be promoted to primary)
- Not true horizontal scaling (still single writer)

## Recommended Approach

**Start with Guild-Based Pod Assignment** because:
1. Fits Discord's architecture (guilds are natural boundaries)
2. No vendor lock-in or special database requirements
3. True horizontal scaling of both reads and writes
4. Clear path for growth (add more gateway pods)
5. Complexity is manageable and well-isolated

## Operational Considerations

### Monitoring
- Guild distribution across pods
- SQLite database size per pod
- Event processing latency per pod
- Config service availability

### Backup Strategy
- Each gateway pod backs up its SQLite to S3 with Litestream
- Config service PostgreSQL has standard backup
- Guild data can be reconstructed from Discord API if needed

### Disaster Recovery
1. Config service failure: Gateway pods cache assignments locally
2. Gateway pod failure: Config service reassigns guilds to healthy pods
3. Data loss: Restore from S3 + replay Discord events if audit log available

## Next Steps

1. Create config service schema and API
2. Implement guild assignment logic
3. Refactor gateway initialization to support filtering
4. Create new K8s manifests
5. Deploy to staging environment
6. Test guild reassignment
7. Document operational runbook
