'use strict';

const express                        = require('express');
const axios                          = require('axios');
const { convex, anyApi, logMessage } = require('../convexClient');
const { openai }                     = require('../openai');
const idempotency                    = require('../idempotency');
const { missingTelegramVars }        = require('../config');
const { checkLimit }                 = require('../rateLimit');

const REPLY_TTL_MS      = 5 * 60 * 1000; // 5 minutes
const TG_RATE_WINDOW_MS = 60_000;         // 1 minute window
const TG_RATE_MAX       = 30;             // max 30 messages per minute per chat

const router = express.Router();

// ── Command handlers ──────────────────────────────────────────────────────────

/**
 * Extracts a reminder from a Telegram message using OpenAI structured output,
 * persists it via Convex, and returns the reply text to send back to the user.
 *
 * providerMsgId (Telegram update_id as a string) is used for persistent
 * idempotency: if Telegram re-delivers the same update, the existing reminder
 * is returned immediately without calling OpenAI or creating a duplicate.
 */
async function handleReminderCommand({ text, address, sourceMessageId, providerMsgId }) {
    if (!convex) {
        return 'Reminders are not enabled yet.';
    }

    // ── 0. Persistent idempotency check ──────────────────────────────────────
    // If this update_id was already processed (e.g. Telegram webhook retry),
    // return the existing reminderId without calling OpenAI or Convex mutations.
    if (providerMsgId) {
        try {
            const existing = await convex.query(
                anyApi.reminderRequests.getByChannelProviderMsgId,
                { channel: 'telegram', providerMsgId }
            );
            if (existing) {
                console.log(`[Telegram] Duplicate update_id ${providerMsgId} — returning existing reminder ${existing.reminderId}`);
                return `\u2705 Reminder already set.\nID: ${existing.reminderId}\n\nTo cancel: /cancel ${existing.reminderId}`;
            }
        } catch (err) {
            // Non-fatal: if the check fails, proceed and let the normal flow handle it
            console.error('[Telegram] reminderRequests lookup failed:', err.message || err);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── 1. Look up the identity row (needed for default settings) ─────────────
    let identity;
    try {
        identity = await convex.query(anyApi.identities.getByChannelAddress, {
            channel: 'telegram',
            address,
        });
    } catch (err) {
        console.error('[Telegram] Identity lookup failed:', err.message || err);
        return 'Sorry, I could not save your reminder. Please try again.';
    }

    if (!identity) {
        return 'Sorry, I could not find your account. Please send another message and try again.';
    }

    // ── 2. Extract reminder fields via OpenAI ─────────────────────────────────
    // The effective default timezone comes from identity settings so that
    // messages without an explicit timezone honour the user's preference.
    // Final fallback (no setting, no explicit mention): Australia/Adelaide.
    const effectiveDefaultTz = identity.defaultTimezone ?? 'Australia/Adelaide';

    let extracted;
    try {
        const today = new Date().toISOString().slice(0, 10);
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content:
                        'Extract a reminder from the user message. Return JSON with exactly these fields:\n' +
                        '- title: string (short description of what to be reminded about)\n' +
                        '- runAtISO: string (ISO 8601 datetime, e.g. "2026-03-08T09:00:00")\n' +
                        `- timezone: string (IANA timezone, default "${effectiveDefaultTz}" if not specified)\n\n` +
                        `Today\'s date is ${today}. If time is not specified, use 09:00. Only return valid JSON.`,
                },
                { role: 'user', content: text },
            ],
            max_tokens: 200,
        });
        extracted = JSON.parse(completion.choices[0].message.content);
    } catch (err) {
        console.error('[Telegram] Reminder extraction failed:', err.message || err);
        return 'Sorry, I could not understand that reminder. Please try again.';
    }

    const { title, runAtISO, timezone = effectiveDefaultTz } = extracted;

    if (!title || !runAtISO || isNaN(new Date(runAtISO).getTime())) {
        return 'Please include a date and time for your reminder. Example: "Remind me to call John on Friday at 9am"';
    }

    // ── 3. Create reminder + delivery row ─────────────────────────────────────
    // channelPreference falls back to identity.defaultChannel, then 'telegram'.
    const channelPreference = identity.defaultChannel ?? 'telegram';

    let reminderId;
    try {
        const result = await convex.mutation(anyApi.reminders.createReminder, {
            identityId: identity._id,
            title,
            runAtISO,
            timezone,
            channelPreference,
            ...(sourceMessageId ? { sourceMessageId } : {}),
        });
        reminderId = result.reminderId;
    } catch (err) {
        console.error('[Telegram] createReminder failed:', err.message || err);
        return 'Sorry, I could not save your reminder. Please try again.';
    }

    // ── 4. Record the (providerMsgId → reminderId) mapping ───────────────────
    // (step number preserved; identity lookup is now step 1, OpenAI step 2)
    // Idempotent: createIfAbsent is a no-op if another concurrent request
    // already inserted a row for this update_id.
    if (providerMsgId) {
        try {
            await convex.mutation(anyApi.reminderRequests.createIfAbsent, {
                channel:       'telegram',
                providerMsgId,
                identityId:    identity._id,
                reminderId,
            });
        } catch (err) {
            // Non-fatal: the reminder was created; logging the failure is sufficient.
            console.error('[Telegram] reminderRequests.createIfAbsent failed:', err.message || err);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return `\u2705 Reminder set: "${title}" at ${runAtISO} (${timezone})\nID: ${reminderId}\n\nTo cancel: /cancel ${reminderId}`;
}

/**
 * Handle a Telegram list command: "/list" or "list".
 * Returns up to 10 active (queued) reminders for the caller, sorted soonest first.
 * Each line shows the scheduled time (UTC), title, and reminder ID for use with /cancel.
 */
async function handleListCommand({ address }) {
    if (!convex) {
        return 'Reminders are not enabled yet.';
    }

    let identity;
    try {
        identity = await convex.query(anyApi.identities.getByChannelAddress, {
            channel: 'telegram',
            address,
        });
    } catch (err) {
        console.error('[Telegram] Identity lookup failed:', err.message || err);
        return 'Sorry, I could not retrieve your reminders. Please try again.';
    }

    if (!identity) {
        return 'No active reminders.';
    }

    let reminders;
    try {
        reminders = await convex.query(anyApi.reminders.listActiveReminders, {
            identityId: identity._id,
        });
    } catch (err) {
        console.error('[Telegram] listActiveReminders failed:', err.message || err);
        return 'Sorry, I could not retrieve your reminders. Please try again.';
    }

    if (reminders.length === 0) {
        return 'No active reminders.';
    }

    const lines = reminders.map((r) => {
        // Format as "YYYY-MM-DD HH:mm UTC" from epoch ms
        const dt = new Date(r.runAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        return `\u2022 ${dt}\n  ${r.title}\n  ID: ${r._id}`;
    });

    return `Your reminders (${reminders.length}):\n\n${lines.join('\n\n')}`;
}

/**
 * Handle a Telegram help command: "/help" or "help".
 * Returns a static list of available commands with short examples.
 * No Convex call required.
 */
function handleHelpCommand() {
    return [
        '\u{1F4CB} Available commands:',
        '',
        '/remind <message>          \u2014 Create a reminder',
        '/list                      \u2014 List your active reminders',
        '/status <id>               \u2014 Check reminder details and delivery status',
        '/cancel <id>               \u2014 Cancel a reminder',
        '/set tz <timezone>         \u2014 Set your default timezone',
        '/set channel <channel>     \u2014 Set default delivery channel',
        '/set calendar <provider>   \u2014 Set default calendar provider',
        '/link <code>               \u2014 Link your Telegram to your dashboard account',
        '',
        'Examples:',
        '  Remind me to call John on Friday at 9am',
        '  /list',
        '  /status k17abc123def456',
        '  /cancel k17abc123def456',
        '  /set tz Europe/London',
        '  /set channel whatsapp',
        '  /set calendar google',
        '  /link AB3XYZ78',
    ].join('\n');
}

/**
 * Handle a Telegram set command: "/set <subcommand> <value>".
 *
 * Subcommands:
 *   tz <IANA timezone>              — Set defaultTimezone
 *   channel telegram|whatsapp       — Set defaultChannel
 *   calendar microsoft|google|none  — Set defaultCalendarProvider
 *
 * Resolves the caller's identity then calls setIdentitySettings with
 * only the changed field, leaving other settings untouched.
 */
async function handleSetCommand({ text, address }) {
    if (!convex) {
        return 'Reminders are not enabled yet.';
    }

    const parts = text.trim().split(/\s+/);
    // parts[0] = "/set" or "set", parts[1] = subcommand, parts[2] = value
    const sub   = (parts[1] || '').toLowerCase();
    const value = parts[2] || '';

    if (!sub || !value) {
        return [
            'Usage:',
            '  /set tz <IANA timezone>         — e.g. /set tz Europe/London',
            '  /set channel telegram|whatsapp',
            '  /set calendar microsoft|google|none',
        ].join('\n');
    }

    // ── Validate input ────────────────────────────────────────────────────────
    let patch = {};

    if (sub === 'tz') {
        if (!value.includes('/') || value.length < 3) {
            return 'Invalid timezone. Please use an IANA timezone, e.g.:\n  /set tz Europe/London\n  /set tz America/New_York\n  /set tz Australia/Adelaide';
        }
        patch = { defaultTimezone: value };
    } else if (sub === 'channel') {
        if (value !== 'telegram' && value !== 'whatsapp') {
            return 'Invalid channel. Use: /set channel telegram\n             or: /set channel whatsapp';
        }
        patch = { defaultChannel: value };
    } else if (sub === 'calendar') {
        if (value !== 'microsoft' && value !== 'google' && value !== 'none') {
            return 'Invalid calendar provider. Use:\n  /set calendar microsoft\n  /set calendar google\n  /set calendar none';
        }
        patch = { defaultCalendarProvider: value };
    } else {
        return `Unknown setting "${sub}". Available: tz, channel, calendar`;
    }

    // ── Resolve identity ──────────────────────────────────────────────────────
    let identity;
    try {
        identity = await convex.query(anyApi.identities.getByChannelAddress, {
            channel: 'telegram',
            address,
        });
    } catch (err) {
        console.error('[Telegram] Identity lookup failed:', err.message || err);
        return 'Sorry, could not update settings. Please try again.';
    }

    if (!identity) {
        return 'Sorry, I could not find your account. Please send another message and try again.';
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    try {
        await convex.mutation(anyApi.identities.setIdentitySettings, {
            identityId: identity._id,
            ...patch,
        });
    } catch (err) {
        console.error('[Telegram] setIdentitySettings failed:', err.message || err);
        return 'Sorry, could not update settings. Please try again.';
    }

    const LABEL = { tz: 'Timezone', channel: 'Channel', calendar: 'Calendar' };
    return `\u2705 ${LABEL[sub]} updated to: ${value}`;
}

/**
 * Handle a Telegram status command: "/status <reminderId>".
 * Looks up reminder + delivery + Outlook sync state and formats a compact reply.
 * Access is enforced: if the reminder belongs to a different identity, replies
 * "Reminder not found." to avoid leaking data across users.
 */
async function handleStatusCommand({ text, address }) {
    if (!convex) {
        return 'Reminders are not enabled yet.';
    }

    const parts = text.trim().split(/\s+/);
    const reminderId = parts[1];

    if (!reminderId) {
        return 'Usage: /status <reminderId>\n\nThe reminder ID is shown when you create a reminder.';
    }

    // Resolve the caller's identity for ownership enforcement.
    let identity;
    try {
        identity = await convex.query(anyApi.identities.getByChannelAddress, {
            channel: 'telegram',
            address,
        });
    } catch (err) {
        console.error('[Telegram] Identity lookup failed:', err.message || err);
        return 'Sorry, could not retrieve status. Please try again.';
    }

    let result;
    try {
        result = await convex.query(anyApi.reminders.getReminderStatus, { reminderId });
    } catch (err) {
        console.error('[Telegram] getReminderStatus failed:', err.message || err);
        return 'Sorry, could not retrieve status. Please try again.';
    }

    // Not found, or reminder belongs to a different identity — same reply to avoid leaking.
    if (!result || !identity || result.reminder.identityId !== identity._id) {
        return 'Reminder not found.';
    }

    const { reminder, delivery } = result;

    const STATUS_EMOJI = { queued: '\u23F3', sent: '\u2705', failed: '\u274C', cancelled: '\u{1F6AB}' };
    const scheduledAt  = new Date(reminder.runAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

    const lines = [
        `${STATUS_EMOJI[reminder.status] ?? '\u2753'} "${reminder.title}"`,
        `Scheduled: ${scheduledAt} (${reminder.timezone})`,
        `Status:    ${reminder.status}`,
    ];

    if (delivery) {
        lines.push(`Delivery:  ${delivery.status} (attempt ${delivery.attempts})`);
        if (delivery.status === 'queued' && delivery.nextAttemptAt) {
            const nextAt = new Date(delivery.nextAttemptAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
            lines.push(`Next try:  ${nextAt}`);
        }
        if (delivery.failureReason) {
            lines.push(`Reason:    ${delivery.failureReason}`);
        }
    }

    if (reminder.msSyncStatus && reminder.msSyncStatus !== 'none') {
        const syncEmoji = reminder.msSyncStatus === 'synced' ? '\u{1F4C5}' : '\u26A0\uFE0F';
        lines.push(`Outlook:   ${syncEmoji} ${reminder.msSyncStatus}`);
        if (reminder.msFailureReason) lines.push(`Sync err:  ${reminder.msFailureReason}`);
    }

    if (reminder.googleSyncStatus && reminder.googleSyncStatus !== 'none') {
        const syncEmoji = reminder.googleSyncStatus === 'synced' ? '\u{1F4C5}' : '\u26A0\uFE0F';
        lines.push(`Google:    ${syncEmoji} ${reminder.googleSyncStatus}`);
        if (reminder.googleFailureReason) lines.push(`Sync err:  ${reminder.googleFailureReason}`);
    }

    return lines.join('\n');
}

/**
 * Handle a Telegram link command: "/link <code>" or "link <code>".
 * Redeems a one-time link code issued from the dashboard, binding this
 * Telegram identity to the corresponding Clerk user account.
 */
async function handleLinkCommand({ text, address }) {
    if (!convex) {
        return 'Account linking is not enabled yet.';
    }

    const parts = text.trim().split(/\s+/);
    const rawCode = parts[1];

    if (!rawCode) {
        return 'Usage: /link <code>\n\nGet your link code from the dashboard.';
    }

    // Resolve caller identity — must exist before we can bind it.
    let identity;
    try {
        identity = await convex.query(anyApi.identities.getByChannelAddress, {
            channel: 'telegram',
            address,
        });
    } catch (err) {
        console.error('[Telegram] Identity lookup failed:', err.message || err);
        return 'Sorry, could not link account. Please try again.';
    }

    if (!identity) {
        return 'Sorry, I could not find your account. Please send another message and try again.';
    }

    let result;
    try {
        result = await convex.mutation(anyApi.linking.redeemLinkCode, {
            code:       rawCode,
            channel:    'telegram',
            identityId: identity._id,
        });
    } catch (err) {
        console.error('[Telegram] redeemLinkCode failed:', err.message || err);
        return 'Sorry, could not link account. Please try again.';
    }

    if (result.ok) {
        return '\u2705 Account linked successfully! Your Telegram is now connected to your dashboard.';
    }

    const REASON_MSG = {
        used:          'That code has already been used. Please generate a new one from the dashboard.',
        expired:       'That code has expired (codes are valid for 15 minutes). Please generate a new one.',
        wrong_channel: 'That code was not issued for Telegram. Please generate a Telegram-specific code.',
        invalid:       'That code is not valid. Please check and try again, or generate a new one.',
    };
    return REASON_MSG[result.reason] ?? 'That code is not valid. Please check and try again.';
}

/**
 * Handle a Telegram cancel command: "/cancel <reminderId>" or "cancel <reminderId>".
 * Marks the reminder and its queued deliveries cancelled, and queues an Outlook
 * event deletion if the reminder had a linked calendar event.
 */
async function handleCancelCommand({ text }) {
    if (!convex) {
        return 'Reminders are not enabled yet.';
    }

    const parts = text.trim().split(/\s+/);
    const reminderId = parts[1];

    if (!reminderId) {
        return 'Usage: /cancel <reminderId>\n\nThe reminder ID is shown when you create a reminder.';
    }

    try {
        const result = await convex.mutation(anyApi.reminders.cancelReminderById, { reminderId });
        if (result.alreadyCancelled) {
            return `Reminder "${result.title}" was already cancelled.`;
        }
        return `\u2705 Reminder "${result.title}" cancelled.`;
    } catch (err) {
        console.error('[Telegram] Cancel failed:', err.message || err);
        return 'Could not cancel that reminder. Please check the ID and try again.';
    }
}

// ── Webhook route ─────────────────────────────────────────────────────────────

router.post('/telegram/webhook', async (req, res) => {
    // Telegram requires an immediate 200 — reply first, process after.
    res.sendStatus(200);

    const update = req.body;

    // Guard: non-message updates (edited_message, callback_query, etc.) have no .message
    if (!update || !update.message) return;

    const msg           = update.message;
    const chatId        = msg.chat.id;
    const text          = msg.text || '';
    const username      = (msg.from && msg.from.username) ? msg.from.username : null;
    const address       = String(chatId);
    const providerMsgId = String(update.update_id);

    console.log(`[Telegram] inbound from ${address}${username ? ' (@' + username + ')' : ''}: ${text}`);

    // ── Rate limit guard ──────────────────────────────────────────────────────
    // Checked after the immediate 200 so Telegram never retries due to a 429.
    // Excess messages are silently dropped — no bot reply is sent.
    const rlResult = checkLimit(`telegram:${address}`, TG_RATE_WINDOW_MS, TG_RATE_MAX);
    if (!rlResult.allowed) {
        console.log(`[Telegram] Rate limit exceeded for chat ${address} — update dropped.`);
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
        // Log inbound message to Convex (no-op if CONVEX_URL is unset)
        const sourceMessageId = await logMessage({
            channel:       'telegram',
            address,
            providerMsgId,
            direction:     'inbound',
            text,
            rawPayload:    JSON.stringify(update),
        });

        // Route: help > link > set > status > list > cancel > remind > generic save
        const t = text.toLowerCase().trim();
        const isHelpCommand     = t === '/help' || t === 'help';
        const isLinkCommand     = t.startsWith('/link ') || t.startsWith('link ');
        const isSetCommand      = t === '/set' || t.startsWith('/set ') || t.startsWith('set ');
        const isStatusCommand   = t.startsWith('/status') || t.startsWith('status ');
        const isListCommand     = t === 'list' || t.startsWith('/list');
        const isCancelCommand   = t.startsWith('/cancel') || t.startsWith('cancel ');
        const isReminderCommand = t.startsWith('remind') || t.startsWith('/remind');

        let replyText;
        if (isHelpCommand) {
            replyText = handleHelpCommand();
        } else if (isLinkCommand) {
            replyText = await handleLinkCommand({ text, address });
        } else if (isSetCommand) {
            replyText = await handleSetCommand({ text, address });
        } else if (isStatusCommand) {
            replyText = await handleStatusCommand({ text, address });
        } else if (isListCommand) {
            replyText = await handleListCommand({ address });
        } else if (isCancelCommand) {
            replyText = await handleCancelCommand({ text });
        } else if (isReminderCommand) {
            replyText = await handleReminderCommand({ text, address, sourceMessageId, providerMsgId });
        } else {
            replyText = 'Saved.';
        }

        // Guard against duplicate sends when Telegram retries the webhook.
        // Key combines update_id (unique per update) with a reply suffix.
        const replyKey = providerMsgId + ':reply';
        const telegramReady = missingTelegramVars().length === 0;
        if (telegramReady && idempotency.shouldSend(replyKey, REPLY_TTL_MS)) {
            await axios.post(
                `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
                { chat_id: chatId, text: replyText }
            );
        } else if (telegramReady) {
            console.log(`[Telegram] Duplicate delivery for update_id ${providerMsgId} — reply suppressed.`);
        }
    } catch (err) {
        console.error('[Telegram] Error processing update:', err.message || err);
    }
});

module.exports = router;
