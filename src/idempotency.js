'use strict';

/**
 * Best-effort in-memory TTL cache for idempotency guards.
 *
 * Designed to prevent duplicate processing when Twilio or Telegram retries
 * a webhook delivery. This is process-local and non-persistent — it resets
 * on server restart, which is acceptable for a best-effort guard.
 *
 * Map entries: key → { value: any, expiresAt: number (ms epoch) }
 */

const cache = new Map();

// Run a sweep every 100 writes to evict expired entries.
const CLEANUP_EVERY = 100;
let writeCount = 0;

function cleanup() {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) {
            cache.delete(key);
        }
    }
}

/**
 * Returns the cached value for key, or undefined if absent / expired.
 */
function get(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

/**
 * Stores value under key for ttlMs milliseconds.
 */
function set(key, value, ttlMs) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    writeCount++;
    if (writeCount >= CLEANUP_EVERY) {
        writeCount = 0;
        cleanup();
    }
}

/**
 * Returns true the first time it is called for a key within the TTL window.
 * Returns false on subsequent calls — i.e. the operation should be skipped
 * because it was already processed.
 *
 * Use to guard side-effectful operations (e.g. sending a bot reply) against
 * webhook retries.
 */
function shouldSend(key, ttlMs) {
    if (get(key) !== undefined) return false;
    set(key, true, ttlMs);
    return true;
}

module.exports = { get, set, shouldSend };
