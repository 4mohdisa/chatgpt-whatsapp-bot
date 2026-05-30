'use strict';

const express            = require('express');
const { convex, anyApi } = require('../convexClient');

const router = express.Router();

// ── Token auth middleware ──────────────────────────────────────────────────────

/**
 * Require the x-admin-token header to match ADMIN_TOKEN.
 * Returns 401 when the token is missing or wrong.
 * Returns 503 when ADMIN_TOKEN is not configured in the environment.
 */
function requireAdminToken(req, res, next) {
    const configured = process.env.ADMIN_TOKEN;
    if (!configured) {
        return res.status(503).json({
            error: 'Admin endpoints are not configured. Set ADMIN_TOKEN in your environment.',
        });
    }

    const provided = req.headers['x-admin-token'];
    if (!provided || provided !== configured) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ── GET /admin/health ─────────────────────────────────────────────────────────

/**
 * Diagnostics endpoint.
 *
 * Request:
 *   GET /admin/health
 *   x-admin-token: <ADMIN_TOKEN>
 *
 * Response (200):
 * {
 *   serverTime:              ISO 8601 string,
 *   version:                 string (from package.json),
 *   convex:                  "connected" | "not configured",
 *   deliveryCounts:          { queued, sent, failed, cancelled },
 *   syncJobCounts:           { queued, done, failed },
 *   recentDeliveryFailures:  [ { id, channel, attempts, failureReason, lastAttemptAt, scheduledFor } ],
 *   recentSyncFailures:      [ { id, provider, action, attempts, failureReason, lastAttemptAt } ]
 * }
 */
router.get('/admin/health', requireAdminToken, async (req, res) => {
    const version = require('../../package.json').version;

    if (!convex) {
        return res.status(503).json({
            serverTime: new Date().toISOString(),
            version,
            convex:     'not configured',
            error:      'CONVEX_URL is not set. Convex-backed stats are unavailable.',
        });
    }

    try {
        const stats = await convex.query(anyApi.admin.getHealthStats, {});

        return res.json({
            serverTime:             new Date().toISOString(),
            version,
            convex:                 'connected',
            deliveryCounts:         stats.deliveryCounts,
            syncJobCounts:          stats.syncJobCounts,
            recentDeliveryFailures: stats.recentDeliveryFailures,
            recentSyncFailures:     stats.recentSyncFailures,
        });
    } catch (err) {
        console.error('[Admin] Health query failed:', err.message || err);
        return res.status(502).json({
            serverTime: new Date().toISOString(),
            version,
            convex:     'error',
            error:      `Convex query failed: ${String(err.message ?? err).slice(0, 200)}`,
        });
    }
});

module.exports = router;
