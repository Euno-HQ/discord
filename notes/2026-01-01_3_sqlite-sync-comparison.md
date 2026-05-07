# SQLite Replication Solutions Comparison

This document provides a detailed comparison of SQLite replication and synchronization tools for enabling load-balanced deployments.

## Overview Table

| Solution | Type | Write Model | Read Model | Consistency | Complexity | Production Ready | Best For |
|----------|------|-------------|------------|-------------|------------|------------------|----------|
| **Litestream** | Streaming backup | Single writer | Async replicas | Eventual | Low | ✅ Yes | DR, read replicas |
| **LiteFS** | FUSE filesystem | Single writer (leader) | Sync replicas | Strong | Medium | ✅ Yes | Geo-distribution |
| **rqlite** | Raft-based DB | Distributed writes | Strong consistency | Strong | High | ✅ Yes | True distributed DB |
| **Turso/libSQL** | Managed service | Multi-writer | Sync replicas | Strong | Low | ✅ Yes | Commercial projects |
| **Marmot** | Postgres protocol | Single writer | Streaming replicas | Strong | Medium | ⚠️ Beta | Read scaling |
| **Dqlite** | Raft for Go | Distributed writes | Strong consistency | Strong | High | ✅ Yes | Go applications |

## Detailed Analysis

### 1. Litestream

**Description**: Continuous streaming backup to object storage (S3, GCS, Azure, etc.)

**How it works**:
- Monitors SQLite WAL (Write-Ahead Log) file
- Streams changes to object storage in real-time
- Provides point-in-time recovery
- Can restore from any point in the backup timeline

**Architecture**:
```
┌─────────────┐
│  Primary    │
│  SQLite DB  │──writes──┐
└─────────────┘          │
       │                 │
   read/write            │
       │                 ▼
┌──────────────┐   ┌─────────────┐
│ Application  │   │ Litestream  │
│              │   │  Sidecar    │
└──────────────┘   └─────────────┘
                          │
                     continuous
                      streaming
                          │
                          ▼
                   ┌─────────────┐
                   │ S3 / Object │
                   │  Storage    │
                   └─────────────┘
                          │
                      restore to
                          │
                          ▼
                   ┌─────────────┐
                   │  Replica    │
                   │  SQLite DB  │
                   └─────────────┘
```

**Pros**:
- ✅ Very low overhead (~1-2% performance impact)
- ✅ Battle-tested (used by fly.io, many production apps)
- ✅ Simple to integrate (run as sidecar)
- ✅ Cheap storage (object storage)
- ✅ Point-in-time recovery
- ✅ Works with standard better-sqlite3

**Cons**:
- ❌ Async replication (seconds of lag)
- ❌ Read replicas are not real-time
- ❌ Still single writer
- ❌ Restore process takes time (not instant failover)

**Code Integration**:
```typescript
// No code changes needed - run as sidecar container
// Configure via litestream.yml
```

**Use Cases**:
- Disaster recovery
- Read replicas with eventual consistency acceptable
- Backup strategy
- **Fits our need**: As backup solution for gateway pods

**Recommendation**: ✅ **Use this** for continuous backup of gateway pod SQLite files

---

### 2. LiteFS

**Description**: FUSE-based distributed filesystem for SQLite by Fly.io

**How it works**:
- Mounts a virtual filesystem that looks like regular files
- Elects a "primary" node for writes
- Replicates writes to all "replica" nodes
- Uses HTTP/2 for replication protocol

**Architecture**:
```
┌──────────────────────────────────────────┐
│             LiteFS Cluster               │
│                                          │
│  ┌────────────┐      ┌────────────┐     │
│  │  Primary   │─────▶│  Replica   │     │
│  │  Node      │  rep │   Node     │     │
│  │            │◀─────│            │     │
│  │ /data/db   │      │ /data/db   │     │
│  │ (FUSE)     │      │ (FUSE)     │     │
│  └────────────┘      └────────────┘     │
│       │ lease              │             │
│       │                    │             │
│       ▼                    ▼             │
│  ┌─────────────────────────────┐        │
│  │      Consul / etcd          │        │
│  │   (Leader Election)         │        │
│  └─────────────────────────────┘        │
└──────────────────────────────────────────┘
```

**Pros**:
- ✅ Transparent to application (just use file path)
- ✅ Automatic leader election
- ✅ Low replication lag (milliseconds)
- ✅ Works with existing SQLite libraries
- ✅ Good for geo-distribution

**Cons**:
- ❌ Requires FUSE support (may need privileged containers)
- ❌ Still single writer (primary node)
- ❌ Adds complexity (leader election, cluster management)
- ❌ Kubernetes StatefulSet becomes more complex
- ❌ Potential for split-brain scenarios

**Code Integration**:
```typescript
// No code changes - just mount LiteFS volume
// Configure via litefs.yml
```

**Kubernetes Considerations**:
```yaml
# Requires privileged mode or FUSE device
securityContext:
  privileged: true
```

**Use Cases**:
- Multi-region deployments with single writer
- Geographic distribution
- High availability with automatic failover
- **Doesn't fit our need**: Still single writer, we need multiple

**Recommendation**: ❌ **Don't use** - Adds complexity without solving multi-writer problem

---

### 3. rqlite

**Description**: Distributed relational database built on SQLite using Raft consensus

**How it works**:
- SQLite embedded in distributed system
- Raft protocol for consensus
- Every write goes through leader, replicated to followers
- Provides HTTP and gRPC API (not native SQLite)

**Architecture**:
```
┌─────────────────────────────────────────────┐
│            rqlite Cluster                   │
│                                             │
│  ┌──────────┐   ┌──────────┐   ┌─────────┐│
│  │  Leader  │──▶│ Follower │──▶│Follower ││
│  │  Node    │   │  Node    │   │  Node   ││
│  │          │◀──│          │◀──│         ││
│  │ SQLite   │   │ SQLite   │   │ SQLite  ││
│  └──────────┘   └──────────┘   └─────────┘│
│       │              │              │      │
│       └──────────────┴──────────────┘      │
│                  Raft                      │
└─────────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    HTTP/gRPC       HTTP/gRPC     HTTP/gRPC
    Clients         Clients       Clients
```

**Pros**:
- ✅ True distributed writes
- ✅ Strong consistency
- ✅ Automatic failover
- ✅ Linear scaling of reads
- ✅ Production-ready

**Cons**:
- ❌ **MAJOR**: Different API (HTTP/gRPC, not better-sqlite3)
- ❌ Requires significant code rewrite
- ❌ More resource intensive
- ❌ Higher latency for writes (Raft overhead)
- ❌ Different SQL dialect edge cases

**Code Integration**:
```typescript
// Complete rewrite required
import { Client } from 'rqlite-js';

const client = new Client('http://rqlite-cluster:4001');
// Can't use kysely directly with better-sqlite3
// Need HTTP-based client
```

**Use Cases**:
- New applications needing distributed SQL
- When strong consistency is critical
- When you can afford API migration
- **Doesn't fit our need**: Too much migration work

**Recommendation**: ❌ **Don't use** - Requires full rewrite of database layer

---

### 4. Turso / libSQL

**Description**: Commercial fork of SQLite with built-in replication (by ChiselStrike)

**How it works**:
- Fork of SQLite with replication built-in
- Managed cloud service or self-hosted
- Edge replication for low-latency reads
- Multi-writer with conflict resolution

**Architecture**:
```
┌─────────────────────────────────────────┐
│          Turso Platform                 │
│                                         │
│  ┌──────────┐   ┌──────────┐          │
│  │ Primary  │──▶│  Edge    │          │
│  │ Region   │   │ Replica  │          │
│  │          │◀──│          │          │
│  │ libSQL   │   │ libSQL   │          │
│  └──────────┘   └──────────┘          │
│       │              │                 │
│       └──────────────┘                 │
│      Managed Service                   │
└─────────────────────────────────────────┘
         │              │
         ▼              ▼
    Clients         Clients
    (libSQL SDK)    (libSQL SDK)
```

**Pros**:
- ✅ SQLite-compatible API
- ✅ Built-in replication
- ✅ Multi-region support
- ✅ Managed service (less ops work)
- ✅ Edge caching

**Cons**:
- ❌ **MAJOR**: Requires libSQL client (not better-sqlite3)
- ❌ Vendor lock-in
- ❌ Costs (paid service)
- ❌ Self-hosted version more complex
- ❌ Still relatively new

**Code Integration**:
```typescript
// Requires migration from better-sqlite3
import { createClient } from '@libsql/client';

const client = createClient({
  url: 'libsql://...',
  authToken: '...',
});
// Would need to adapt kysely to use libSQL
```

**Use Cases**:
- New projects needing edge replication
- When budget allows for managed service
- Global applications with multi-region needs
- **Doesn't fit our need**: Vendor lock-in, requires migration

**Recommendation**: ❌ **Don't use** - Adds cost and vendor lock-in

---

### 5. Marmot

**Description**: Streaming SQLite replication with Postgres wire protocol

**How it works**:
- Primary SQLite database
- Streams changes to read replicas
- Replicas accessible via Postgres protocol
- Uses logical replication

**Architecture**:
```
┌──────────────┐
│   Primary    │
│  SQLite DB   │
│              │
└──────────────┘
       │
       │ writes
       │
┌──────────────┐
│  Marmot      │
│  Server      │
└──────────────┘
       │
       │ streaming
       │ replication
       ▼
┌──────────────┐   ┌──────────────┐
│   Replica    │   │   Replica    │
│  SQLite DB   │   │  SQLite DB   │
│ (Read-only)  │   │ (Read-only)  │
└──────────────┘   └──────────────┘
```

**Pros**:
- ✅ Real-time streaming replication
- ✅ Multiple read replicas
- ✅ Postgres wire protocol (standard clients)

**Cons**:
- ❌ Still beta/experimental
- ❌ Single writer only
- ❌ Additional complexity
- ❌ Limited production use

**Use Cases**:
- Read scaling for analytics
- When you need Postgres compatibility
- **Doesn't fit our need**: Still single writer

**Recommendation**: ⚠️ **Maybe** - Only for read scaling, not multi-writer

---

### 6. Dqlite

**Description**: Distributed SQLite using Raft consensus for Go applications

**How it works**:
- Similar to rqlite but designed for Go
- Embedded in Go applications
- Uses Raft for consensus
- C bindings to SQLite

**Architecture**:
```
┌─────────────────────────────────────┐
│         Go Application              │
│                                     │
│  ┌──────────────────────────────┐  │
│  │      Dqlite Library          │  │
│  │                              │  │
│  │  ┌────────┐  ┌────────┐     │  │
│  │  │ SQLite │  │  Raft  │     │  │
│  │  │  Core  │  │ Engine │     │  │
│  │  └────────┘  └────────┘     │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Pros**:
- ✅ True distributed writes
- ✅ Strong consistency
- ✅ Designed for Go

**Cons**:
- ❌ **MAJOR**: Go only (we use TypeScript/Node.js)
- ❌ Different API
- ❌ Requires full rewrite

**Recommendation**: ❌ **Don't use** - Wrong language ecosystem

---

## Recommendation for mod-bot

### Current Need Analysis

We need to:
1. ✅ Scale horizontally (multiple pods)
2. ✅ Handle multiple guilds
3. ✅ Keep SQLite (constraint)
4. ✅ Minimize code changes
5. ✅ Maintain better-sqlite3 compatibility

### Recommended Solution: **Guild-Based Sharding + Litestream**

Instead of trying to make SQLite work with multiple writers, embrace its single-writer nature by:

1. **Guild-Based Sharding**: 
   - Each gateway pod handles a subset of guilds
   - Each pod has its own SQLite database
   - No cross-pod database access needed
   - Natural fit with Discord's guild-based architecture

2. **Litestream for Backup**:
   - Each gateway pod runs Litestream sidecar
   - Continuous backup to S3
   - Fast recovery if pod fails
   - Low overhead

3. **Config Service**:
   - PostgreSQL (or managed DB) for guild assignments
   - Small amount of data (just mappings)
   - Can use any managed database

**Why this is better than replication**:
- ✅ No code changes needed
- ✅ Keep better-sqlite3
- ✅ True horizontal scaling
- ✅ Simple to understand and operate
- ✅ No vendor lock-in
- ✅ Low cost

**What we avoid**:
- ❌ Complex replication protocols
- ❌ API migrations
- ❌ Split-brain scenarios
- ❌ Replication lag
- ❌ Vendor lock-in

## Summary Table for Our Use Case

| Solution | Fits Need? | Code Changes | Ops Complexity | Cost | Verdict |
|----------|-----------|--------------|----------------|------|---------|
| **Guild Sharding + Litestream** | ✅ Perfect | Minimal | Low | $ | ✅ **BEST** |
| Litestream only | ⚠️ Partial | None | Low | $ | Good for backup only |
| LiteFS | ⚠️ Partial | None | Medium | $ | Adds complexity |
| rqlite | ❌ No | Complete rewrite | Medium | $$ | Too much work |
| Turso/libSQL | ❌ No | Significant | Low | $$$ | Vendor lock-in |
| Marmot | ❌ No | Moderate | Medium | $ | Beta, single writer |
| Dqlite | ❌ No | Complete rewrite | High | $ | Wrong language |

## Implementation Path

1. ✅ Use **Litestream** as sidecar in gateway pods (backup/DR)
2. ✅ Implement **guild-based sharding** (main scaling solution)
3. ✅ Add **config service** with PostgreSQL for assignments
4. Future: Consider **Marmot** if we need read replicas for analytics

This approach gives us true horizontal scaling while keeping SQLite and minimizing changes.
