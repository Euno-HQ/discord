# Load Balancer Architecture Documentation Index

This directory contains comprehensive documentation for enabling load balancer support in the mod-bot service.

## Quick Links

### Start Here
- **[Executive Summary](2026-01-01_5_executive-summary.md)** - TL;DR with decision rationale and next steps
- **[ASCII Diagrams](2026-01-01_6_ascii-diagrams.md)** - Visual architecture in plain text

### Deep Dive
1. **[Architecture Overview](2026-01-01_1_load-balancer-architecture.md)** - Complete analysis of current state, constraints, and proposed solution
2. **[Architecture Diagrams](2026-01-01_2_architecture-diagrams.md)** - Mermaid diagrams showing request flows, deployments, and scaling
3. **[SQLite Sync Comparison](2026-01-01_3_sqlite-sync-comparison.md)** - Detailed evaluation of 6 replication solutions
4. **[Implementation Guide](2026-01-01_4_implementation-guide.md)** - Step-by-step code and deployment instructions

## Document Structure

### 2026-01-01_1_load-balancer-architecture.md
**What**: Comprehensive architectural analysis  
**Contains**:
- Current architecture assessment
- SQLite constraint analysis
- Proposed guild-based sharding solution
- Config service design
- Alternative approaches evaluated
- Operational considerations
- Risk mitigation strategies

**Read this if**: You want to understand the full technical approach

---

### 2026-01-01_2_architecture-diagrams.md
**What**: Visual representations using Mermaid  
**Contains**:
- Current vs. proposed architecture
- Request flow diagrams (events, HTTP, interactions)
- Guild reassignment process
- Deployment architecture
- Scaling decisions flowchart
- Backup and recovery flows
- Cost comparison

**Read this if**: You prefer visual explanations

---

### 2026-01-01_3_sqlite-sync-comparison.md
**What**: Detailed comparison of SQLite replication tools  
**Contains**:
- Litestream (continuous backup) ✅ Recommended
- LiteFS (FUSE-based replication) ❌ Rejected
- rqlite (Raft-based distributed DB) ❌ Rejected
- Turso/libSQL (commercial fork) ❌ Rejected
- Marmot (Postgres-protocol streaming) ⚠️ Future
- Dqlite (Go-based Raft) ❌ Rejected
- Pros/cons, architecture, code examples for each

**Read this if**: You want to understand why we chose guild-based sharding over SQLite replication

---

### 2026-01-01_4_implementation-guide.md
**What**: Step-by-step implementation instructions  
**Contains**:
- Phase 1: Config service setup (code + deployment)
- Phase 2: Gateway modification (environment variables, filtering)
- Phase 3: HTTP service routing (request forwarding)
- Phase 4: Deployment procedures
- Phase 5: Migration strategy from old architecture
- Testing checklist
- Monitoring setup
- Rollback procedures
- Performance tuning tips

**Read this if**: You're implementing the solution

---

### 2026-01-01_5_executive-summary.md
**What**: High-level overview for decision makers  
**Contains**:
- Problem statement
- Recommended solution (guild-based sharding)
- Benefits and tradeoffs
- Implementation roadmap (6 phases)
- Cost analysis ($10/mo → $45-50/mo)
- Risk assessment
- Success metrics
- Alternatives rejected and why

**Read this if**: You need to approve or understand the business case

---

### 2026-01-01_6_ascii-diagrams.md
**What**: Plain text architecture diagrams  
**Contains**:
- Current single-pod architecture
- Proposed multi-pod architecture
- Request flows (events, HTTP, commands)
- Guild reassignment process
- Scaling scenarios
- Failure recovery scenarios
- Data flow architecture
- Monitoring architecture

**Read this if**: You want quick visual reference without rendering Mermaid

---

## Kubernetes Manifests

All Kubernetes manifests are in `/cluster/proposed/`:

```
cluster/proposed/
├── README.md                   # Deployment guide
├── config-service.yaml         # Config service + PostgreSQL
├── gateway-service.yaml        # Gateway StatefulSet + Litestream
├── http-service.yaml           # HTTP service + HPA
├── ingress.yaml                # Load balancer routing
├── pdb.yaml                    # Pod Disruption Budgets
├── kustomization.yaml          # Kustomize config
└── variable-config.yaml        # Variable references
```

See [cluster/proposed/README.md](../cluster/proposed/README.md) for deployment instructions.

## Key Decisions

### 1. Guild-Based Sharding over SQLite Replication
**Why**: SQLite replication tools either require API rewrites (rqlite), add vendor lock-in (Turso), or still only support single writer (LiteFS). Guild-based sharding works with existing code and scales horizontally.

### 2. Litestream for Backup
**Why**: Low overhead, battle-tested, works with existing better-sqlite3, provides point-in-time recovery.

### 3. Separate HTTP and Gateway Services
**Why**: Allows independent scaling. HTTP service can scale 2-10x for traffic spikes while gateway pods remain stable.

### 4. PostgreSQL for Config Service
**Why**: Small dataset (just guild assignments), needs multi-writer support, standard operational tools available.

### 5. Manual Gateway Scaling
**Why**: Gateway pods are stateful and require guild reassignment. Keep control rather than auto-scaling.

## Architecture Summary

```
┌─────────────┐
│ Load Balancer│
└──────┬──────┘
       │
   ┌───┴───┬─────────┬────────┐
   │       │         │        │
   v       v         v        v
[HTTP] [HTTP]  [HTTP] ... [HTTP]   ← Stateless, HPA: 2-10 replicas
   │       │         │        │
   └───┬───┴────┬────┴────┬───┘
       │        │         │
       v        v         v
  [Config] [Config]          ← Stateless, 2 replicas
       │        │
       └───┬────┘
           │
           v
    [PostgreSQL]              ← Guild assignments
           │
       ┌───┴────┬──────┬────┐
       │        │      │    │
       v        v      v    v
   [Gateway] [Gateway] ... [Gateway]  ← Stateful: 3-10 replicas
   SQLite-0  SQLite-1     SQLite-N
       │        │            │
       └────────┴────────────┘
                │
           [Litestream]
                │
                v
         [S3 Backup]
```

## Timeline

- **Week 1-2**: Config service implementation
- **Week 2-3**: Gateway modification
- **Week 3-4**: HTTP service separation
- **Week 4**: Litestream integration
- **Week 5-6**: Production deployment
- **Week 7+**: Optimization and tuning

Total: **6-8 weeks**

## Cost

- **Current**: ~$10/month (single pod)
- **Proposed**: ~$45-50/month (multi-pod with HA)
- **ROI**: Enables horizontal scaling, 99.9% uptime, zero-downtime deployments

## Success Metrics

- [ ] P95 latency < 100ms
- [ ] 99.9% uptime
- [ ] Zero-downtime deployments
- [ ] Auto-recovery from failures < 30s
- [ ] Support 1000+ guilds per pod
- [ ] HTTP service auto-scales 2-10 replicas

## Status

✅ **Analysis Complete**  
✅ **Architecture Designed**  
✅ **Manifests Created**  
✅ **Documentation Written**  
⏳ **Awaiting Team Review**

## Next Steps

1. **Review** - Team reviews all documentation
2. **Approval** - Sign off on cost and approach
3. **Staging** - Deploy to staging environment
4. **Testing** - Run full test suite and load tests
5. **Production** - Gradual rollout with monitoring

## Questions?

For questions or clarifications, refer to:
- Technical details → [Implementation Guide](2026-01-01_4_implementation-guide.md)
- Business case → [Executive Summary](2026-01-01_5_executive-summary.md)
- Visual overview → [ASCII Diagrams](2026-01-01_6_ascii-diagrams.md)
- Full analysis → [Architecture Overview](2026-01-01_1_load-balancer-architecture.md)

---

**Document Version**: 1.0  
**Last Updated**: 2026-01-01  
**Author**: AI Engineering Assistant  
**Status**: Complete, Ready for Review
