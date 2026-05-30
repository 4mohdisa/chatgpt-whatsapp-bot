'use strict';

/**
 * src/rateLimit.js
 *
 * Lightweight in-memory rate limiter with no external dependencies.
 *
 * State is process-local and resets on server restart.
 * Suitable for single-process deployments; for multi-process environments a
 * shared store (e.g. Redis) would be required.
 *
 * Usage — middleware style (WhatsApp):
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 20, keyFn });
 *   router.post('/sms', limiter, handler);
 *
 * Usage — inline check (Telegram, which must respond 200 first):
 *   const rl = checkLimit(key, windowMs, max);
 *   if (!rl.allowed) return; // drop silently after the early 200
 */

// ── Internal store ─────────────────────────────────────────────────────────────
//
// Map<key, { count: number, resetAt: number }>
// Entries are evicted lazily on read and via periodic sweep.
//
const _store = new Map();

let _hitsSinceLastSweep = 0;
const SWEEP_EVERY_N_HITS = 200;

function _sweep() {
    const now = Date.now();
    for (const [key, rec] of _store) {
        if (rec.resetAt <= now) _store.delete(key);
    }
}

// ── Core hit function ──────────────────────────────────────────────────────────

/**
 * Record one hit for `key` within a `windowMs` rolling window.
 *
 * Returns:
 *   allowed   — true if this hit is within the limit
 *   remaining — how many more hits are allowed before the limit is reached
 *   resetAt   — epoch ms when the current window expires
 */
function checkLimit(key, windowMs, max) {
    const now = Date.now();
    let rec = _store.get(key);

    if (!rec || rec.resetAt <= now) {
        // New window (first hit or expired)
        rec = { count: 1, resetAt: now + windowMs };
        _store.set(key, rec);
    } else {
        rec.count++;
    }

    // Periodic cleanup — prevents unbounded Map growth under sustained load
    if (++_hitsSinceLastSweep >= SWEEP_EVERY_N_HITS) {
        _hitsSinceLastSweep = 0;
        _sweep();
    }

    return {
        allowed:   rec.count <= max,
        remaining: Math.max(0, max - rec.count),
        resetAt:   rec.resetAt,
    };
}

// ── Express middleware factory ─────────────────────────────────────────────────

/**
 * Returns an Express middleware that enforces a rate limit.
 *
 * Options:
 *   windowMs — window duration in ms (default: 60 000)
 *   max      — max allowed hits per window per key (default: 60)
 *   keyFn    — fn(req) → string; defaults to req.ip (requires trust proxy if
 *              behind a load balancer — see TRUST_PROXY env var)
 *   message  — string body sent with the 429 response
 */
function createRateLimiter({ windowMs = 60_000, max = 60, keyFn, message } = {}) {
    const resolveKey = keyFn || ((req) => req.ip || 'unknown');
    const msg        = message || 'Too many requests. Please slow down.';

    return function rateLimitMiddleware(req, res, next) {
        const key    = resolveKey(req);
        const result = checkLimit(key, windowMs, max);

        res.setHeader('X-RateLimit-Limit',     max);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Reset',     Math.ceil(result.resetAt / 1000));

        if (!result.allowed) {
            res.setHeader('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
            return res.status(429).send(msg);
        }

        next();
    };
}

module.exports = { checkLimit, createRateLimiter };
