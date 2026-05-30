'use strict';

const dotenv = require('dotenv');
dotenv.config();

// ── Required at startup ───────────────────────────────────────────────────────
//
// These three vars are needed for the core WhatsApp + OpenAI flow.
// All other vars are optional and validated lazily when the feature is used.
//
const REQUIRED_VARS = ['OPENAI_API_KEY', 'OPENAI_ORGANIZATION', 'SUBSCRIPTION_API_URL'];
const missingVars = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
    console.error('\n[STARTUP ERROR] Missing required environment variables:');
    missingVars.forEach((v) => console.error(`  - ${v}`));
    console.error('\nCopy .env.example to .env and fill in the values before starting.\n');
    process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Optional feature groups (validated lazily at request time) ────────────────
//
// Convex (message logging, reminders, delivery scheduling):
//   CONVEX_URL
//   → validated in src/convexClient.js; routes degrade gracefully when absent.
//
// Telegram bot (inbound webhook + outbound replies):
//   TELEGRAM_BOT_TOKEN
//   → validated in src/routes/telegram.js before each sendMessage call.
//
// WhatsApp delivery via Twilio (Convex cron only — not the Node server):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
//   → set inside Convex, not needed by this Node process at all.
//
// Microsoft Outlook OAuth + Calendar sync:
//   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT, MS_REDIRECT_URI
//   → validated in src/routes/outlook.js at request time.
//
// Google OAuth + Calendar sync (future):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
//   → validated in src/routes/google.js at request time.
// ─────────────────────────────────────────────────────────────────────────────

// ── Lazy feature validators ───────────────────────────────────────────────────
//
// Call these at request time (not module load time) so missing optional vars
// never prevent the server from starting.
//
// Each function returns an array of missing variable names.
// An empty array means the feature is fully configured.
//

/** Variables needed to send Telegram bot replies. */
function missingTelegramVars() {
    return ['TELEGRAM_BOT_TOKEN'].filter((v) => !process.env[v]);
}

/** Variables needed for Microsoft OAuth and Calendar sync. */
function missingMicrosoftVars() {
    return ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_REDIRECT_URI'].filter((v) => !process.env[v]);
}

/** Variables needed for Google OAuth and Calendar sync. */
function missingGoogleVars() {
    return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'].filter((v) => !process.env[v]);
}

/** Variables needed for Convex-backed features (logging, reminders). */
function missingConvexVars() {
    return ['CONVEX_URL'].filter((v) => !process.env[v]);
}

// ── Exported config ───────────────────────────────────────────────────────────

module.exports = {
    // Core — always present (guaranteed by preflight above)
    PORT:                 process.env.PORT || 3000,
    OPENAI_API_KEY:       process.env.OPENAI_API_KEY,
    OPENAI_ORGANIZATION:  process.env.OPENAI_ORGANIZATION,
    SUBSCRIPTION_API_URL: process.env.SUBSCRIPTION_API_URL,

    // Optional — may be undefined; use lazy validators before relying on these
    CONVEX_URL:           process.env.CONVEX_URL,
    TELEGRAM_BOT_TOKEN:   process.env.TELEGRAM_BOT_TOKEN,
    MS_CLIENT_ID:         process.env.MS_CLIENT_ID,
    MS_CLIENT_SECRET:     process.env.MS_CLIENT_SECRET,
    MS_TENANT:            process.env.MS_TENANT || 'common',
    MS_REDIRECT_URI:      process.env.MS_REDIRECT_URI,

    // Optional Google OAuth vars — may be undefined
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI:  process.env.GOOGLE_REDIRECT_URI,

    // Lazy validators
    missingTelegramVars,
    missingMicrosoftVars,
    missingGoogleVars,
    missingConvexVars,
};
