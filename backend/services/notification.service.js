'use strict';

/**
 * services/notification.service.js — WhatsApp notification helpers (v5) NEW
 *
 * Extracted from server.js.
 *
 * Wraps sendText/sendButtons with error handling and job-specific message
 * templates. Used by controllers and the watchdog.
 *
 * All functions are fire-and-forget — they log errors but never throw.
 */

const { sendText, sendButtons, sendLocation, toWaPhone } = require('./whatsappClient');

function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ctx: '[notify]', msg, ...meta }));
}
function logError(msg, meta = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ctx: '[notify][error]', msg, ...meta }));
}

/* ─── Customer notifications ──────────────────────────────────────────────── */

/**
 * Send a plain text message to a customer.
 * @param {string} phone  — 10-digit Indian number
 * @param {string} message
 */
async function sendCustomerMessage(phone, message) {
  try {
    await sendText(toWaPhone(phone), message);
    log('Customer message sent', { phone: phone.slice(-4) });
  } catch (err) {
    logError('sendCustomerMessage failed', { phone: phone.slice(-4), err: err.message });
  }
}

/* ─── Technician notifications ────────────────────────────────────────────── */

/**
 * Send a plain text message to a technician.
 * @param {string} phone
 * @param {string} message
 */
async function sendTechnicianMessage(phone, message) {
  try {
    await sendText(toWaPhone(phone), message);
    log('Technician message sent', { phone: phone.slice(-4) });
  } catch (err) {
    logError('sendTechnicianMessage failed', { phone: phone.slice(-4), err: err.message });
  }
}

/**
 * Send a new job offer to a technician with interactive Accept/Reject buttons
 * and a location pin.
 *
 * @param {string} phone          — technician phone
 * @param {{ jobId, serviceType, lat, lng, customerName }} job
 */
async function sendTechnicianOffer(phone, job) {
  const { jobId, serviceType, lat, lng, customerName } = job;
  const waPhone = toWaPhone(phone);
  const shortId = jobId ? jobId.slice(0, 8) : 'unknown';

  const bodyText =
    `🔧 *New Job Alert!*\n\n` +
    `Service: *${serviceType}*\n` +
    `Customer: ${customerName || 'Customer'}\n` +
    `Job #${shortId}\n\n` +
    `Location pin follows. Tap Accept to take the job.`;

  try {
    await sendButtons(waPhone, bodyText, [
      { id: `ACCEPT_JOB:${jobId}`, title: 'Accept Job' },
      { id: `REJECT_JOB:${jobId}`, title: 'Reject Job' },
    ]);

    if (typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
      await sendLocation(waPhone, lat, lng, 'Customer Location', 'Tap to navigate');
    }
    log('Technician offer sent', { phone: phone.slice(-4), jobId: shortId });
  } catch (err) {
    logError('sendTechnicianOffer failed', { phone: phone.slice(-4), jobId: shortId, err: err.message });
  }
}

/**
 * Sends a customer cancellation message with a "Book Again" CTA button.
 * Falls back to plain text if interactive messaging fails.
 *
 * @param {string} phone
 * @param {string} jobId    — UUID (used for button payload)
 * @param {string} message  — body text to display
 */
async function sendCustomerRebookMessage(phone, jobId, message) {
  const waPhone = toWaPhone(phone);
  try {
    await sendButtons(waPhone, message, [
      { id: `REBOOK_JOB:${jobId}`, title: 'Book Again' },
    ]);
    log('Customer rebook message sent', { phone: phone.slice(-4), jobId: jobId?.slice(0, 8) });
  } catch (err) {
    // Fallback to plain text
    logError('sendCustomerRebookMessage interactive failed — falling back', { phone: phone.slice(-4), err: err.message });
    await sendCustomerMessage(phone, message);
  }
}

module.exports = {
  sendCustomerMessage,
  sendCustomerRebookMessage,
  sendTechnicianMessage,
  sendTechnicianOffer,
};
