'use strict';

/**
 * services/retryService.js — Exponential backoff retry utility (v4)
 *
 * Usage:
 *   const result = await retry(async () => {
 *     return await someExternalCall();
 *   }, {
 *     attempts:   5,
 *     baseDelay:  500,
 *     maxDelay:   30_000,
 *     factor:     2,
 *     jitter:     true,
 *     retryIf:    (err) => err.status === 429 || err.status >= 500,
 *   });
 */

/**
 * @typedef {object} RetryOptions
 * @property {number}              [attempts=3]       - Max total attempts (including first)
 * @property {number}              [baseDelay=1000]   - Initial delay in ms
 * @property {number}              [maxDelay=60000]   - Max delay cap in ms
 * @property {number}              [factor=2]         - Backoff multiplier
 * @property {boolean}             [jitter=true]      - Add ±20% random jitter
 * @property {(err:Error)=>boolean} [retryIf]         - Return true to retry this error
 * @property {(attempt:number, err:Error, delay:number)=>void} [onRetry] - Callback each retry
 */

/**
 * Executes `fn` with retries on failure.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions}     [opts]
 * @returns {Promise<T>}
 */
async function retry(fn, opts = {}) {
  const {
    attempts   = 3,
    baseDelay  = 1_000,
    maxDelay   = 60_000,
    factor     = 2,
    jitter     = true,
    retryIf    = null,
    onRetry    = null,
  } = opts;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Check if we should retry this error type
      if (retryIf !== null && !retryIf(err)) {
        throw err; // non-retryable
      }

      // Last attempt — don't sleep, just throw
      if (attempt === attempts) {
        break;
      }

      // Calculate delay: baseDelay * factor^(attempt-1), capped at maxDelay
      let delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
      if (jitter) {
        // ±20% random jitter to spread load
        delay = delay * (0.8 + Math.random() * 0.4);
      }
      delay = Math.floor(delay);

      if (onRetry) {
        onRetry(attempt, err, delay);
      } else {
        console.warn(JSON.stringify({
          ts:      new Date().toISOString(),
          ctx:     '[retry]',
          msg:     `Attempt ${attempt}/${attempts} failed — retrying in ${delay}ms`,
          err:     err.message,
          attempt,
          delay,
        }));
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Same as retry() but swallows the final error and returns null instead of throwing.
 * Useful for fire-and-forget operations where partial failure is acceptable.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions}     [opts]
 * @returns {Promise<T|null>}
 */
async function retryOrNull(fn, opts = {}) {
  try {
    return await retry(fn, opts);
  } catch (err) {
    console.error(JSON.stringify({
      ts:  new Date().toISOString(),
      ctx: '[retry]',
      msg: 'All retry attempts exhausted',
      err: err.message,
    }));
    return null;
  }
}

/**
 * Retries that target specifically HTTP status codes.
 * Passes err.status (or err.response?.status) to retryIf.
 *
 * @template T
 * @param {() => Promise<T>}   fn
 * @param {number[]}           [retryableStatuses=[429,500,502,503,504]]
 * @param {Omit<RetryOptions,'retryIf'>} [opts]
 */
async function retryOnHttp(fn, retryableStatuses = [429, 500, 502, 503, 504], opts = {}) {
  return retry(fn, {
    ...opts,
    retryIf(err) {
      const status = err.status ?? err.response?.status ?? err.statusCode;
      if (typeof status === 'number') {
        return retryableStatuses.includes(status);
      }
      // Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND) are always retryable
      const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNABORTED'];
      return networkCodes.some(c => err.code === c || err.message.includes(c));
    },
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { retry, retryOrNull, retryOnHttp, sleep };
