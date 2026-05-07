# Load Balancer Architecture - Quick Reference Card

## 🎯 One-Sentence Summary
Split guilds across multiple pods, each with its own SQLite database, coordinated by a config service.

## 📊 Current vs Proposed

| Aspect | Current | Proposed |
|--------|---------|----------|
| **Pods** | 1 | 7-20 (3 gateway, 2-10 HTTP, 2 config, 1 PostgreSQL) |
| **Scaling** | ❌ None | ✅ Horizontal |
| **Cost** | $10/mo | $45-50/mo |
| **HA** | ❌ No | ✅ Yes |
| **SQLite** | 1 database | 3-10 databases (1 per gateway pod) |
| **Load Balancer** | ❌ Not supported | ✅ Supported |

## 🏗️ Architecture at a Glance

```
Users → LB → HTTP Pods → Config Service → Gateway Pods → Discord
                             ↓                    ↓
                        PostgreSQL           SQLite + Litestream
                       (guild→pod)              (guild data)
```

## 📦 Components

### HTTP Service
- **Purpose**: Web portal + webhook routing
- **Type**: Deployment (stateless)
- **Replicas**: 2-10 (HPA)
- **Scales**: Automatically on CPU/memory

### Config Service  
- **Purpose**: Guild assignment management
- **Type**: Deployment (stateless)
- **Replicas**: 2
- **Database**: PostgreSQL

### Gateway Service
- **Purpose**: Discord gateway connection
- **Type**: StatefulSet (stateful)
- **Replicas**: 3-10
- **Database**: SQLite (1 per pod)
- **Backup**: Litestream → S3

## 🔑 Key Decisions

| Decision | Rationale |
|----------|-----------|
| Guild-based sharding | Natural fit with Discord architecture |
| Keep SQLite | No migration, proven, fast |
| Litestream backup | Low overhead, battle-tested |
| PostgreSQL for config | Multi-writer, small dataset |
| Separate HTTP/Gateway | Independent scaling |

## 🚫 What We're NOT Doing

❌ Migrating to PostgreSQL (too much work)  
❌ Using rqlite (different API)  
❌ Using LiteFS (still single writer)  
❌ Using Turso (vendor lock-in)  
❌ Sharing SQLite across pods (impossible)  

## ⚡ How It Works

### Discord Event
```
Discord → Gateway Pod 0 → SQLite 0 → Litestream → S3
                         (guild assigned to pod 0)
```

### HTTP Request
```
User → LB → HTTP Pod → Config: "Which pod has guild 42?"
                    → Gateway Pod 0 → SQLite 0 → Response
```

### Guild Assignment
```
New Guild → Config Service → Least loaded pod
                          → Update PostgreSQL
                          → Gateway pod starts handling
```

## 📈 Scaling Path

```
Phase 1: 3 gateway pods (0-99 guilds each)
Phase 2: 5 gateway pods (rebalance to ~60 each)
Phase 3: 10 gateway pods (100+ guilds each)
```

## 💵 Cost Breakdown

```
Gateway pods (3x):      $15/mo
HTTP pods (2-10x):      $10/mo
Config pods (2x):       $5/mo
PostgreSQL:             $8/mo
Volumes (3x):           $3/mo
S3 backup:              $5/mo
─────────────────────────────
Total:                  $46/mo
```

## ⏱️ Timeline

```
Week 1-2:  Config service
Week 3-4:  Gateway changes
Week 5-6:  Production deploy
Week 7+:   Optimization
```

## 🎯 Success Criteria

- [ ] P95 latency < 100ms
- [ ] 99.9% uptime
- [ ] Zero-downtime deploys
- [ ] < 30s pod recovery
- [ ] 1000+ guilds/pod

## 🔥 Quick Start

```bash
# 1. Deploy config service
kubectl apply -f cluster/proposed/config-service.yaml

# 2. Deploy gateway pods
kubectl apply -f cluster/proposed/gateway-service.yaml

# 3. Deploy HTTP service
kubectl apply -f cluster/proposed/http-service.yaml

# 4. Update ingress
kubectl apply -f cluster/proposed/ingress.yaml

# 5. Verify
kubectl get pods -l app=mod-bot
```

## 📚 Documentation Map

| Need | Read |
|------|------|
| Exec summary | 2026-01-01_5_executive-summary.md |
| Visual diagrams | 2026-01-01_6_ascii-diagrams.md |
| Full analysis | 2026-01-01_1_load-balancer-architecture.md |
| Implementation | 2026-01-01_4_implementation-guide.md |
| Tool comparison | 2026-01-01_3_sqlite-sync-comparison.md |
| Navigation | LOAD_BALANCER_INDEX.md |

## ⚠️ Common Questions

**Q: Why not just use PostgreSQL?**  
A: SQLite is simpler, faster for our use case, and already works. Migration would take months.

**Q: Why not use [SQLite replication tool]?**  
A: They all have major limitations (see comparison doc). Guild sharding is simpler and proven.

**Q: What if a pod fails?**  
A: Kubernetes restarts it, Litestream restores from S3, guilds back online in < 30s.

**Q: How do we rebalance guilds?**  
A: Config service can reassign guilds. Stop → Export → Import → Start. Takes ~2 minutes.

**Q: Can we scale down?**  
A: Yes, but requires guild reassignment. Not instant, but possible.

**Q: What about cross-guild queries?**  
A: HTTP service can query multiple gateway pods and aggregate results.

## 🎓 Key Insights

1. **SQLite isn't the problem** - Single-writer is fine if you partition data
2. **Discord's architecture helps** - Guilds are natural boundaries  
3. **Simple is better** - Standard tools beat fancy solutions
4. **Cost is worth it** - 5x cost for production-grade scaling is reasonable
5. **No silver bullet** - All SQLite replication tools have tradeoffs

## 🚀 Bottom Line

**Status**: ✅ Ready to implement  
**Confidence**: High (proven patterns)  
**Risk**: Medium (new architecture)  
**Effort**: 6-8 weeks  
**Impact**: Enables horizontal scaling + HA  

**Recommendation**: ✅ Proceed with implementation

---

**Version**: 1.0  
**Updated**: 2026-01-01  
**Next Step**: Team review & approval
