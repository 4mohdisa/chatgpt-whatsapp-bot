'use strict';

// Optional — only initialised when CONVEX_URL is present in the environment.
// Requires src/config.js to have been loaded first so dotenv has run.
let convex = null;
let anyApi = null;

if (process.env.CONVEX_URL) {
    const { ConvexHttpClient } = require('convex/browser');
    const convexServer = require('convex/server');
    anyApi = convexServer.anyApi;
    convex = new ConvexHttpClient(process.env.CONVEX_URL);
} else {
    console.log('[Convex] CONVEX_URL not set — message logging disabled.');
}

/**
 * Log a single inbound or outbound message to Convex.
 * No-op (returns null) when Convex is not configured.
 */
async function logMessage(params) {
    if (!convex) return null;
    try {
        return await convex.mutation(anyApi.messages.upsertIdentityAndLogMessage, params);
    } catch (err) {
        console.error('[Convex] Failed to log message:', err.message || err);
        return null;
    }
}

module.exports = { convex, anyApi, logMessage };
