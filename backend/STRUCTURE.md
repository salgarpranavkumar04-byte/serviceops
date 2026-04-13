# ServiceOps — Refactored Project Structure (v5)

```
/serviceops
├── server.js                          # UPDATED — thin bootstrap, mounts routers
├── .env.example
│
├── /config
│   └── validateEnv.js                 # UPDATED — adds REDIS_URL required in prod
│
├── /db
│   └── db.js                          # UNCHANGED (already solid)
│
├── /middleware
│   ├── authenticate.js                # UNCHANGED
│   ├── errorHandler.js                # NEW — centralized error handling
│   ├── rateLimiters.js                # NEW — all rate-limiter definitions
│   └── rawBody.js                     # NEW — raw body capture (for HMAC)
│
├── /routes
│   ├── jobs.routes.js                 # NEW — all /jobs/* routes
│   ├── admin.routes.js                # NEW — all /admin/* routes (settings, technicians, commission)
│   ├── conversations.routes.js        # NEW — /conversations/* routes
│   ├── technicians.routes.js          # NEW — public /technicians route
│   ├── wallet.routes.js               # NEW — /wallet/* routes
│   └── payment.routes.js             # NEW — /payment/webhook
│
├── /controllers
│   ├── jobs.controller.js             # NEW — business logic for all job endpoints
│   ├── admin.controller.js            # NEW — admin endpoint logic
│   ├── conversations.controller.js    # NEW — conversation CRUD logic
│   ├── technicians.controller.js      # NEW — public technician list
│   ├── wallet.controller.js           # NEW — wallet endpoints
│   └── payment.controller.js         # NEW — Razorpay webhook handler
│
├── /services
│   ├── settings.service.js            # NEW — settings cache + helpers (extracted from server.js)
│   ├── dispatch.service.js            # NEW — findNearestTechnicians, watchdog (extracted)
│   ├── geocode.service.js             # NEW — reverseGeocode, geocodeAddress (extracted)
│   ├── notification.service.js        # NEW — sendCustomerMessage, sendTechnicianOffer helpers
│   ├── messageRouter.js               # UPDATED — Redis-backed rate limiter + booking lock
│   ├── paymentService.js              # UNCHANGED
│   ├── whatsappClient.js              # UNCHANGED
│   ├── apiClient.js                   # UNCHANGED
│   └── retryService.js               # UNCHANGED
│
├── /queues
│   ├── redisClient.js                 # UNCHANGED
│   └── queue.js                       # UNCHANGED
│
├── /workers
│   ├── messageWorker.js               # UNCHANGED
│   ├── jobWorker.js                   # UNCHANGED
│   └── whatsappWorker.js              # UNCHANGED
│
└── /utils
    └── gracefulShutdown.js            # UNCHANGED
```

## Key changes summary

| Area | What changed |
|------|-------------|
| server.js | Reduced from ~900 LOC to ~120 LOC — only bootstrap + route mounting |
| Rate limiters | Moved to `/middleware/rateLimiters.js`, optionally Redis-backed |
| In-memory state | `bookingInFlight` (Set) → Redis `SETNX` with TTL; rate-limit Map → Redis |
| Route duplication | `/admin/settings` defined once in `admin.routes.js` (removed from adminSettingsRoutes.js redundancy) |
| Error handling | All routes throw; centralized `errorHandler.js` catches everything |
| Settings | Extracted to `settings.service.js`, single source of truth |
| Dispatch | Extracted to `dispatch.service.js` |
| Geocoding | Extracted to `geocode.service.js` |
| Logging | All logs use `{ ts, ctx, msg, ...meta }` JSON format consistently |
