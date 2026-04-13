'use strict';

/**
 * services/messageRouter.js — WhatsApp conversation state machine (v5)
 *
 * CHANGES FROM v4:
 *   • Per-phone rate limiter now Redis-backed (SET with EX + INCR)
 *     — falls back to in-process Map when Redis unavailable (dev / single instance)
 *     — safe across multiple server instances
 *   • CONFIRM_BOOKING idempotency lock now Redis SETNX with TTL
 *     — replaces in-process bookingInFlight Set (not safe across instances)
 *   • All other logic unchanged
 */

const { safePost, safeGet } = require('./apiClient');
const { sendText, sendButtons, sendLocation } = require('./whatsappClient');
const {
  checkActiveWarranty,
  createWarrantyClaim,
  formatDate,
} = require('./warranty.service');

/* ─── Structured logger ───────────────────────────────────────────────────── */

function log(ctx, msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx, msg, ...meta }));
}
function logError(ctx, msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx, msg, ...meta }));
}

/* ─── Validators ──────────────────────────────────────────────────────────── */

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

function isValidPhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone.trim());
}
function isValidButtonId(id) {
  return typeof id === 'string' && id.trim().length > 0 && id.length <= 256;
}
function isValidLocation(loc) {
  if (!loc || typeof loc !== 'object') return false;
  const { latitude: lat, longitude: lng } = loc;
  return (
    typeof lat === 'number' && lat >= -90  && lat <= 90 &&
    typeof lng === 'number' && lng >= -180 && lng <= 180
  );
}

/* ─── Phone normaliser ────────────────────────────────────────────────────── */

function normalizePhoneForBackend(phone) {
  const clean = phone.replace(/^\+/, '');
  if (clean.startsWith('91') && clean.length === 12) return clean.slice(2);
  return clean;
}

/* ═══════════════════════════════════════════════════════════════════════════
   REDIS-BACKED RATE LIMITER  (replaces in-process Map)
   ═══════════════════════════════════════════════════════════════════════════ */

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_TTL = 60; // seconds

// In-process fallback (single instance / Redis unavailable)
const rateLimitWindows = new Map();
const RATE_LIMIT_MS    = RATE_LIMIT_TTL * 1000;

let _redisClient = null;
function getRedis() {
  if (_redisClient) return _redisClient;
  try {
    const { getRedisClient } = require('../queues/redisClient');
    _redisClient = getRedisClient();
  } catch { _redisClient = null; }
  return _redisClient;
}

/**
 * Returns true if this phone is over its message rate limit.
 * Uses Redis INCR + EXPIRE when available; falls back to in-process Map.
 *
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
async function isRateLimited(phone) {
  const redis = getRedis();

  if (redis) {
    try {
      const key   = `rl:msg:${phone}`;
      const count = await redis.incr(key);
      if (count === 1) {
        // First hit in this window — set TTL
        await redis.expire(key, RATE_LIMIT_TTL);
      }
      return count > RATE_LIMIT_MAX;
    } catch (err) {
      logError('[rateLimit]', 'Redis rate-limit error — falling back to local Map', { err: err.message });
      // Fall through to local Map
    }
  }

  // In-process fallback
  const now   = Date.now();
  const entry = rateLimitWindows.get(phone);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_MS) {
    rateLimitWindows.set(phone, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Prune stale in-process entries every 5 min (only needed when Redis is down)
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_MS;
  for (const [phone, entry] of rateLimitWindows) {
    if (entry.windowStart < cutoff) rateLimitWindows.delete(phone);
  }
}, 5 * 60_000);

/* ═══════════════════════════════════════════════════════════════════════════
   REDIS-BACKED BOOKING LOCK  (replaces in-process Set)
   ═══════════════════════════════════════════════════════════════════════════ */

const BOOKING_LOCK_TTL = 30; // seconds — long enough for the API call to complete

// In-process fallback
const bookingInFlightLocal = new Set();

/**
 * Tries to acquire a booking lock for a phone.
 * Returns true if lock acquired (proceed), false if already locked (skip).
 *
 * Uses Redis SETNX with TTL to prevent double-booking across instances.
 *
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
async function acquireBookingLock(phone) {
  const redis = getRedis();

  if (redis) {
    try {
      const key    = `lock:booking:${phone}`;
      const result = await redis.set(key, '1', 'EX', BOOKING_LOCK_TTL, 'NX');
      return result === 'OK'; // null = already locked
    } catch (err) {
      logError('[bookingLock]', 'Redis lock error — falling back to local Set', { err: err.message });
    }
  }

  // In-process fallback
  if (bookingInFlightLocal.has(phone)) return false;
  bookingInFlightLocal.add(phone);
  return true;
}

/**
 * Release the booking lock.
 *
 * @param {string} phone
 */
async function releaseBookingLock(phone) {
  const redis = getRedis();

  if (redis) {
    try {
      await redis.del(`lock:booking:${phone}`);
      return;
    } catch (err) {
      logError('[bookingLock]', 'Redis unlock error', { err: err.message });
    }
  }

  bookingInFlightLocal.delete(phone);
}

/* ─── Conversation state constants ───────────────────────────────────────── */

const STATES = {
  IDLE:                    'idle',
  SERVICE_SELECTED:        'service_selected',
  NAME_REQUESTED:          'name_requested',
  LOCATION_RECEIVED:       'location_received',
  AWAITING_PRICE_APPROVAL: 'awaiting_price_approval',
  PRICE_ENTRY:             'price_entry',
  COMPLETED:               'completed',
  WARRANTY_DESCRIBE:       'warranty_describe',  // customer describing warranty issue
  WARRANTY_CONFIRM:        'warranty_confirm',   // customer confirming claim submission
};

/* ─── sendReply alias ─────────────────────────────────────────────────────── */

const sendReply = (phone, text) => sendText(phone, text);

/* ─── Service selection buttons ───────────────────────────────────────────── */

async function sendServiceSelectionButtons(phone) {
  await sendButtons(
    phone,
    'Welcome to ServiceOps! 👋\nPlease select the service you need:',
    [
      { id: 'SELECT_SERVICE_PLUMBER',     title: 'Plumber'     },
      { id: 'SELECT_SERVICE_ELECTRICIAN', title: 'Electrician' },
    ]
  );
}

/* ─── Conversation helpers ────────────────────────────────────────────────── */

async function getConversation(phone, rid) {
  const { data, error } = await safeGet(
    `/conversations/${encodeURIComponent(phone)}`, {}, 'conversation'
  );
  if (error) {
    logError('[conv]', 'Failed to fetch conversation', { phone, rid, error });
    return null;
  }
  return data?.conversation || null;
}

async function upsertConversation(phone, state, contextPatch, rid) {
  const { data, error } = await safePost('/conversations/upsert', {
    phone,
    state,
    context: contextPatch,
  }, 'conversation');
  if (error) {
    logError('[conv]', 'Failed to upsert conversation', { phone, state, rid, error });
    return false;
  }
  return !!data?.success;
}

async function resetConversation(phone, rid) {
  return upsertConversation(phone, STATES.IDLE, {}, rid);
}

/* ─── Context safety ──────────────────────────────────────────────────────── */

function safeContext(raw) {
  if (!raw) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

/* ─── Payload extractor ───────────────────────────────────────────────────── */

function extractMessage(body) {
  try {
    const message   = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return null;
    const from      = message.from;
    const messageId = message.id;
    const type      = message.type;
    if (!from || !messageId || !type) return null;
    return { message, from, messageId, type };
  } catch {
    return null;
  }
}

/* ─── Known buttons ───────────────────────────────────────────────────────── */

const KNOWN_BUTTONS = new Set([
  'SELECT_SERVICE_PLUMBER', 'SELECT_SERVICE_ELECTRICIAN',
  'CONFIRM_BOOKING', 'CANCEL',
  'ACCEPT_JOB', 'REJECT_JOB',
  'START_JOB', 'REQUEST_PAYMENT', 'COMPLETE_JOB',
  'APPROVE_PRICE', 'REJECT_PRICE',
]);

const SERVICE_BUTTON_MAP = {
  SELECT_SERVICE_PLUMBER:     'PLUMBER',
  SELECT_SERVICE_ELECTRICIAN: 'ELECTRICIAN',
};

/* ─── Main router ─────────────────────────────────────────────────────────── */

async function routeMessage({ message, from, messageId, type }) {
  const rid = messageId || `noId_${Date.now()}`;

  try {
    if (!isValidPhone(from)) {
      logError('[router]', 'Invalid phone — ignored', { from, rid });
      return;
    }

    const limited = await isRateLimited(from);
    if (limited) {
      log('[router]', 'Rate limit hit — ignored', { from, rid, type });
      return;
    }

    log('[router]', 'Routing message', { from: from.slice(-4), rid, type });

    switch (type) {
      case 'interactive': return await handleInteractive(message, from, rid);
      case 'location':    return await handleLocation(message, from, rid);
      case 'text':        return await handleText(message, from, rid);
      default:
        log('[router]', 'Unknown message type — ignored', { type, from, rid });
    }
  } catch (err) {
    logError('[error]', 'Unhandled error in routeMessage', { from, rid, type, err: err.message });
  }
}

/* ─── Type handlers ───────────────────────────────────────────────────────── */

async function handleInteractive(message, from, rid) {
  try {
    const rawButtonId =
      message?.interactive?.button_reply?.id ||
      message?.interactive?.list_reply?.id;

    if (!isValidButtonId(rawButtonId)) {
      logError('[router]', 'Invalid button_id — ignored', { from, rid, rawButtonId });
      return;
    }

    let buttonId      = rawButtonId;
    let embeddedJobId = null;

    if (rawButtonId.includes(':')) {
      const colonIdx = rawButtonId.indexOf(':');
      buttonId       = rawButtonId.slice(0, colonIdx);
      embeddedJobId  = rawButtonId.slice(colonIdx + 1) || null;
    }

    if (!KNOWN_BUTTONS.has(buttonId)) {
      log('[router]', 'Unknown button_id — ignored safely', { from, rid, buttonId });
      return;
    }

    if (embeddedJobId && message?.interactive?.button_reply) {
      message.interactive.button_reply.payload = embeddedJobId;
    }

    log('[router]', 'Button received', { from: from.slice(-4), rid, buttonId, embeddedJobId });
    await dispatchButton(buttonId, from, message, rid);
  } catch (err) {
    logError('[error]', 'handleInteractive failed', { from, rid, err: err.message });
  }
}

async function handleLocation(message, from, rid) {
  try {
    const loc = message?.location;
    if (!isValidLocation(loc)) {
      logError('[router]', 'Invalid location — ignored', { from, rid });
      return;
    }

    const { latitude, longitude } = loc;
    log('[router]', 'Location received', { from: from.slice(-4), rid, lat: latitude, lng: longitude });

    const conv            = await getConversation(from, rid);
    const existingContext = safeContext(conv?.context);

    if (!existingContext) {
      logError('[conv]', 'Corrupted context on location — resetting', { from, rid });
      await resetConversation(from, rid);
      await sendReply(from, 'Something went wrong. Please start over by selecting a service.');
      return;
    }

    const ok = await upsertConversation(from, STATES.LOCATION_RECEIVED, {
      ...existingContext,
      latitude,
      longitude,
    }, rid);

    if (!ok) {
      logError('[conv]', 'Failed to store location', { from, rid });
      return;
    }

    log('[conv]', 'Location saved', { from: from.slice(-4), rid });

    if (existingContext.service) {
      await sendButtons(
        from,
        `📍 Got your location!\n\nService: *${existingContext.service}*\n\n` +
        `${existingContext.customer_name ? `Name: *${existingContext.customer_name}*\n\n` : ''}` +
        `Ready to confirm your booking?`,
        [
          { id: 'CONFIRM_BOOKING', title: 'Confirm Booking' },
          { id: 'CANCEL',          title: 'Cancel'          },
        ]
      );
    } else {
      await sendServiceSelectionButtons(from);
    }
  } catch (err) {
    logError('[error]', 'handleLocation failed', { from, rid, err: err.message });
  }
}

async function handleText(message, from, rid) {
  try {
    const text = message?.text?.body;
    if (typeof text !== 'string' || text.trim().length === 0) {
      log('[router]', 'Empty text — ignored', { from, rid });
      return;
    }

    const conv  = await getConversation(from, rid);
    const ctx   = safeContext(conv?.context);
    const state = conv?.state;

    // ── STATE: name_requested ────────────────────────────────────────────
    if (state === STATES.NAME_REQUESTED) {
      const rawName   = text.trim().slice(0, 50);
      const cleanName = rawName.replace(/[^\w\s\u0900-\u097F'-]/g, '').trim();
      if (cleanName.length < 2) {
        await sendReply(from, 'Please enter your full name (at least 2 characters).');
        return;
      }

      await upsertConversation(from, STATES.SERVICE_SELECTED, {
        ...(ctx || {}),
        customer_name: cleanName,
      }, rid);

      log('[conv]', 'Name captured', { from: from.slice(-4), rid, cleanName });
      await sendText(
        from,
        `Thanks, *${cleanName}*! 👋\n\n` +
        `Please share your location so we can find the nearest technician.\n\n` +
        `Tap the 📎 attachment icon → *Location* to share.`
      );
      return;
    }

    // ── STATE: price_entry (technician entering price) ───────────────────
    if (state === STATES.PRICE_ENTRY && ctx?.pending_job_id) {
      const parsed = parseFloat(text.trim().replace(/[₹,\s]/g, ''));
      if (isNaN(parsed) || parsed < 1 || parsed > 1_000_000) {
        await sendReply(
          from,
          '❌ Invalid price. Please enter a valid amount in rupees (e.g. *750*).\n\n' +
          'The price must be between ₹1 and ₹1,00,000.'
        );
        return;
      }

      const jobId = ctx.pending_job_id;
      log('[command]', 'SET_PRICE from text', { from: from.slice(-4), rid, jobId, price: parsed });

      const techPhone = normalizePhoneForBackend(from);
      const { data, error } = await safePost(`/jobs/${jobId}/set-price`, {
        technician_phone: techPhone,
        price:            parsed,
      }, 'set_price');

      if (error || !data?.success) {
        await sendReply(
          from,
          `❌ Could not set price: ${data?.message || 'server error'}. Please try again.`
        );
        return;
      }

      await upsertConversation(from, STATES.IDLE, {}, rid);

      await sendReply(
        from,
        `✅ Price *₹${parsed.toLocaleString('en-IN')}* submitted!\n\n` +
        `The customer has been notified and must approve before payment is collected.`
      );
      return;
    }

    // ── STATE: warranty_describe — customer typing the issue description ──
    if (state === STATES.WARRANTY_DESCRIBE && ctx?.warranty_id) {
      const desc = text.trim().slice(0, 500);
      if (desc.length < 5) {
        await sendReply(from, 'Please describe the issue in a few words (at least 5 characters).');
        return;
      }

      await upsertConversation(from, STATES.WARRANTY_CONFIRM, {
        ...ctx,
        warranty_issue: desc,
      }, rid);

      log('[warranty]', 'Issue description captured', { from: from.slice(-4), rid, warrantyId: ctx.warranty_id });

      await sendButtons(
        from,
        `📋 *Warranty claim summary*\n\n` +
        `Service: *${ctx.warranty_service_type || 'Service'}*\n` +
        `Original job: #${(ctx.original_job_id || '').slice(0, 8)}\n` +
        `Issue reported: ${desc}\n\n` +
        `This revisit is completely *free*. Confirm your claim?`,
        [
          { id: `CONFIRM_WARRANTY_CLAIM:${ctx.warranty_id}`, title: 'Confirm claim' },
          { id: 'CANCEL',                                     title: 'Cancel'        },
        ]
      );
      return;
    }

    // ── Default ──────────────────────────────────────────────────────────
    log('[router]', 'Free text — sending service menu', { from: from.slice(-4), rid });
    await sendServiceSelectionButtons(from);

  } catch (err) {
    logError('[error]', 'handleText failed', { from, rid, err: err.message });
  }
}

/* ─── Button dispatcher ───────────────────────────────────────────────────── */

async function dispatchButton(buttonId, from, message, rid) {
  const jobId = extractJobId(message);

  switch (buttonId) {

    case 'SELECT_SERVICE_PLUMBER':
    case 'SELECT_SERVICE_ELECTRICIAN': {
      const serviceType = SERVICE_BUTTON_MAP[buttonId];
      log('[command]', 'Service selected', { from: from.slice(-4), rid, serviceType });

      const ok = await upsertConversation(from, STATES.NAME_REQUESTED, {
        service: serviceType,
      }, rid);

      if (!ok) {
        logError('[conv]', 'Failed to store service selection', { from, rid, serviceType });
        await sendReply(from, 'Could not save your selection. Please try again.');
      } else {
        await sendText(
          from,
          `✅ *${serviceType}* selected!\n\n` +
          `Please reply with your *full name* so our technician knows who to visit. 👤`
        );
      }
      break;
    }

    case 'CONFIRM_BOOKING':
      await handleConfirmBooking(from, rid);
      break;

    case 'CANCEL': {
      log('[command]', 'CANCEL — resetting conversation', { from: from.slice(-4), rid });
      await resetConversation(from, rid);
      await sendServiceSelectionButtons(from);
      break;
    }

    case 'ACCEPT_JOB':
      await commandAcceptJob(from, jobId, rid);
      break;

    case 'REJECT_JOB':
      log('[command]', 'REJECT_JOB', { from: from.slice(-4), rid, jobId });
      if (jobId) {
        const techPhone = normalizePhoneForBackend(from);
        await safePost(`/jobs/${jobId}/reject-offer`, { technician_phone: techPhone }, 'command');
      }
      break;

    case 'START_JOB':
      await commandStartJob(from, jobId, rid);
      break;

    case 'REQUEST_PAYMENT':
      await commandRequestPayment(from, jobId, rid);
      break;

    case 'COMPLETE_JOB':
      await commandCompleteJob(jobId, rid);
      break;

    case 'APPROVE_PRICE':
      await commandApprovePrice(from, jobId, rid);
      break;

    case 'REJECT_PRICE':
      await commandRejectPrice(from, jobId, rid);
      break;

    case 'CLAIM_WARRANTY':
      await commandClaimWarranty(from, jobId, rid);
      break;

    case 'CONFIRM_WARRANTY_CLAIM': {
      const conv = await getConversation(from, rid);
      const ctx2 = safeContext(conv?.context);
      if (conv?.state !== STATES.WARRANTY_CONFIRM || !ctx2?.warranty_id) {
        await sendReply(from, 'Session expired. Please tap *Claim Warranty* on your completion message again.');
        return;
      }
      await commandConfirmWarrantyClaim(from, ctx2.warranty_id, ctx2.warranty_issue || '', rid);
      break;
    }

    case 'MARK_DONE':
      await commandMarkDone(from, jobId, rid);
      break;

    default:
      log('[router]', 'dispatchButton: unhandled button — ignored', { buttonId, from, rid });
  }
}

/* ─── CONFIRM_BOOKING handler ────────────────────────────────────────────── */

async function handleConfirmBooking(from, rid) {
  log('[command]', 'CONFIRM_BOOKING received', { from: from.slice(-4), rid });

  const locked = await acquireBookingLock(from);
  if (!locked) {
    log('[command]', 'CONFIRM_BOOKING — booking already in flight, skipping', { from, rid });
    return;
  }

  try {
    const conv = await getConversation(from, rid);

    if (!conv) {
      logError('[command]', 'CONFIRM_BOOKING — no conversation found', { from, rid });
      await sendReply(from, 'No active session found. Please select a service to start.');
      return;
    }

    const ctx = safeContext(conv.context);
    if (ctx === null) {
      logError('[command]', 'CONFIRM_BOOKING — corrupted context, resetting', { from, rid });
      await resetConversation(from, rid);
      await sendReply(from, 'Your session data is invalid. Please start over by selecting a service.');
      return;
    }

    if (!ctx.service) {
      await sendServiceSelectionButtons(from);
      return;
    }
    if (ctx.latitude === undefined || ctx.longitude === undefined) {
      await sendText(from,
        'Please share your location before confirming.\n\n' +
        'Tap the 📎 attachment icon → *Location* to share.'
      );
      return;
    }
    if (!ctx.customer_name) {
      await upsertConversation(from, STATES.NAME_REQUESTED, ctx, rid);
      await sendText(from, 'Please reply with your *full name* to complete booking.');
      return;
    }
    if (ctx.job_id) {
      log('[command]', 'CONFIRM_BOOKING — duplicate, job already created', { from, rid, job_id: ctx.job_id });
      await sendReply(
        from,
        `Your booking is already confirmed (Job #${ctx.job_id.slice(0, 8)}). A technician is on the way.`
      );
      return;
    }

    const customerPhone = normalizePhoneForBackend(from);
    log('[command]', 'Creating job', {
      from: from.slice(-4), rid, customerPhone,
      service: ctx.service, lat: ctx.latitude, lng: ctx.longitude,
    });

    const { data, error, status: httpStatus } = await safePost('/jobs/create', {
      customer_name:  ctx.customer_name,
      customer_phone: customerPhone,
      service_type:   ctx.service,
      latitude:       ctx.latitude,
      longitude:      ctx.longitude,
      request_id:     rid,
    }, 'confirm_booking');

    if (error) {
      logError('[command]', 'CONFIRM_BOOKING — /jobs/create network error', { from, rid, error, httpStatus });
      await sendReply(from, 'We could not confirm your booking due to a server error. Please try again.');
      return;
    }

    if (data?.duplicate && data?.job_id) {
      log('[command]', 'CONFIRM_BOOKING — backend returned duplicate', { from, rid, job_id: data.job_id });
      await upsertConversation(from, STATES.COMPLETED, { ...ctx, job_id: data.job_id }, rid);
      await resetConversation(from, rid);
      await sendReply(
        from,
        `Your booking is already confirmed (Job #${data.job_id.slice(0, 8)}). A technician is on the way.`
      );
      return;
    }

    if (!data?.success && data?.offers_sent === 0) {
      logError('[command]', 'CONFIRM_BOOKING — no technicians available', { from, rid });
      await resetConversation(from, rid);
      await sendReply(from, 'Sorry, no technician is available right now. Please try again in a few minutes.');
      return;
    }

    if (!data?.success) {
      logError('[command]', 'CONFIRM_BOOKING — /jobs/create failure', { from, rid, message: data?.message });
      await sendReply(from, `Booking failed: ${data?.message || 'unknown error'}. Please try again.`);
      return;
    }

    const jobId = data.job_id;
    log('[command]', 'Job created ✓', { from: from.slice(-4), rid, jobId, offers_sent: data.offers_sent });

    await upsertConversation(from, STATES.COMPLETED, { ...ctx, job_id: jobId }, rid);
    await resetConversation(from, rid);

    const addressLine = data.customer_address ? `\n📍 ${data.customer_address}` : '';

    await sendReply(
      from,
      `✅ *Booking confirmed!*\n\n` +
      `We are finding a *${ctx.service.toLowerCase()}* near you.${addressLine}\n\n` +
      `You will be notified when a technician accepts your request.\n` +
      `Job #${jobId.slice(0, 8)}`
    );

  } finally {
    await releaseBookingLock(from);
  }
}

/* ─── Job ID extraction ───────────────────────────────────────────────────── */

function extractJobId(message) {
  try {
    const buttonPayload = message?.interactive?.button_reply?.payload;
    if (buttonPayload) {
      const parsed = safeParseJSON(buttonPayload);
      if (parsed?.job_id) return parsed.job_id;
      if (typeof buttonPayload === 'string' && buttonPayload.length < 100) return buttonPayload;
    }
    const listPayload = message?.interactive?.list_reply?.description;
    if (listPayload) {
      const parsed = safeParseJSON(listPayload);
      if (parsed?.job_id) return parsed.job_id;
    }
    const contextId = message?.context?.id;
    if (contextId) return contextId;
    return null;
  } catch {
    return null;
  }
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/* ─── Technician command functions ───────────────────────────────────────── */

async function commandAcceptJob(technicianPhone, jobId, rid) {
  if (!jobId) {
    logError('[command]', 'ACCEPT_JOB — missing job_id', { technicianPhone, rid });
    return;
  }
  log('[command]', 'ACCEPT_JOB', { technicianPhone: technicianPhone.slice(-4), jobId, rid });
  const techPhone = normalizePhoneForBackend(technicianPhone);
  const { data, error } = await safePost(`/jobs/${jobId}/accept`, { technician_phone: techPhone }, 'command');
  if (error) {
    logError('[command]', 'ACCEPT_JOB API call failed', { technicianPhone, jobId, rid });
    return;
  }
  if (data?.success) {
    await sendButtons(
      technicianPhone,
      `✅ *Job #${jobId.slice(0, 8)} Accepted!*\n\n` +
      `Service: *${data.service_type || ''}*\n` +
      `Customer: *${data.customer_name || 'Customer'}*\n\n` +
      `When you arrive and start working, press Start Job.`,
      [
        { id: `START_JOB:${jobId}`,    title: 'Start Job'  },
        { id: `CANCEL:${jobId}`,       title: 'Cancel Job' },
      ]
    );
  } else {
    await sendReply(technicianPhone, data?.message || 'Could not accept this job. It may have been taken by another technician.');
  }
}

async function commandStartJob(technicianPhone, jobId, rid) {
  if (!jobId) {
    logError('[command]', 'START_JOB — missing job_id', { technicianPhone, rid });
    return;
  }
  log('[command]', 'START_JOB', { technicianPhone: technicianPhone.slice(-4), jobId, rid });
  const techPhone = normalizePhoneForBackend(technicianPhone);
  const { data, error } = await safePost(`/jobs/${jobId}/start`, { technician_phone: techPhone }, 'command');
  if (error || !data?.success) {
    logError('[command]', 'START_JOB API call failed', { technicianPhone, jobId, rid });
    return;
  }

  // ── Warranty jobs: skip price entry, send MARK_DONE button instead ───────
  if (data.is_warranty_job) {
    log('[command]', 'START_JOB — warranty job, skipping price entry', { technicianPhone: technicianPhone.slice(-4), jobId, rid });
    await sendButtons(
      technicianPhone,
      `🔧 *Warranty job #${jobId.slice(0, 8)} started!*\n\n` +
      `Complete the repair, then tap below to mark it done.\n` +
      `This job is free for the customer.`,
      [
        { id: `MARK_DONE:${jobId}`, title: 'Mark done' },
      ]
    );
    // No PRICE_ENTRY state — technician goes straight to marking done
    return;
  }

  // ── Normal job: enter price ────────────────────────────────────────────────
  await sendText(
    technicianPhone,
    `🔧 *Job #${jobId.slice(0, 8)} started!*\n\n` +
    `Once you've inspected the issue, reply with the *price in rupees* to proceed.\n\n` +
    `Example: reply with *750* to quote ₹750.`
  );
  await upsertConversation(technicianPhone, STATES.PRICE_ENTRY, {
    pending_job_id: jobId,
  }, rid);
}

async function commandRequestPayment(technicianPhone, jobId, rid) {
  if (!jobId) {
    logError('[command]', 'REQUEST_PAYMENT — missing job_id', { technicianPhone, rid });
    return;
  }
  log('[command]', 'REQUEST_PAYMENT', { technicianPhone: technicianPhone.slice(-4), jobId, rid });
  const techPhone = normalizePhoneForBackend(technicianPhone);
  const { error } = await safePost(`/jobs/${jobId}/request-payment`, { technician_phone: techPhone }, 'command');
  if (error) logError('[command]', 'REQUEST_PAYMENT API call failed', { technicianPhone, jobId, rid });
}

async function commandCompleteJob(jobId, rid) {
  if (!jobId) {
    logError('[command]', 'COMPLETE_JOB — missing job_id', { rid });
    return;
  }
  log('[command]', 'COMPLETE_JOB', { jobId, rid });
  const { error } = await safePost(`/jobs/${jobId}/complete`, {}, 'command');
  if (error) logError('[command]', 'COMPLETE_JOB API call failed', { jobId, rid });
}

async function commandApprovePrice(customerPhone, jobId, rid) {
  if (!jobId) {
    logError('[command]', 'APPROVE_PRICE — missing job_id', { customerPhone, rid });
    return;
  }
  log('[command]', 'APPROVE_PRICE', { customerPhone: customerPhone.slice(-4), jobId, rid });
  const phone = normalizePhoneForBackend(customerPhone);
  const { data, error } = await safePost(`/jobs/${jobId}/approve-price`, { customer_phone: phone }, 'command');

  if (error || !data?.success) {
    await sendReply(customerPhone, data?.message || 'Could not approve price. Please try again.');
    return;
  }
  await sendReply(
    customerPhone,
    `✅ *Price approved!*\n\nYou will receive a payment link shortly.\n\nJob #${jobId.slice(0, 8)}`
  );
}

async function commandRejectPrice(customerPhone, jobId, rid) {
  if (!jobId) {
    logError('[command]', 'REJECT_PRICE — missing job_id', { customerPhone, rid });
    return;
  }
  log('[command]', 'REJECT_PRICE', { customerPhone: customerPhone.slice(-4), jobId, rid });
  const phone = normalizePhoneForBackend(customerPhone);
  const { data, error } = await safePost(`/jobs/${jobId}/reject-price`, { customer_phone: phone }, 'command');

  if (error || !data?.success) {
    await sendReply(customerPhone, data?.message || 'Could not process price rejection. Please try again.');
    return;
  }
  await sendReply(
    customerPhone,
    `❌ *Price rejected.*\n\nWe've notified your technician.\n` +
    `They will re-assess and send you a revised quote.`
  );
}

/* ─── Warranty command functions ──────────────────────────────────────────── */

/**
 * CLAIM_WARRANTY button — customer taps after receiving post-completion message.
 * jobId here is the ORIGINAL completed job ID (encoded in button payload).
 */
async function commandClaimWarranty(customerPhone, jobId, rid) {
  if (!jobId) {
    logError('[warranty]', 'CLAIM_WARRANTY — missing job_id', { customerPhone, rid });
    await sendReply(customerPhone, 'Could not find your job. Please contact support.');
    return;
  }

  log('[warranty]', 'CLAIM_WARRANTY received', { customerPhone: customerPhone.slice(-4), jobId, rid });

  const warranty = await checkActiveWarranty(jobId);

  if (!warranty) {
    await sendReply(
      customerPhone,
      `No warranty record found for Job #${jobId.slice(0, 8)}.\nPlease contact support.`
    );
    return;
  }

  if (warranty.status === 'EXPIRED' || warranty.is_expired) {
    await sendButtons(
      customerPhone,
      `Your warranty for Job #${jobId.slice(0, 8)} expired on *${warranty.expires_label || formatDate(warranty.expires_at)}*.\n\n` +
      `Would you like to book a new paid service?`,
      [
        { id: 'SELECT_SERVICE_PLUMBER',     title: 'Plumber'      },
        { id: 'SELECT_SERVICE_ELECTRICIAN', title: 'Electrician'  },
      ]
    );
    return;
  }

  if (warranty.status === 'CLAIMED') {
    await sendReply(
      customerPhone,
      `You already have an open warranty claim for Job #${jobId.slice(0, 8)}.\n` +
      `A technician will be in touch. Please wait.`
    );
    return;
  }

  if (warranty.status === 'VOIDED') {
    await sendReply(
      customerPhone,
      `The warranty for Job #${jobId.slice(0, 8)} has been voided.\nPlease contact support.`
    );
    return;
  }

  // Warranty is ACTIVE — move customer to WARRANTY_DESCRIBE state
  await upsertConversation(customerPhone, STATES.WARRANTY_DESCRIBE, {
    warranty_id:          warranty.id,
    original_job_id:      warranty.job_id,
    warranty_service_type: warranty.service_type,
    warranty_expires_at:  warranty.expires_at,
  }, rid);

  await sendText(
    customerPhone,
    `🛡️ *Warranty claim — Job #${jobId.slice(0, 8)}*\n\n` +
    `Your *${warranty.service_type}* service is covered until *${warranty.expires_label || formatDate(warranty.expires_at)}*.\n\n` +
    `Please describe the issue briefly.\n` +
    `(e.g. "same pipe is leaking again")`
  );
}

/**
 * CONFIRM_WARRANTY_CLAIM button — customer confirms their claim.
 */
async function commandConfirmWarrantyClaim(customerPhone, warrantyId, issueDescription, rid) {
  log('[warranty]', 'CONFIRM_WARRANTY_CLAIM', { customerPhone: customerPhone.slice(-4), warrantyId, rid });

  if (!issueDescription.trim()) {
    await sendReply(customerPhone, 'Issue description is missing. Please start the claim again.');
    await resetConversation(customerPhone, rid);
    return;
  }

  const result = await createWarrantyClaim(warrantyId, issueDescription);

  // Handle error conditions returned by createWarrantyClaim
  if (result.error) {
    const messages = {
      EXPIRED:            'Your warranty has expired. Would you like to book a new paid service?',
      VOIDED:             'Your warranty has been voided. Please contact support.',
      ALREADY_CLAIMED:    'You already have an open warranty claim. Please wait for a technician.',
      CLAIM_LIMIT_REACHED:'You have reached the claim limit for this warranty. Please contact support.',
    };
    await sendReply(customerPhone, messages[result.error] || 'Could not submit claim. Please try again.');
    await resetConversation(customerPhone, rid);
    return;
  }

  await resetConversation(customerPhone, rid);

  const shortJobId   = result.newJobId   ? result.newJobId.slice(0, 8)   : '?';
  const shortClaimId = result.claimId    ? result.claimId.slice(0, 8)    : '?';

  if (result.technicianFound) {
    await sendText(
      customerPhone,
      `✅ *Warranty claim submitted!*\n\n` +
      `Claim #${shortClaimId} · Job #${shortJobId}\n\n` +
      `We're finding a technician for your *free revisit*.\n` +
      `You will be notified when one accepts.`
    );
  } else {
    await sendText(
      customerPhone,
      `✅ *Warranty claim submitted!*\n\n` +
      `Claim #${shortClaimId} · Job #${shortJobId}\n\n` +
      `We're looking for an available technician and will notify you shortly.`
    );
  }

  log('[warranty]', 'Warranty claim created', {
    customerPhone: customerPhone.slice(-4),
    rid,
    claimId:  result.claimId,
    newJobId: result.newJobId,
  });
}

/**
 * MARK_DONE button — technician marks a warranty job complete.
 * Calls the existing /jobs/:id/mark-done endpoint.
 */
async function commandMarkDone(technicianPhone, jobId, rid) {
  if (!jobId) {
    logError('[command]', 'MARK_DONE — missing job_id', { technicianPhone, rid });
    return;
  }
  log('[command]', 'MARK_DONE', { technicianPhone: technicianPhone.slice(-4), jobId, rid });

  const techPhone = normalizePhoneForBackend(technicianPhone);
  const { data, error } = await safePost(`/jobs/${jobId}/mark-done`, { technician_phone: techPhone }, 'command');

  if (error || !data?.success) {
    logError('[command]', 'MARK_DONE API call failed', { technicianPhone, jobId, rid });
    await sendReply(technicianPhone, 'Could not mark job done. Please try again.');
    return;
  }

  await sendText(
    technicianPhone,
    `✅ *Warranty job #${jobId.slice(0, 8)} completed!*\n\n` +
    `The warranty claim has been resolved.\n` +
    `You are now available for new jobs.`
  );
}

/* ─── Exports ─────────────────────────────────────────────────────────────── */

module.exports = { routeMessage, extractMessage };
