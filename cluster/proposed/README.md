# Proposed Load-Balanced Architecture

This directory contains Kubernetes manifests for a load-balanced architecture that allows horizontal scaling while maintaining SQLite as the database.

## Architecture Overview

The system is split into three service layers:

1. **HTTP Service** (Stateless, 2+ replicas)
   - Handles web portal traffic
   - Receives Discord webhooks and interactions
   - Routes guild-specific requests to appropriate gateway pods
   - Can scale horizontally via HPA

2. **Config Service** (Stateless, 2 replicas)
   - Manages guild-to-pod assignments
   - Stores mapping in PostgreSQL
   - Provides health status of gateway pods
   - Handles guild reassignment during scaling

3. **Gateway Service** (Stateful, 3+ replicas)
   - Connects to Discord gateway via websocket
   - Each pod handles a subset of guilds
   - Each pod has its own SQLite database
   - Backed up continuously to S3 via Litestream

## Files

- `config-service.yaml` - Config service deployment and PostgreSQL
- `http-service.yaml` - HTTP service deployment with HPA
- `gateway-service.yaml` - Gateway StatefulSet with Litestream sidecars
- `ingress.yaml` - Ingress routing external traffic to HTTP service
- `pdb.yaml` - Pod Disruption Budgets for high availability
- `kustomization.yaml` - Kustomize configuration
- `variable-config.yaml` - Variable references for kustomize

## Deployment

### Prerequisites

1. DigitalOcean Kubernetes cluster (or equivalent)
2. nginx-ingress-controller installed
3. cert-manager installed for TLS certificates
4. S3-compatible object storage (for Litestream backups)

### Secrets Required

```yaml
# modbot-env (existing secret, add these keys)
LITESTREAM_ACCESS_KEY_ID: <s3-access-key>
LITESTREAM_SECRET_ACCESS_KEY: <s3-secret-key>
LITESTREAM_BUCKET: <bucket-name>
LITESTREAM_ENDPOINT: <s3-endpoint>
LITESTREAM_REGION: <s3-region>

# config-service-secret (new secret)
DATABASE_URL: postgresql://user:pass@config-postgres:5432/mod_bot_config
POSTGRES_USER: postgres
POSTGRES_PASSWORD: <secure-password>
```

### Deploy Steps

1. **Create secrets**:
   ```bash
   kubectl create secret generic config-service-secret \
     --from-literal=DATABASE_URL=postgresql://... \
     --from-literal=POSTGRES_USER=postgres \
     --from-literal=POSTGRES_PASSWORD=...
   
   # Update existing modbot-env secret with Litestream credentials
   kubectl edit secret modbot-env
   ```

2. **Build config service image** (if separate):
   ```bash
   # Build config service application
   docker build -f Dockerfile.config -t ghcr.io/reactiflux/mod-bot-config:latest .
   docker push ghcr.io/reactiflux/mod-bot-config:latest
   ```

3. **Update k8s-context file**:
   ```bash
   cat > k8s-context <<EOF
   IMAGE=ghcr.io/reactiflux/mod-bot:sha-${GITHUB_SHA}
   IMAGE_CONFIG=ghcr.io/reactiflux/mod-bot-config:latest
   EOF
   ```

4. **Deploy with kustomize**:
   ```bash
   kubectl apply -k cluster/proposed/
   ```

5. **Verify deployment**:
   ```bash
   # Check all pods are running
   kubectl get pods -l app=mod-bot
   
   # Check services
   kubectl get svc -l app=mod-bot
   
   # Check gateway pod assignments
   kubectl logs -l component=gateway --tail=20
   ```

## Scaling

### HTTP Service
Automatically scales via HPA based on CPU/memory:
```bash
# View current scaling status
kubectl get hpa http-service-hpa

# Manually adjust if needed
kubectl patch hpa http-service-hpa -p '{"spec":{"minReplicas":5}}'
```

### Gateway Service
Scale manually (requires guild reassignment):
```bash
# Scale to 5 gateway pods
kubectl scale statefulset gateway --replicas=5

# Check new pod status
kubectl get pods -l component=gateway

# Guild reassignment happens automatically via config service
```

### Config Service
Can scale horizontally if needed:
```bash
kubectl scale deployment config-service --replicas=3
```

## Monitoring

Key metrics to monitor:

1. **Guild Distribution**:
   - Check how guilds are distributed across gateway pods
   - Ensure no single pod is overloaded

2. **HTTP Service**:
   - Request latency
   - Error rates
   - HPA scaling events

3. **Gateway Service**:
   - Discord connection status
   - Event processing latency
   - SQLite database size per pod
   - Litestream replication lag

4. **Config Service**:
   - Assignment query latency
   - PostgreSQL connection pool status
   - Guild reassignment frequency

## Rollback

To rollback to the original single-pod architecture:

```bash
# Switch back to original manifests
kubectl apply -k cluster/

# Delete new services
kubectl delete deployment http-service config-service
kubectl delete statefulset gateway config-postgres
kubectl delete svc http-service config-service gateway-internal config-postgres
kubectl delete hpa http-service-hpa
kubectl delete pdb http-service-pdb config-service-pdb gateway-pdb
```

## Migration Strategy

### Phase 1: Deploy alongside existing
1. Deploy new architecture in different namespace (e.g., `mod-bot-v2`)
2. Test with subset of guilds
3. Verify all functionality works

### Phase 2: Traffic migration
1. Update DNS/Ingress to point to new HTTP service
2. Monitor for issues
3. Keep old pod running for 24h as backup

### Phase 3: Data migration
1. Export guild data from old SQLite
2. Import into appropriate gateway pods
3. Verify data integrity

### Phase 4: Decommission old
1. Scale down old StatefulSet to 0
2. Delete old resources after 7 days
3. Delete old volume after 30 days

## Troubleshooting

### Gateway pod can't connect to Discord
- Check Discord token is valid
- Check pod has assigned guilds: `kubectl logs gateway-0 | grep "assigned guilds"`
- Check config service is accessible: `kubectl exec gateway-0 -- curl http://config-service:3001/health`

### HTTP service can't route to gateway
- Check gateway-internal service: `kubectl get svc gateway-internal`
- Check config service has guild assignments: `curl http://config-service:3001/guild-assignments`
- Check gateway pods are in Ready state: `kubectl get pods -l component=gateway`

### Config service database connection fails
- Check PostgreSQL pod: `kubectl logs config-postgres-0`
- Check secret exists: `kubectl get secret config-service-secret`
- Test connection: `kubectl exec config-service-xxx -- env | grep DATABASE_URL`

### Litestream backup not working
- Check S3 credentials: `kubectl get secret modbot-env -o yaml`
- Check Litestream logs: `kubectl logs gateway-0 -c litestream`
- Verify bucket exists and is accessible

## Cost Estimate

Compared to current single-pod deployment (~$10/month):

- 3x Gateway pods (256Mi, 50m CPU): ~$15/month
- 2x HTTP pods (256Mi, 50m CPU): ~$10/month  
- 2x Config pods (128Mi, 20m CPU): ~$5/month
- 1x PostgreSQL (256Mi, 100m CPU): ~$8/month
- 3x Volumes (1Gi each): ~$3/month
- S3 storage and transfer: ~$5/month

**Total: ~$45-50/month** (5x increase)

Benefits:
- True horizontal scaling capability
- Better fault tolerance
- Zero-downtime deployments
- Geographic distribution ready (with minor changes)

## Future Enhancements

1. **Auto-rebalancing**: Automatically move guilds between pods based on load
2. **Read replicas**: Add read-only gateway pods for analytics queries
3. **Multi-region**: Deploy gateway pods in multiple regions, assign guilds by timezone
4. **Metrics dashboard**: Grafana dashboard showing guild distribution and pod health
5. **A/B testing**: Route specific guilds to canary versions for testing
