# Discord API Rate Limits Research

## Global Rate Limits

- **50 requests per second** per bot token (or per IP if no auth header)
- Interaction endpoints (slash command responses, component callbacks) are exempt
- 10,000 invalid requests (401, 403, 429) per 10 minutes triggers a Cloudflare IP ban
  - 429s with `X-RateLimit-Scope: shared` are exempt from this count

## Per-Route Rate Limits

- Bucketed by HTTP method + path template, with top-level resource IDs creating
  separate buckets
- `PUT /guilds/{guild.id}/members/{member.id}/roles/{role.id}` — all role
  assignments in the same guild share one bucket
- Discord does not publish specific per-route numbers; apps must parse response
  headers
- Community reports: ~10 role updates per 10 seconds per guild (not officially
  documented)

## 429 Response Details

### Headers on every response

| Header                     | Description                          |
| -------------------------- | ------------------------------------ |
| `X-RateLimit-Limit`        | Max requests in the bucket           |
| `X-RateLimit-Remaining`    | Remaining requests before reset      |
| `X-RateLimit-Reset`        | Unix epoch timestamp of reset        |
| `X-RateLimit-Reset-After`  | Seconds until reset                  |
| `X-RateLimit-Bucket`       | Unique bucket identifier             |

### Additional headers on 429 responses

| Header               | Description                                    |
| -------------------- | ---------------------------------------------- |
| `X-RateLimit-Global` | Present if global rate limit hit               |
| `X-RateLimit-Scope`  | `user`, `global`, or `shared` (per-resource)   |

### 429 response body

```json
{
  "message": "You are being rate limited.",
  "retry_after": 1.234,
  "global": false,
  "code": 0
}
```

## Bulk Operations

- **No bulk role assignment endpoint exists.** One PUT per member, no exceptions.
- Community reports: ~20,000 members takes "several hours" in a 500k-member server
- Estimated throughput at ~1 req/s effective (guild bucket): 100k members ≈ 28 hours

## discord.js REST Client (`@discordjs/rest`)

### Automatic 429 handling

- **Pre-emptive queuing**: checks `X-RateLimit-Remaining` and queues requests
  before hitting limits
- **Unlimited 429 retries**: sleeps for `retry_after` then retries; does NOT
  increment the retry counter
- **Only 5xx errors** increment the retry counter (default: 3 retries)

### Default configuration

| Option                    | Default        |
| ------------------------- | -------------- |
| `retries`                 | 3 (5xx only)   |
| `globalRequestsPerSecond` | 50             |
| `timeout`                 | 15,000ms       |
| `offset`                  | 50ms           |
| `rejectOnRateLimit`       | null           |

### Implication for bulk role assignment

A tight sequential loop of PUT calls is safe — discord.js queues and paces
requests internally. It won't error out on rate limits, it just slows down.
Memory pressure from queuing is not a concern since requests are awaited
sequentially.
