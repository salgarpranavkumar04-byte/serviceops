# ServiceOps v5.1 — Production Upgrade Runbook

## What changed (5 files only)

| File | Type | Task |
|------|------|------|
| `backend/ecosystem.config.js` | NEW | PM2 cluster config |
| `backend/middleware/requestLogger.js` | NEW | HTTP access log |
| `backend/queues/queue.js` | MODIFIED | Backoff delay 2s → 5s |
| `backend/server.js` | MODIFIED | Mount requestLogger middleware |
| `backend/package.json` | MODIFIED | PM2 scripts + devDependency |

## What was already correct (do not touch)

- Retry logic (5 attempts, exponential backoff) — already in queue.js
- DLQ routing — already in all 3 workers
- Database indexes (status, technician_id, created_at DESC, GIST location) — already in migration.sql
- /health endpoint — already detailed in server.js
- uncaughtException + unhandledRejection handlers — already in gracefulShutdown.js
- WhatsApp 10s timeout + retry-via-queue — already in whatsappClient.js
- All controllers wrapped in asyncHandler — already done
- Idempotency for job creation (request_id) — already in jobs.controller.js
- Redis-backed rate limiters — already in rateLimiters.js

---

## Deployment steps

### 1. Install dependencies

```bash
cd backend
npm install
npm install -g pm2
```

### 2. Create the logs directory

```bash
mkdir -p backend/logs
```

### 3. Start the full cluster

```bash
cd backend
npm run cluster:start
# or directly:
pm2 start ecosystem.config.js
```

### 4. Verify everything is running

```bash
pm2 status
# Expected:
# serviceops-server          cluster   online (N instances, where N = CPU cores)
# serviceops-worker-messages fork      online
# serviceops-worker-jobs     fork      online
# serviceops-worker-whatsapp fork      online
```

### 5. Persist across server reboots

```bash
pm2 save
pm2 startup    # follow the printed command with sudo
```

### 6. Zero-downtime server restart (rolling reload)

```bash
pm2 reload serviceops-server
# Workers are restarted normally (they have no in-flight HTTP connections):
pm2 restart serviceops-worker-messages serviceops-worker-jobs serviceops-worker-whatsapp
```

### 7. View logs

```bash
pm2 logs                                    # all processes
pm2 logs serviceops-server --lines 200      # server only
pm2 logs serviceops-worker-whatsapp --err   # WhatsApp worker errors only
# Or read log files directly:
tail -f backend/logs/server.err.log
tail -f backend/logs/worker-whatsapp.err.log
```

### 8. Monitor live

```bash
pm2 monit
```

---

## Architecture after upgrade

```
Internet
    │
    ▼
PM2 (supervisor)
    ├── serviceops-server  [cluster, N cores]
    │       │  HTTP API, rate-limiter, job creation
    │       └──► Redis ◄── shared state (rate limits, BullMQ queues)
    │                           │
    ├── worker:messages  [fork] ├── incoming_messages_queue
    ├── worker:jobs      [fork] ├── job_processing_queue
    └── worker:whatsapp  [fork] └── whatsapp_send_queue
                                         │
                                    *_dlq (failed jobs, 30-day retention)
```

## Why workers are NOT in cluster mode

BullMQ workers consume from a Redis queue. If you ran 4 cluster instances
of a worker on a 4-core machine, you'd have 4 × concurrency = e.g. 20 simultaneous
consumers competing for the same queue, causing erratic DLQ inserts for jobs that
appeared to "fail" due to races. One worker process per queue, tuned via the
`*_WORKER_CONCURRENCY` env vars, is the correct model.

## Retry schedule for failed jobs

| Attempt | Delay before retry |
|---------|--------------------|
| 1 → 2   | 5 seconds |
| 2 → 3   | 10 seconds |
| 3 → 4   | 20 seconds |
| 4 → 5   | 40 seconds |
| 5 fails | → moved to `*_dlq` with error + timestamp |

WhatsApp send queue gets 6 attempts (external API needs more tolerance).

## Inspecting the DLQ

Failed jobs are stored in BullMQ queues named:
- `incoming_messages_dlq`
- `job_processing_dlq`
- `whatsapp_send_dlq`

Inspect via Redis CLI:
```bash
redis-cli
> KEYS *_dlq*
> TYPE incoming_messages_dlq
```
Or use Bull Board (optional UI — not bundled but easy to add).

## Environment variables (no new ones required)

All existing env vars from `.env` continue to work. New production-tuning vars
you can optionally set in ecosystem.config.js `env` blocks:

| Variable | Default | Description |
|----------|---------|-------------|
| `MESSAGE_WORKER_CONCURRENCY` | 5 | Parallel message jobs |
| `JOB_WORKER_CONCURRENCY` | 10 | Parallel job notifications |
| `WHATSAPP_WORKER_CONCURRENCY` | 10 | Parallel WhatsApp sends |
| `WHATSAPP_RATE_LIMIT_MAX` | 80 | Max sends/minute (Meta limit) |
