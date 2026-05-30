import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /**
   * One row per unique human/account.
   * Intentionally thin — all contact info lives on identities.
   */
  users: defineTable({
    createdAt: v.number(),
  }),

  /**
   * One row per (channel, address) pair, linked to a user.
   * e.g. channel="whatsapp", address="+447700900123"
   *
   * Optional settings (absent = use coded defaults):
   *   defaultTimezone         — IANA tz used when user omits timezone in a reminder
   *   defaultChannel          — preferred delivery channel for outbound reminders
   *   defaultCalendarProvider — which calendar backend to sync new reminders to;
   *                             "none" skips sync entirely; "google" is reserved
   *                             (no-op until Google Calendar is implemented)
   */
  identities: defineTable({
    userId:   v.id("users"),
    channel:  v.string(),
    address:  v.string(),
    createdAt: v.number(),
    // User-configurable settings — all optional; absence means "use coded default"
    defaultTimezone: v.optional(v.string()),   // IANA timezone, e.g. "Europe/London"
    defaultChannel:  v.optional(v.union(
      v.literal("telegram"),
      v.literal("whatsapp"),
    )),
    defaultCalendarProvider: v.optional(v.union(
      v.literal("microsoft"),
      v.literal("google"),
      v.literal("none"),
    )),
    // Set when the identity is linked to a Clerk user via /link flow
    clerkUserId: v.optional(v.string()),
  }).index("by_channel_address", ["channel", "address"]),

  /**
   * One row per inbound or outbound message.
   * providerMsgId (e.g. Twilio SID) is used as the uniqueness key.
   */
  messages: defineTable({
    identityId: v.id("identities"),
    channel: v.string(),
    providerMsgId: v.string(),
    direction: v.string(),   // "inbound" | "outbound"
    text: v.string(),
    rawPayload: v.string(),  // JSON-stringified provider payload
    createdAt: v.number(),
  })
    .index("by_provider_msg_id", ["providerMsgId"])
    .index("by_identity", ["identityId"]),

  /**
   * One row per reminder intent captured from a user message.
   * status lifecycle: queued → sent | failed | cancelled
   */
  reminders: defineTable({
    identityId:        v.id("identities"),
    title:             v.string(),
    runAt:             v.number(),              // ms since epoch — when to fire
    timezone:          v.string(),              // IANA timezone, e.g. "Europe/London"
    channelPreference: v.string(),              // "telegram" | "whatsapp"
    sourceMessageId:   v.optional(v.id("messages")), // message that triggered this
    status:            v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // Microsoft Calendar sync fields (populated by sync cron)
    msAccountId:     v.optional(v.id("oauth_accounts")),
    msEventId:       v.optional(v.string()),    // Graph event id
    msCalendarId:    v.optional(v.string()),    // Graph calendar id (future use)
    msSyncStatus:    v.optional(v.union(
      v.literal("none"),
      v.literal("synced"),
      v.literal("failed"),
    )),
    msFailureReason: v.optional(v.string()),
    // Google Calendar sync fields (populated by sync cron)
    googleAccountId:     v.optional(v.id("oauth_accounts")),
    googleEventId:       v.optional(v.string()),   // Google Calendar event id
    googleCalendarId:    v.optional(v.string()),   // defaults to "primary"
    googleSyncStatus:    v.optional(v.union(
      v.literal("none"),
      v.literal("synced"),
      v.literal("failed"),
    )),
    googleFailureReason: v.optional(v.string()),
    createdAt:  v.number(),
    archivedAt: v.optional(v.number()),  // set by cleanup cron; row is never deleted
  })
    .index("by_identity", ["identityId"])
    .index("by_status_run_at", ["status", "runAt"]),

  /**
   * One row per (channel, providerMsgId) that successfully created a reminder.
   * Used to make reminder creation idempotent across Telegram webhook retries:
   * if the same update_id arrives again, we return the existing reminderId
   * without calling OpenAI or creating a duplicate reminder.
   * status lifecycle: (single insert, never updated)
   */
  reminder_requests: defineTable({
    channel:       v.string(),           // "telegram" | "whatsapp"
    providerMsgId: v.string(),           // Telegram update_id or Twilio MessageSid
    identityId:    v.id("identities"),
    reminderId:    v.id("reminders"),
    createdAt:     v.number(),
  }).index("by_channel_providerMsgId", ["channel", "providerMsgId"]),

  /**
   * One row per reminder × provider sync attempt.
   * Created by createReminder; processed by the sync cron.
   * status lifecycle: queued → done | failed
   */
  reminder_sync_jobs: defineTable({
    reminderId: v.id("reminders"),
    provider:   v.string(),   // "microsoft"
    action:     v.union(
      v.literal("create"),   // create calendar event
      v.literal("delete"),   // delete calendar event
    ),
    status:     v.union(
      v.literal("queued"),
      v.literal("done"),
      v.literal("failed"),
    ),
    // Retry / backoff fields
    attempts:      v.number(),               // attempts made so far (starts at 0)
    nextAttemptAt: v.number(),               // ms epoch — when to next try
    lastAttemptAt: v.optional(v.number()),   // ms epoch — time of most recent attempt
    // Optimistic lock fields (cleared on terminal state or requeue)
    lockedAt:      v.optional(v.number()),   // ms epoch — when this worker acquired the lock
    lockId:        v.optional(v.string()),   // unique ID of the lock holder
    failureReason: v.optional(v.string()),   // reason for most recent failure
    createdAt:     v.number(),
  })
    .index("by_status_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_reminder_id",          ["reminderId"]),

  /**
   * One delivery attempt per reminder per channel.
   * Scheduled delivery rows are queried by the future scheduler.
   * status lifecycle: queued → sent | failed | cancelled
   */
  deliveries: defineTable({
    reminderId:   v.id("reminders"),
    channel:      v.string(),              // "telegram" | "whatsapp"
    scheduledFor: v.number(),              // ms since epoch — original scheduled time
    status:       v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // Retry / backoff fields
    attempts:      v.number(),               // attempts made so far (starts at 0)
    nextAttemptAt: v.number(),               // ms epoch — when to next try
    lastAttemptAt: v.optional(v.number()),   // ms epoch — time of most recent attempt
    // Optimistic lock fields (cleared on terminal state or requeue)
    lockedAt:      v.optional(v.number()),   // ms epoch — when this worker acquired the lock
    lockId:        v.optional(v.string()),   // unique ID of the lock holder
    sentAt:        v.optional(v.number()),
    failureReason: v.optional(v.string()),
    createdAt:     v.number(),
    archivedAt:    v.optional(v.number()),  // set by cleanup cron; row is never deleted
  })
    .index("by_reminder_id", ["reminderId"])
    .index("by_status_nextAttemptAt", ["status", "nextAttemptAt"]),

  /**
   * One row per Microsoft (or future OAuth) account linked to a user identity.
   * provider is always "microsoft" for now.
   */
  oauth_accounts: defineTable({
    identityId:        v.id("identities"),
    provider:          v.string(),           // "microsoft"
    tenantId:          v.optional(v.string()),
    userPrincipalName: v.string(),
    msUserId:          v.string(),           // Microsoft user object ID (GUID)
    createdAt:         v.number(),
  }).index("by_identity_provider", ["identityId", "provider"]),

  /**
   * One row per oauth_account — stores the latest access + refresh tokens.
   * Patched in-place on every token refresh (never creates additional rows).
   */
  oauth_tokens: defineTable({
    accountId:    v.id("oauth_accounts"),
    accessToken:  v.string(),
    refreshToken: v.string(),
    expiresAt:    v.number(),   // ms since epoch
    scopes:       v.string(),   // space-separated scope string as returned by Microsoft
    createdAt:    v.number(),
  }).index("by_account_id", ["accountId"]),

  /**
   * One row per Clerk user — thin record linking Clerk's userId to this app.
   * Created on first sign-in or when a link code is issued.
   */
  app_users: defineTable({
    clerkUserId: v.string(),
    createdAt:   v.number(),
  }).index("by_clerk_user_id", ["clerkUserId"]),

  /**
   * One-time codes that bind a Clerk user to a chat identity.
   * Flow: dashboard issues code → user sends "/link <code>" in Telegram/WhatsApp
   *       → code is redeemed and identity.clerkUserId is populated.
   * status lifecycle: issued → used | expired
   */
  link_codes: defineTable({
    code:        v.string(),                          // 8-char uppercase alphanumeric
    clerkUserId: v.string(),                          // Clerk userId of the issuer
    identityId:  v.optional(v.id("identities")),     // set on redemption
    channel:     v.optional(v.union(                 // if set, only this channel can redeem
      v.literal("telegram"),
      v.literal("whatsapp"),
    )),
    status: v.union(
      v.literal("issued"),
      v.literal("used"),
      v.literal("expired"),
    ),
    expiresAt: v.number(),   // ms epoch — 15 minutes after issuance
    createdAt: v.number(),
  })
    .index("by_code",         ["code"])
    .index("by_clerk_status", ["clerkUserId", "status"]),
});
