# Architecture Diagrams

## Current Architecture (Single Pod)

```mermaid
graph TB
    subgraph "Kubernetes Cluster"
        subgraph "StatefulSet (1 replica)"
            Bot[mod-bot Pod<br/>- Discord.js Gateway<br/>- HTTP Server<br/>- SQLite DB]
            Volume[(Volume<br/>SQLite File)]
            Bot --> Volume
        end
        
        Service[Service<br/>ClusterIP]
        Service --> Bot
        
        Ingress[Ingress<br/>nginx]
        Ingress --> Service
    end
    
    Internet([Internet]) --> Ingress
    Discord([Discord API<br/>WebSocket]) -.-> Bot
    
    style Bot fill:#e1f5ff
    style Volume fill:#ffe1e1
```

## Proposed Architecture: Guild-Based Pod Assignment

```mermaid
graph TB
    subgraph "External"
        Users([Users/Web])
        Discord([Discord API])
    end
    
    subgraph "Kubernetes Cluster"
        LB[Load Balancer<br/>nginx-ingress]
        
        subgraph "HTTP Layer (Stateless)"
            HTTP1[HTTP Service Pod 1]
            HTTP2[HTTP Service Pod 2]
            HTTPn[HTTP Service Pod N]
        end
        
        subgraph "Config Service (Stateless)"
            Config1[Config Service Pod 1]
            Config2[Config Service Pod 2]
            ConfigDB[(PostgreSQL<br/>Guild Assignments)]
            Config1 --> ConfigDB
            Config2 --> ConfigDB
        end
        
        subgraph "Gateway Layer (Stateful)"
            subgraph "Gateway Pod 0"
                GW0[Discord.js Client<br/>Guilds: 0-99]
                DB0[(SQLite<br/>guilds_0-99.db)]
                Vol0[Volume 0]
                GW0 --> DB0
                DB0 --> Vol0
            end
            
            subgraph "Gateway Pod 1"
                GW1[Discord.js Client<br/>Guilds: 100-199]
                DB1[(SQLite<br/>guilds_100-199.db)]
                Vol1[Volume 1]
                GW1 --> DB1
                DB1 --> Vol1
            end
            
            subgraph "Gateway Pod N"
                GWn[Discord.js Client<br/>Guilds: N-M]
                DBn[(SQLite<br/>guilds_N-M.db)]
                Voln[Volume N]
                GWn --> DBn
                DBn --> Voln
            end
        end
        
        InternalSvc[Internal Service<br/>gateway-internal]
        InternalSvc --> GW0
        InternalSvc --> GW1
        InternalSvc --> GWn
    end
    
    Users --> LB
    LB --> HTTP1
    LB --> HTTP2
    LB --> HTTPn
    
    HTTP1 --> Config1
    HTTP2 --> Config2
    HTTPn --> Config1
    
    HTTP1 --> InternalSvc
    HTTP2 --> InternalSvc
    HTTPn --> InternalSvc
    
    Discord -.WebSocket.-> GW0
    Discord -.WebSocket.-> GW1
    Discord -.WebSocket.-> GWn
    
    Discord -.Webhooks.-> LB
    
    style LB fill:#90EE90
    style HTTP1 fill:#87CEEB
    style HTTP2 fill:#87CEEB
    style HTTPn fill:#87CEEB
    style Config1 fill:#FFD700
    style Config2 fill:#FFD700
    style ConfigDB fill:#FFA500
    style GW0 fill:#e1f5ff
    style GW1 fill:#e1f5ff
    style GWn fill:#e1f5ff
    style DB0 fill:#ffe1e1
    style DB1 fill:#ffe1e1
    style DBn fill:#ffe1e1
```

## Request Flow: Discord Event Processing

```mermaid
sequenceDiagram
    participant Discord as Discord Gateway
    participant GW0 as Gateway Pod 0<br/>(Guilds 0-99)
    participant GW1 as Gateway Pod 1<br/>(Guilds 100-199)
    participant SQLite0 as SQLite DB 0
    participant SQLite1 as SQLite DB 1
    
    Note over Discord,SQLite1: Event for Guild 42
    Discord->>GW0: MessageCreate Event<br/>guild_id: 42
    Note over GW0: Guild 42 assigned to Pod 0
    GW0->>SQLite0: Store message data
    SQLite0-->>GW0: OK
    GW0->>Discord: Acknowledge
    
    Note over Discord,SQLite1: Event for Guild 150
    Discord->>GW1: MessageCreate Event<br/>guild_id: 150
    Note over GW1: Guild 150 assigned to Pod 1
    GW1->>SQLite1: Store message data
    SQLite1-->>GW1: OK
    GW1->>Discord: Acknowledge
```

## Request Flow: HTTP Request Routing

```mermaid
sequenceDiagram
    participant User as User Browser
    participant LB as Load Balancer
    participant HTTP as HTTP Service Pod
    participant Config as Config Service
    participant GW0 as Gateway Pod 0
    participant GW1 as Gateway Pod 1
    
    User->>LB: GET /guild/42/dashboard
    LB->>HTTP: Route request
    HTTP->>Config: Which pod handles guild 42?
    Config-->>HTTP: Pod 0
    HTTP->>GW0: GET /data/guild/42
    GW0->>GW0: Query SQLite DB 0
    GW0-->>HTTP: Guild data
    HTTP-->>LB: Rendered page
    LB-->>User: Dashboard HTML
```

## Request Flow: Discord Interaction (Command)

```mermaid
sequenceDiagram
    participant User as Discord User
    participant Discord as Discord API
    participant LB as Load Balancer
    participant HTTP as HTTP Service Pod
    participant Config as Config Service
    participant GW1 as Gateway Pod 1
    participant SQLite as SQLite DB 1
    
    User->>Discord: /setup command<br/>in guild 150
    Discord->>LB: POST /webhooks/discord<br/>interaction webhook
    LB->>HTTP: Route webhook
    HTTP->>HTTP: Extract guild_id: 150
    HTTP->>Config: Which pod handles guild 150?
    Config-->>HTTP: Pod 1
    HTTP->>GW1: Process interaction
    GW1->>SQLite: Update guild settings
    SQLite-->>GW1: OK
    GW1-->>HTTP: Response data
    HTTP-->>Discord: Interaction response
    Discord-->>User: Show setup complete
```

## Guild Reassignment Flow

```mermaid
sequenceDiagram
    participant Admin as Admin/Autoscaler
    participant Config as Config Service
    participant GW0 as Gateway Pod 0<br/>(Overloaded)
    participant GW1 as Gateway Pod 1<br/>(Underutilized)
    participant SQLite0 as SQLite DB 0
    participant SQLite1 as SQLite DB 1
    
    Admin->>Config: Reassign guild 42 from Pod 0 to Pod 1
    Config->>Config: Mark guild 42 as "migrating"
    Config->>GW0: Stop processing guild 42
    GW0->>GW0: Drain events for guild 42
    GW0-->>Config: Ready to export
    
    Config->>GW0: Export guild 42 data
    GW0->>SQLite0: SELECT * WHERE guild_id=42
    SQLite0-->>GW0: Guild data
    GW0-->>Config: Data export
    
    Config->>GW1: Import guild 42 data
    GW1->>SQLite1: INSERT guild 42 data
    SQLite1-->>GW1: OK
    GW1-->>Config: Import complete
    
    Config->>Config: Update assignment<br/>guild 42 -> Pod 1
    Config->>GW1: Start processing guild 42
    GW1->>GW1: Begin handling events
    Config-->>Admin: Migration complete
```

## Deployment Architecture

```mermaid
graph TB
    subgraph "Kubernetes Namespaces"
        subgraph "default namespace (production)"
            subgraph "Config Service"
                ConfigDep[Deployment: config-service<br/>replicas: 2]
                ConfigSvc[Service: config-service]
                ConfigPG[(PostgreSQL<br/>Managed or StatefulSet)]
                ConfigDep --> ConfigSvc
                ConfigDep --> ConfigPG
            end
            
            subgraph "HTTP Service"
                HTTPDep[Deployment: http-service<br/>replicas: 2-10<br/>HPA enabled]
                HTTPSvc[Service: http-service]
                HTTPDep --> HTTPSvc
                HTTPDep -.queries.-> ConfigSvc
            end
            
            subgraph "Gateway Service"
                GatewaySS[StatefulSet: gateway<br/>replicas: 3-10]
                GatewaySvc[Service: gateway-internal<br/>Headless]
                GatewayVol[(PVC per pod<br/>1Gi each)]
                GatewaySS --> GatewaySvc
                GatewaySS --> GatewayVol
                GatewaySS -.registers with.-> ConfigSvc
            end
            
            Ingress[Ingress: mod-bot-ingress]
            Ingress --> HTTPSvc
        end
        
        subgraph "staging namespace (preview)"
            StagingDep[Deployment: mod-bot-pr-N<br/>Single pod with all components]
        end
    end
    
    Internet([Internet]) --> Ingress
    
    style ConfigDep fill:#FFD700
    style ConfigPG fill:#FFA500
    style HTTPDep fill:#87CEEB
    style GatewaySS fill:#e1f5ff
    style GatewayVol fill:#ffe1e1
```

## Data Flow: Backup and Recovery

```mermaid
graph LR
    subgraph "Gateway Pods"
        GW0[Gateway Pod 0<br/>SQLite DB]
        GW1[Gateway Pod 1<br/>SQLite DB]
        GWn[Gateway Pod N<br/>SQLite DB]
    end
    
    subgraph "Backup System"
        Litestream0[Litestream<br/>Sidecar 0]
        Litestream1[Litestream<br/>Sidecar 1]
        Litestreamn[Litestream<br/>Sidecar N]
    end
    
    subgraph "Object Storage"
        S3[(S3/DigitalOcean<br/>Spaces)]
    end
    
    subgraph "Config Service"
        ConfigDB[(PostgreSQL<br/>+ Backup)]
    end
    
    GW0 --> Litestream0
    GW1 --> Litestream1
    GWn --> Litestreamn
    
    Litestream0 -.continuous.-> S3
    Litestream1 -.continuous.-> S3
    Litestreamn -.continuous.-> S3
    
    ConfigDB -.snapshot.-> S3
    
    S3 -.restore.-> GW0
    S3 -.restore.-> GW1
    S3 -.restore.-> GWn
    
    style S3 fill:#FF6B6B
```

## Scaling Decisions

```mermaid
graph TD
    Start([Monitor System]) --> CheckLoad{High Load?}
    
    CheckLoad -->|No| Start
    CheckLoad -->|Yes| CheckType{Load Type?}
    
    CheckType -->|HTTP Traffic| ScaleHTTP[Scale HTTP Service<br/>HPA adds pods]
    CheckType -->|Guild Events| CheckGuilds{Guild Distribution?}
    
    CheckGuilds -->|Unbalanced| Rebalance[Rebalance guilds<br/>across existing pods]
    CheckGuilds -->|Balanced & Overloaded| ScaleGateway[Add Gateway Pod<br/>Manual scaling]
    
    ScaleHTTP --> Start
    Rebalance --> Start
    ScaleGateway --> AssignGuilds[Config Service<br/>assigns guilds to new pod]
    AssignGuilds --> Start
    
    style ScaleHTTP fill:#90EE90
    style Rebalance fill:#FFD700
    style ScaleGateway fill:#87CEEB
```

## Cost Comparison

```mermaid
graph LR
    subgraph "Current (Single Pod)"
        C1[1x Gateway Pod<br/>256Mi RAM, 50m CPU]
        C2[1x Volume<br/>1Gi]
        C3[Total: ~$10/month]
    end
    
    subgraph "Proposed (3 Gateway Pods + Separation)"
        P1[3x Gateway Pods<br/>256Mi RAM, 50m CPU each]
        P2[2x HTTP Pods<br/>128Mi RAM, 20m CPU each]
        P3[2x Config Pods<br/>128Mi RAM, 20m CPU each]
        P4[3x Volumes<br/>1Gi each]
        P5[1x PostgreSQL<br/>Managed or 256Mi]
        P6[Total: ~$40-50/month]
    end
    
    style C3 fill:#90EE90
    style P6 fill:#FFD700
```

## Notes

- **HTTP Service**: Stateless, can use regular Deployment with HPA
- **Config Service**: Stateless (state in PostgreSQL), can use regular Deployment
- **Gateway Pods**: Stateful (SQLite local storage), must use StatefulSet
- **Volumes**: Each gateway pod needs its own persistent volume
- **PostgreSQL**: Can use managed service (DigitalOcean) or run StatefulSet
- **Internal Communication**: All service-to-service uses Kubernetes internal DNS
- **External Access**: Only HTTP service is exposed via Ingress
