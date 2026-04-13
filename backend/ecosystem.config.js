'use strict';

/**
 * ecosystem.config.js — PM2 process configuration (v5)
 *
 * ARCHITECTURE:
 *   ┌──────────────────────────────────────────────────────┐
 *   │  PM2 supervisor                                      │
 *   │                                                      │
 *   │  server          — cluster mode, N = CPU cores       │
 *   │                    Handles all HTTP traffic          │
 *   │                    No in-memory state (Redis-backed) │
 *   │                                                      │
 *   │  worker:messages — fork mode, 1 process             │
 *   │  worker:jobs     — fork mode, 1 process             │
 *   │  worker:whatsapp — fork mode, 1 process             │
 *   │                    Workers use BullMQ concurrency    │
 *   │                    for parallelism (not PM2 cluster) │
 *   └──────────────────────────────────────────────────────┘
 *
 * WHY workers run in fork (not cluster) mode:
 *   BullMQ workers already fan out via concurrency. Running multiple
 *   cluster instances of a worker would create N×concurrency consumers,
 *   causing duplicate job processing and race conditions on the DLQ.
 *
 * CLUSTER SAFETY:
 *   The HTTP server is safe for cluster mode because:
 *     • Rate-limit counters → Redis (rate-limit-redis)
 *     • Dedup/idempotency   → Redis SETNX (messageRouter.js)
 *     • Job queues          → BullMQ on Redis
 *     • Settings cache      → per-process in-memory (read-only, refreshed via interval — acceptable)
 *     • No mutable in-memory Maps, Sets, or globals
 *
 * USAGE:
 *   pm2 start ecosystem.config.js          # start all
 *   pm2 restart ecosystem.config.js        # rolling restart (zero-downtime for server)
 *   pm2 stop ecosystem.config.js           # stop all
 *   pm2 logs                               # tail all logs
 *   pm2 monit                              # live process monitor
 *   pm2 save && pm2 startup                # persist across reboots
 */

module.exports = {
  apps: [
    /* ──────────────────────────────────────────────────────────
       1. HTTP API server — cluster mode, all CPU cores
    ────────────────────────────────────────────────────────── */
    {
      name:             'serviceops-server',
      script:           'server.js',
      cwd:              __dirname,

      // Cluster mode: PM2 spawns `instances` copies and load-balances
      // incoming connections across them using Node.js cluster module.
      exec_mode:        'cluster',
      instances:        'max',          // one per logical CPU core

      // Restart if process exceeds 500 MB RSS — protects against slow leaks.
      max_memory_restart: '500M',

      // Auto-restart on crash
      autorestart:      true,
      restart_delay:    3000,           // wait 3s before restarting after crash
      max_restarts:     10,             // if it crashes 10× in a row, stop trying
      min_uptime:       '10s',          // must run 10s to count as a successful start

      // Environment
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },

      // Log configuration
      out_file:         './logs/server.out.log',
      error_file:       './logs/server.err.log',
      log_date_format:  'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:       true,           // merge cluster instance logs into one file

      // Graceful shutdown: wait up to 15s for in-flight requests to drain
      kill_timeout:     15000,
      listen_timeout:   10000,
      wait_ready:       false,          // we don't emit 'ready' event (keep simple)
    },

    /* ──────────────────────────────────────────────────────────
       2. Incoming WhatsApp message worker
    ────────────────────────────────────────────────────────── */
    {
      name:             'serviceops-worker-messages',
      script:           'workers/messageWorker.js',
      cwd:              __dirname,

      exec_mode:        'fork',         // NOT cluster — BullMQ handles concurrency
      instances:        1,

      max_memory_restart: '300M',
      autorestart:      true,
      restart_delay:    5000,
      max_restarts:     10,
      min_uptime:       '10s',

      env: {
        NODE_ENV:                   'production',
        MESSAGE_WORKER_CONCURRENCY: '5',   // override default of 3 in production
      },

      out_file:         './logs/worker-messages.out.log',
      error_file:       './logs/worker-messages.err.log',
      log_date_format:  'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout:     20000,          // workers need time to finish in-flight jobs
    },

    /* ──────────────────────────────────────────────────────────
       3. Job lifecycle notification worker
    ────────────────────────────────────────────────────────── */
    {
      name:             'serviceops-worker-jobs',
      script:           'workers/jobWorker.js',
      cwd:              __dirname,

      exec_mode:        'fork',
      instances:        1,

      max_memory_restart: '300M',
      autorestart:      true,
      restart_delay:    5000,
      max_restarts:     10,
      min_uptime:       '10s',

      env: {
        NODE_ENV:               'production',
        JOB_WORKER_CONCURRENCY: '10',   // override default of 5
      },

      out_file:         './logs/worker-jobs.out.log',
      error_file:       './logs/worker-jobs.err.log',
      log_date_format:  'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout:     20000,
    },

    /* ──────────────────────────────────────────────────────────
       4. WhatsApp outbound send worker
    ────────────────────────────────────────────────────────── */
    {
      name:             'serviceops-worker-whatsapp',
      script:           'workers/whatsappWorker.js',
      cwd:              __dirname,

      exec_mode:        'fork',
      instances:        1,

      max_memory_restart: '300M',
      autorestart:      true,
      restart_delay:    5000,
      max_restarts:     10,
      min_uptime:       '10s',

      env: {
        NODE_ENV:                      'production',
        WHATSAPP_WORKER_CONCURRENCY:   '10',  // override default of 5
        WHATSAPP_RATE_LIMIT_MAX:       '80',  // msgs/min — respect Meta limits
      },

      out_file:         './logs/worker-whatsapp.out.log',
      error_file:       './logs/worker-whatsapp.err.log',
      log_date_format:  'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout:     20000,
    },
  ],
};
