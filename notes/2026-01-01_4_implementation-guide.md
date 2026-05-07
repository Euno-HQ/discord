# Implementation Guide: Load Balancer Support

This guide provides step-by-step instructions for implementing the guild-based load balancing architecture.

## Prerequisites

- Kubernetes cluster (DigitalOcean or equivalent)
- kubectl configured with cluster access
- Docker build environment
- S3-compatible object storage (DigitalOcean Spaces, AWS S3, etc.)
- PostgreSQL (managed service recommended)

## Phase 1: Config Service Implementation

### 1.1 Create Config Service Application

Create a new Express application for managing guild assignments:

**File**: `app/config-service/index.ts`

```typescript
import express from 'express';
import { Client } from 'pg';

const app = express();
app.use(express.json());

const db = new Client({
  connectionString: process.env.DATABASE_URL,
});

await db.connect();

// Initialize schema
await db.query(`
  CREATE TABLE IF NOT EXISTS guild_assignments (
    guild_id VARCHAR(20) PRIMARY KEY,
    pod_id INTEGER NOT NULL,
    assigned_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW()
  );
  
  CREATE TABLE IF NOT EXISTS pod_health (
    pod_id INTEGER PRIMARY KEY,
    pod_name VARCHAR(100),
    status VARCHAR(20),
    guild_count INTEGER DEFAULT 0,
    last_heartbeat TIMESTAMP DEFAULT NOW(),
    capacity INTEGER DEFAULT 100
  );
  
  CREATE INDEX IF NOT EXISTS idx_pod_id ON guild_assignments(pod_id);
  CREATE INDEX IF NOT EXISTS idx_pod_status ON pod_health(status);
`);

// Get guild assignment
app.get('/guild/:guildId/assignment', async (req, res) => {
  const { guildId } = req.params;
  const result = await db.query(
    'SELECT pod_id, pod_name FROM guild_assignments ga JOIN pod_health ph ON ga.pod_id = ph.pod_id WHERE guild_id = $1',
    [guildId]
  );
  
  if (result.rows.length === 0) {
    // Auto-assign to least loaded pod
    const pod = await getLeastLoadedPod();
    await assignGuildToPod(guildId, pod.pod_id);
    return res.json({ pod_id: pod.pod_id, pod_name: pod.pod_name });
  }
  
  res.json(result.rows[0]);
});

// Get all guild assignments
app.get('/guild-assignments', async (req, res) => {
  const result = await db.query('SELECT * FROM guild_assignments ORDER BY pod_id');
  res.json(result.rows);
});

// Register pod
app.post('/pod/register', async (req, res) => {
  const { pod_id, pod_name, capacity } = req.body;
  await db.query(
    `INSERT INTO pod_health (pod_id, pod_name, status, capacity, last_heartbeat)
     VALUES ($1, $2, 'active', $3, NOW())
     ON CONFLICT (pod_id) DO UPDATE SET
       pod_name = $2,
       status = 'active',
       capacity = $3,
       last_heartbeat = NOW()`,
    [pod_id, pod_name, capacity || 100]
  );
  res.json({ success: true });
});

// Pod heartbeat
app.post('/pod/:podId/heartbeat', async (req, res) => {
  const { podId } = req.params;
  const { guild_count } = req.body;
  
  await db.query(
    `UPDATE pod_health SET 
      last_heartbeat = NOW(),
      guild_count = $2,
      status = 'active'
     WHERE pod_id = $1`,
    [podId, guild_count || 0]
  );
  res.json({ success: true });
});

// Get pod health
app.get('/pods/health', async (req, res) => {
  const result = await db.query(
    `SELECT * FROM pod_health 
     WHERE last_heartbeat > NOW() - INTERVAL '2 minutes'
     ORDER BY pod_id`
  );
  res.json(result.rows);
});

// Reassign guild
app.post('/guild/:guildId/reassign', async (req, res) => {
  const { guildId } = req.params;
  const { target_pod_id } = req.body;
  
  await db.query(
    `UPDATE guild_assignments SET 
      pod_id = $2,
      assigned_at = NOW()
     WHERE guild_id = $1`,
    [guildId, target_pod_id]
  );
  
  // Update guild counts
  await updateGuildCounts();
  
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function getLeastLoadedPod() {
  const result = await db.query(
    `SELECT pod_id, pod_name, guild_count, capacity
     FROM pod_health
     WHERE status = 'active' 
       AND last_heartbeat > NOW() - INTERVAL '2 minutes'
     ORDER BY (guild_count::float / capacity::float) ASC
     LIMIT 1`
  );
  
  if (result.rows.length === 0) {
    throw new Error('No active pods available');
  }
  
  return result.rows[0];
}

async function assignGuildToPod(guildId: string, podId: number) {
  await db.query(
    `INSERT INTO guild_assignments (guild_id, pod_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET pod_id = $2`,
    [guildId, podId]
  );
  await updateGuildCounts();
}

async function updateGuildCounts() {
  await db.query(`
    UPDATE pod_health ph
    SET guild_count = (
      SELECT COUNT(*) FROM guild_assignments ga
      WHERE ga.pod_id = ph.pod_id
    )
  `);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Config service listening on port ${PORT}`);
});
```

### 1.2 Create Dockerfile for Config Service

**File**: `Dockerfile.config`

```dockerfile
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --only=production

COPY app/config-service ./app/config-service

CMD ["node", "app/config-service/index.ts"]
```

### 1.3 Deploy Config Service

```bash
# Build and push image
docker build -f Dockerfile.config -t ghcr.io/reactiflux/mod-bot-config:latest .
docker push ghcr.io/reactiflux/mod-bot-config:latest

# Create secret
kubectl create secret generic config-service-secret \
  --from-literal=DATABASE_URL=postgresql://user:pass@host:5432/mod_bot_config \
  --from-literal=POSTGRES_USER=postgres \
  --from-literal=POSTGRES_PASSWORD=<secure-password>

# Deploy
kubectl apply -f cluster/proposed/config-service.yaml
```

## Phase 2: Modify Gateway to Support Guild Filtering

### 2.1 Add Environment Variable Support

**File**: `app/helpers/env.server.ts`

```typescript
// Add these exports
export const serviceMode = process.env.SERVICE_MODE || 'monolith'; // 'monolith', 'gateway', 'http'
export const podId = process.env.POD_ORDINAL || '0';
export const configServiceUrl = process.env.CONFIG_SERVICE_URL || '';
export const assignedGuilds = process.env.ASSIGNED_GUILDS?.split(',') || [];
```

### 2.2 Create Config Service Client

**File**: `app/helpers/configService.ts`

```typescript
import { configServiceUrl, podId } from './env.server';

export interface GuildAssignment {
  guild_id: string;
  pod_id: number;
  pod_name?: string;
}

export class ConfigServiceClient {
  private baseUrl: string;
  private podId: number;
  
  constructor() {
    this.baseUrl = configServiceUrl;
    this.podId = parseInt(podId, 10);
  }
  
  async registerPod(podName: string, capacity = 100) {
    const response = await fetch(`${this.baseUrl}/pod/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pod_id: this.podId, pod_name: podName, capacity }),
    });
    return response.json();
  }
  
  async heartbeat(guildCount: number) {
    const response = await fetch(`${this.baseUrl}/pod/${this.podId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guild_count: guildCount }),
    });
    return response.json();
  }
  
  async getAssignedGuilds(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/guild-assignments`);
    const assignments: GuildAssignment[] = await response.json();
    return assignments
      .filter(a => a.pod_id === this.podId)
      .map(a => a.guild_id);
  }
  
  async getGuildAssignment(guildId: string): Promise<GuildAssignment> {
    const response = await fetch(`${this.baseUrl}/guild/${guildId}/assignment`);
    return response.json();
  }
}

export const configService = new ConfigServiceClient();
```

### 2.3 Modify Gateway Initialization

**File**: `app/discord/gateway.ts`

```typescript
import { serviceMode } from '#~/helpers/env.server';
import { configService } from '#~/helpers/configService';

// At the top, add guild filter
let assignedGuilds: Set<string> = new Set();

export default function init() {
  if (globalThis.__discordGatewayInitialized) {
    log("info", "Gateway", "Gateway already initialized, skipping duplicate init", {});
    return;
  }

  // Don't initialize gateway if in HTTP-only mode
  if (serviceMode === 'http') {
    log("info", "Gateway", "Running in HTTP mode, skipping gateway init", {});
    return;
  }

  log("info", "Gateway", "Initializing Discord gateway", {});
  globalThis.__discordGatewayInitialized = true;

  void login();

  client.on(Events.ClientReady, async () => {
    await trackPerformance("gateway_startup", async () => {
      log("info", "Gateway", "Bot ready event triggered", {
        guildCount: client.guilds.cache.size,
        userCount: client.users.cache.size,
      });

      // Register with config service and get assigned guilds
      if (serviceMode === 'gateway') {
        const podName = process.env.POD_NAME || `gateway-${process.env.POD_ORDINAL || '0'}`;
        await configService.registerPod(podName);
        
        const guilds = await configService.getAssignedGuilds();
        assignedGuilds = new Set(guilds);
        
        log("info", "Gateway", "Registered with config service", {
          podName,
          assignedGuilds: guilds.length,
        });
        
        // Start heartbeat
        setInterval(async () => {
          await configService.heartbeat(assignedGuilds.size);
        }, 30000); // Every 30 seconds
      }

      await Promise.all([
        onboardGuild(client, assignedGuilds),
        automod(client, assignedGuilds),
        deployCommands(client),
        startActivityTracking(client, assignedGuilds),
        startHoneypotTracking(client, assignedGuilds),
        startReactjiChanneler(client, assignedGuilds),
      ]);

      startEscalationResolver(client, assignedGuilds);

      log("info", "Gateway", "Gateway initialization completed", {
        guildCount: client.guilds.cache.size,
        assignedGuilds: assignedGuilds.size,
      });

      botStats.botStarted(client.guilds.cache.size, client.users.cache.size);
    }, {
      guildCount: client.guilds.cache.size,
      userCount: client.users.cache.size,
    });
  });

  // ... rest of event handlers
}

// Export for use in event handlers
export function isGuildAssigned(guildId: string): boolean {
  if (serviceMode === 'monolith') return true;
  return assignedGuilds.has(guildId);
}
```

### 2.4 Filter Events by Guild

Update all event handlers to check if guild is assigned:

**Example in** `app/discord/automod.ts`:

```typescript
import { isGuildAssigned } from './gateway';

export default function automod(client: Client, assignedGuilds?: Set<string>) {
  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guildId) return;
    if (!isGuildAssigned(msg.guildId)) return; // Filter here
    
    // ... rest of automod logic
  });
}
```

Apply similar filters to:
- `app/discord/activityTracker.ts`
- `app/discord/honeypotTracker.ts`
- `app/discord/reactjiChanneler.ts`
- `app/discord/escalationResolver.ts`

## Phase 3: Create HTTP Service Routing

### 3.1 Add Routing Logic

**File**: `app/helpers/routeToGateway.ts`

```typescript
import { configService } from './configService';

export async function routeToGateway(guildId: string, path: string, options: RequestInit = {}) {
  const assignment = await configService.getGuildAssignment(guildId);
  const gatewayUrl = `http://gateway-${assignment.pod_id}.gateway-internal:3000`;
  
  const response = await fetch(`${gatewayUrl}${path}`, options);
  return response;
}

export async function getGuildData(guildId: string) {
  const response = await routeToGateway(guildId, `/api/guild/${guildId}/data`, {
    method: 'GET',
  });
  return response.json();
}
```

### 3.2 Update Server to Route Interactions

**File**: `app/server.ts`

```typescript
import { serviceMode } from '#~/helpers/env.server';
import { routeToGateway } from '#~/helpers/routeToGateway';

// ... existing code

// For webhook handling, route to appropriate gateway pod
app.post("/webhooks/discord", bodyParser.json(), async (req, res, next) => {
  // ... signature verification
  
  if (serviceMode === 'http') {
    // Route to appropriate gateway pod
    const guildId = req.body.guild_id;
    if (guildId) {
      const response = await routeToGateway(guildId, '/webhooks/discord', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      return res.json(data);
    }
  }
  
  next();
});

// Initialize based on mode
if (serviceMode !== 'http') {
  discordBot();
  registerCommand(setup);
  // ... other commands
}
```

## Phase 4: Deploy New Architecture

### 4.1 Build and Push Images

```bash
# Build main app image
docker build -t ghcr.io/reactiflux/mod-bot:sha-$(git rev-parse HEAD) .
docker push ghcr.io/reactiflux/mod-bot:sha-$(git rev-parse HEAD)

# Build config service image
docker build -f Dockerfile.config -t ghcr.io/reactiflux/mod-bot-config:latest .
docker push ghcr.io/reactiflux/mod-bot-config:latest
```

### 4.2 Create k8s-context

```bash
cat > k8s-context <<EOF
IMAGE=ghcr.io/reactiflux/mod-bot:sha-$(git rev-parse HEAD)
IMAGE_CONFIG=ghcr.io/reactiflux/mod-bot-config:latest
EOF
```

### 4.3 Deploy All Services

```bash
# Deploy everything
kubectl apply -k cluster/proposed/

# Verify deployments
kubectl get pods -l app=mod-bot
kubectl get svc -l app=mod-bot

# Check logs
kubectl logs -l component=config --tail=50
kubectl logs -l component=gateway --tail=50
kubectl logs -l component=http --tail=50
```

### 4.4 Verify Operation

```bash
# Check config service health
kubectl port-forward svc/config-service 3001:3001
curl http://localhost:3001/health

# Check guild assignments
curl http://localhost:3001/guild-assignments

# Check pod health
curl http://localhost:3001/pods/health

# Test HTTP service
kubectl port-forward svc/http-service 3000:80
curl http://localhost:3000/healthcheck
```

## Phase 5: Migration from Old Architecture

### 5.1 Export Data from Old Pod

```bash
# Get current database
kubectl cp mod-bot-set-0:/data/mod-bot.sqlite3 ./backup.sqlite3

# Or use Litestream restore if already running
litestream restore -o backup.sqlite3 s3://bucket/mod-bot.sqlite3
```

### 5.2 Split Data by Guild

Create a script to split the SQLite database:

```typescript
import SQLite from 'better-sqlite3';

const sourceDb = new SQLite('./backup.sqlite3', { readonly: true });
const assignments = await configService.getGuildAssignments();

// Group by pod
const guildsByPod = new Map<number, string[]>();
for (const { guild_id, pod_id } of assignments) {
  if (!guildsByPod.has(pod_id)) {
    guildsByPod.set(pod_id, []);
  }
  guildsByPod.get(pod_id)!.push(guild_id);
}

// Create database for each pod
for (const [podId, guilds] of guildsByPod) {
  const targetDb = new SQLite(`./pod-${podId}.sqlite3`);
  
  // Copy schema
  const schema = sourceDb.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
  for (const { sql } of schema) {
    if (sql) targetDb.exec(sql);
  }
  
  // Copy data for assigned guilds
  const guildList = guilds.map(g => `'${g}'`).join(',');
  
  targetDb.exec(`
    INSERT INTO guilds SELECT * FROM source.guilds WHERE id IN (${guildList});
    INSERT INTO activity SELECT * FROM source.activity WHERE guild_id IN (${guildList});
    INSERT INTO reported_messages SELECT * FROM source.reported_messages WHERE guild_id IN (${guildList});
    -- Add other tables as needed
  `);
  
  targetDb.close();
}

sourceDb.close();
```

### 5.3 Upload to Gateway Pods

```bash
# For each gateway pod
for i in 0 1 2; do
  kubectl cp ./pod-${i}.sqlite3 gateway-${i}:/data/mod-bot.sqlite3
  kubectl exec gateway-${i} -- chown 1000:1000 /data/mod-bot.sqlite3
done
```

### 5.4 Switch Traffic

```bash
# Update ingress to point to new HTTP service
kubectl patch ingress mod-bot-ingress -p '{"spec":{"rules":[{"host":"euno.reactiflux.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"http-service","port":{"number":80}}}}]}}]}}'

# Monitor for issues
kubectl logs -l component=http --tail=100 -f
```

### 5.5 Decommission Old Pod

```bash
# Scale down old StatefulSet
kubectl scale statefulset mod-bot-set --replicas=0

# Wait 24 hours to ensure everything works

# Delete old resources
kubectl delete statefulset mod-bot-set
kubectl delete service mod-bot-service
kubectl delete pvc mod-bot-pvc-mod-bot-set-0
```

## Testing Checklist

- [ ] Config service responds to health checks
- [ ] Config service registers pods correctly
- [ ] Guild assignments are distributed across pods
- [ ] Gateway pods connect to Discord
- [ ] Gateway pods only process assigned guilds
- [ ] HTTP service routes requests correctly
- [ ] Discord commands work in all guilds
- [ ] Discord interactions are routed correctly
- [ ] Litestream backups are working
- [ ] Pod failover works (kill one pod, verify recovery)
- [ ] HPA scales HTTP service correctly
- [ ] Manual guild reassignment works
- [ ] Web portal loads and displays correct data

## Monitoring

Set up monitoring for:

1. **Guild Distribution**: Alert if one pod has >50% of guilds
2. **Pod Health**: Alert if pod hasn't sent heartbeat in 2 minutes
3. **Replication Lag**: Monitor Litestream lag
4. **HTTP Latency**: Track P95/P99 latency for HTTP service
5. **Gateway Connection**: Alert on Discord disconnections

## Rollback Procedure

If something goes wrong:

```bash
# Quick rollback: switch ingress back
kubectl patch ingress mod-bot-ingress -p '{"spec":{"rules":[{"host":"euno.reactiflux.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"mod-bot-service","port":{"number":80}}}}]}}]}}'

# Scale up old pod
kubectl scale statefulset mod-bot-set --replicas=1

# Full rollback: delete new architecture
kubectl delete -k cluster/proposed/
kubectl apply -k cluster/
```

## Performance Tuning

### SQLite Optimizations

Add to each gateway pod's startup:

```typescript
// app/db.server.ts
const db = new SQLite(databaseUrl);

// Performance optimizations
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 30000000000'); // 30GB mmap
```

### Connection Pooling

HTTP service should pool connections to gateway pods:

```typescript
import { Agent } from 'http';

const agent = new Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
});

// Use in fetch calls
fetch(url, { agent });
```

## Cost Optimization

- Start with 2-3 gateway pods, scale as needed
- Use DigitalOcean Spaces (cheaper than AWS S3) for Litestream
- Consider managed PostgreSQL for config service (easier ops)
- Set aggressive HPA scale-down for HTTP service during low traffic
