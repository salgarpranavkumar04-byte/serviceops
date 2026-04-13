'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   server.js — ServiceOps Express API Server  (v5 — REFACTORED)
   ═══════════════════════════════════════════════════════════════════════════
   CHANGES FROM v4:
   • Reduced from ~900 LOC to ~140 LOC — only bootstrap + route mounting
   • All route handlers moved to /controllers/*
   • All routes moved to /routes/*
   • Settings/commission cache moved to services/settings.service.js
   • Dispatch logic moved to services/dispatch.service.js
   • Geocoding moved to services/geocode.service.js
   • Notification helpers moved to services/notification.service.js
   • Rate limiters moved to middleware/rateLimiters.js (optionally Redis-backed)
   • Raw body capture moved to middleware/rawBody.js
   • Centralized error handling via middleware/errorHandler.js
   • bookingInFlight Set → Redis SETNX (in messageRouter.js)
   • rateLimitWindows Map → Redis INCR (in messageRouter.js)
   • /admin/settings has ONE definition (admin.routes.js, not adminSettingsRoutes.js)
   ═══════════════════════════════════════════════════════════════════════════ */

// ── STEP 1: Load env + validate BEFORE everything else ────────────────────
require('dotenv').config();
const { validateEnv } = require('./config/validateEnv');
validateEnv();

// ── STEP 2: Imports ───────────────────────────────────────────────────────
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');

const db                            = require('./db/db');
const { loadSettings, loadCommissionRules } = require('./services/settings.service');
const { runTimeoutChecks }          = require('./services/dispatch.service');
const { registerGracefulShutdown }  = require('./utils/gracefulShutdown');

// Middleware
const rawBodyMiddleware             = require('./middleware/rawBody');
const requestLogger                 = require('./middleware/requestLogger');
const { authenticate, requireWrite }     = require('./middleware/authenticate');
const { globalLimiter }             = require('./middleware/rateLimiters');
const { errorHandler }              = require('./middleware/errorHandler');

// Routes
const whatsappRouter                = require('./routes/whatsappRouter');
const { router: jobsRouter, internalRouter } = require('./routes/jobs.routes');
const adminRouter                   = require('./routes/admin.routes');
const conversationsRouter           = require('./routes/conversations.routes');
const walletRouter                  = require('./routes/wallet.routes');
const techniciansRouter             = require('./routes/technicians.routes');
const paymentRouter                 = require('./routes/payment.routes');
const warrantyRouter                = require('./routes/warranty.routes');

/* ═══════════════════════════════════════════════════════════════════════════
   APP SETUP
   ═══════════════════════════════════════════════════════════════════════════ */

const app = express();

// ── CORS — must come BEFORE helmet so preflight OPTIONS requests are handled
//    and before any route so headers appear on every response
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods:     ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
  credentials: false,
}));

// ── Security — after CORS so helmet doesn't block cross-origin preflight
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── Raw body + JSON parsing ────────────────────────────────────────────────
// rawBodyMiddleware is bodyParser.json() with a verify callback that saves
// req.rawBody. It handles both JSON parsing AND raw body capture in one pass
// so the stream is only consumed once (fixes the "stream not readable" crash).
app.use(rawBodyMiddleware);

// ── Request logging — after body parsing so req.body is available if needed
app.use(requestLogger);

app.use(globalLimiter);

/* ═══════════════════════════════════════════════════════════════════════════
   UNAUTHENTICATED ROUTES
   ═══════════════════════════════════════════════════════════════════════════ */

// WhatsApp webhook — auth handled via HMAC signature inside route
app.use('/webhook', whatsappRouter);

// Razorpay webhook — auth handled via HMAC signature inside controller
app.use('/payment', paymentRouter);

// Internal watchdog tick — auth handled via x-internal-secret inside controller
app.use('/internal', internalRouter);

// Public technician list (used by map view — authenticated so phone/location data is protected)
app.use('/technicians', authenticate, techniciansRouter);

// Admin dashboard HTML
app.get('/admin/dashboard', authenticate, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// Health check — no auth needed for monitoring systems
app.get('/health', async (req, res) => {
  try {
    const [dbResult, dbHealth] = await Promise.all([
      db.query('SELECT NOW()'),
      Promise.resolve(db.getHealthSnapshot()),
    ]);

    // Check Redis if configured
    let redisStatus = 'not_configured';
    if (process.env.REDIS_URL) {
      try {
        const { isReady } = require('./queues/redisClient');
        redisStatus = isReady() ? 'ok' : 'disconnected';
      } catch {
        redisStatus = 'error';
      }
    }

    res.json({
      status:    'ok',
      time:      dbResult.rows[0],
      db:        dbHealth,
      redis:     redisStatus,
      uptime:    process.uptime(),
      memory:    process.memoryUsage(),
    });
  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), ctx: '[health]', msg: err.message,
    }));
    res.status(500).json({
      status: 'error',
      db:     db.getHealthSnapshot(),
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   AUTHENTICATED ROUTES
   All groups below require a valid x-api-key header.
   ═══════════════════════════════════════════════════════════════════════════ */

app.use('/admin',         authenticate, adminRouter);
app.use('/jobs',          authenticate, jobsRouter);
app.use('/wallet',        authenticate, walletRouter);
app.use('/conversations',  authenticate, conversationsRouter);
app.use('/warranty',      authenticate, warrantyRouter);

/* ═══════════════════════════════════════════════════════════════════════════
   CENTRALIZED ERROR HANDLER  (must be LAST)
   ═══════════════════════════════════════════════════════════════════════════ */

app.use(errorHandler);

/* ═══════════════════════════════════════════════════════════════════════════
   SERVER STARTUP
   ═══════════════════════════════════════════════════════════════════════════ */

const PORT = parseInt(process.env.PORT || '8000', 10);

async function start() {
  // Load settings + commission rules before accepting traffic
  await loadSettings();
  await loadCommissionRules();

  // Refresh commission rules every 5 minutes
  setInterval(loadCommissionRules, 5 * 60 * 1000);

  // Watchdog: check for timed-out jobs every 30 seconds
  setInterval(runTimeoutChecks, 30 * 1000);

  const server = app.listen(PORT, () => {
    console.log(JSON.stringify({
      ts:      new Date().toISOString(),
      ctx:     '[server]',
      msg:     `Running ✓`,
      port:    PORT,
      env:     process.env.NODE_ENV,
      redis:   !!process.env.REDIS_URL,
    }));
  });

  // Graceful shutdown — handles SIGTERM, SIGINT, uncaughtException
  registerGracefulShutdown(server, {
    onShutdown: async () => {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), ctx: '[server]', msg: 'Custom cleanup complete',
      }));
    },
  });
}

start().catch(err => {
  console.error(JSON.stringify({
    ts:  new Date().toISOString(),
    ctx: '[server][fatal]',
    msg: 'Startup failed',
    err: err.message,
    stack: err.stack,
  }));
  process.exit(1);
});
