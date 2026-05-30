import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Shared helper ─────────────────────────────────────────────────────────────

/**
 * Cancel a reminder row + all its queued deliveries.
 * Returns the reminder as it was BEFORE cancellation, plus a flag.
 * No-op (idempotent) if the reminder is already cancelled.
 */
async function cancelReminderRow(ctx, reminderId) {
  const reminder = await ctx.db.get(reminderId);
  if (!reminder) throw new Error(`Reminder not found: ${reminderId}`);

  if (reminder.status === "cancelled") {
    return { reminder, alreadyCancelled: true };
  }

  await ctx.db.patch(reminderId, { status: "cancelled" });

  const queued = await ctx.db
    .query("deliveries")
    .withIndex("by_reminder_id", (q) => q.eq("reminderId", reminderId))
    .filter((q) => q.eq(q.field("status"), "queued"))
    .collect();

  await Promise.all(queued.map((d) => ctx.db.patch(d._id, { status: "cancelled" })));

  return { reminder, alreadyCancelled: false };
}

/**
 * Creates a reminder and a single queued delivery row.
 *
 * Returns { reminderId, deliveryId }.
 */
export const createReminder = mutation({
  args: {
    identityId:        v.id("identities"),
    title:             v.string(),
    runAtISO:          v.string(),                        // ISO 8601 string from caller
    timezone:          v.string(),                        // e.g. "Europe/London"
    channelPreference: v.optional(v.string()),            // defaults to "telegram"
    sourceMessageId:   v.optional(v.id("messages")),
  },

  handler: async (ctx, args) => {
    const runAt = new Date(args.runAtISO).getTime();

    if (isNaN(runAt)) {
      throw new Error(`Invalid runAtISO value: "${args.runAtISO}"`);
    }

    const channel = args.channelPreference ?? "telegram";
    const now = Date.now();

    // ── 1. Insert reminder row ────────────────────────────────────────────────
    const reminderId = await ctx.db.insert("reminders", {
      identityId:        args.identityId,
      title:             args.title,
      runAt,
      timezone:          args.timezone,
      channelPreference: channel,
      sourceMessageId:   args.sourceMessageId,
      status:            "queued",
      msSyncStatus:      "none",
      createdAt:         now,
    });

    // ── 2. Insert exactly one delivery row ───────────────────────────────────
    const deliveryId = await ctx.db.insert("deliveries", {
      reminderId,
      channel,
      scheduledFor:  runAt,
      status:        "queued",
      attempts:      0,
      nextAttemptAt: runAt,
      createdAt:     now,
    });

    // ── 3. Conditionally enqueue a calendar sync job ──────────────────────────
    // Behaviour is governed by identity.defaultCalendarProvider:
    //   "microsoft" (or absent/undefined) — enqueue Microsoft Calendar sync job.
    //     The sync cron checks whether the user has a linked MS account and
    //     creates the calendar event if so; if no account is linked the job is
    //     silently marked done.
    //   "none"   — user opted out; skip sync entirely.
    //   "google" — reserved for a future Google Calendar integration; treated
    //              as "none" until that provider is implemented.
    const identity = await ctx.db.get(args.identityId);
    const calProvider = identity?.defaultCalendarProvider;

    if (calProvider === "none") {
      // User opted out of all calendar sync — do not enqueue.
    } else if (calProvider === "google") {
      // Enqueue a Google Calendar sync job.
      // The sync cron will find the linked google oauth_account and create the event.
      await ctx.db.insert("reminder_sync_jobs", {
        reminderId,
        provider:      "google",
        action:        "create",
        status:        "queued",
        attempts:      0,
        nextAttemptAt: now,
        createdAt:     now,
      });
    } else {
      // "microsoft" (explicit) or undefined (default) — enqueue MS Calendar sync.
      await ctx.db.insert("reminder_sync_jobs", {
        reminderId,
        provider:      "microsoft",
        action:        "create",
        status:        "queued",
        attempts:      0,
        nextAttemptAt: now,
        createdAt:     now,
      });
    }

    return { reminderId, deliveryId };
  },
});

/**
 * Cancels a reminder and all its queued delivery rows.
 *
 * Returns the number of delivery rows cancelled.
 */
export const cancelReminder = mutation({
  args: {
    reminderId: v.id("reminders"),
  },

  handler: async (ctx, args) => {
    const { reminder, alreadyCancelled } = await cancelReminderRow(ctx, args.reminderId);
    if (alreadyCancelled) return 0;

    const queuedDeliveries = await ctx.db
      .query("deliveries")
      .withIndex("by_reminder_id", (q) => q.eq("reminderId", args.reminderId))
      .filter((q) => q.eq(q.field("status"), "queued"))
      .collect();

    return queuedDeliveries.length;
  },
});

/**
 * Cancel a reminder by ID from a Telegram command.
 *
 * After marking the reminder cancelled, enqueues a delete sync job for each
 * calendar provider that has a stored event ID on the reminder, regardless of
 * whether this is the first or a repeated cancel call.
 *
 * Dedup guard: if a queued delete job already exists for a given
 * (reminderId, provider), a second job is not inserted. This keeps repeated
 * /cancel calls safe without requiring the caller to track state.
 *
 * Returns { title, alreadyCancelled } for the caller to build a reply.
 */
export const cancelReminderById = mutation({
  args: {
    reminderId: v.id("reminders"),
  },

  handler: async (ctx, args) => {
    const { reminder, alreadyCancelled } = await cancelReminderRow(ctx, args.reminderId);

    // Enqueue calendar delete jobs for every provider that has a stored event ID.
    // We always run this block — even when alreadyCancelled — so that a repeated
    // /cancel can re-trigger a delete job that previously failed permanently.
    // The dedup check prevents duplicate queued jobs on concurrent calls.
    const now = Date.now();

    async function enqueueDeleteIfNeeded(provider) {
      // Check for an existing queued delete job via the by_reminder_id index.
      const existing = await ctx.db
        .query("reminder_sync_jobs")
        .withIndex("by_reminder_id", (q) => q.eq("reminderId", args.reminderId))
        .filter((q) =>
          q.and(
            q.eq(q.field("provider"), provider),
            q.eq(q.field("action"),   "delete"),
            q.eq(q.field("status"),   "queued"),
          )
        )
        .first();

      if (existing) return; // already queued — nothing to do

      await ctx.db.insert("reminder_sync_jobs", {
        reminderId:    args.reminderId,
        provider,
        action:        "delete",
        status:        "queued",
        attempts:      0,
        nextAttemptAt: now,
        createdAt:     now,
      });
    }

    // Trigger on event ID existence — independent of sync status field.
    if (reminder.msEventId)     await enqueueDeleteIfNeeded("microsoft");
    if (reminder.googleEventId) await enqueueDeleteIfNeeded("google");

    return { title: reminder.title, alreadyCancelled };
  },
});

/**
 * Returns combined status for a single reminder: the reminder row itself,
 * the most recent delivery row, and Outlook sync info.
 *
 * Returns null if the reminder does not exist. The caller is responsible for
 * checking reminder.identityId to enforce ownership before surfacing the data.
 */
export const getReminderStatus = query({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, args) => {
    const reminder = await ctx.db.get(args.reminderId);
    if (!reminder) return null;

    // Fetch all delivery rows for this reminder then pick the latest one.
    // Users have at most a handful of deliveries per reminder so collect() is fine.
    const deliveries = await ctx.db
      .query("deliveries")
      .withIndex("by_reminder_id", (q) => q.eq("reminderId", args.reminderId))
      .collect();

    const delivery = deliveries.length > 0
      ? deliveries.sort((a, b) => b._creationTime - a._creationTime)[0]
      : null;

    return {
      reminder: {
        _id:                 reminder._id,
        identityId:          reminder.identityId,   // caller uses this for access control
        title:               reminder.title,
        runAt:               reminder.runAt,
        timezone:            reminder.timezone,
        status:              reminder.status,
        msSyncStatus:        reminder.msSyncStatus,
        msEventId:           reminder.msEventId,
        msFailureReason:     reminder.msFailureReason,
        googleSyncStatus:    reminder.googleSyncStatus,
        googleEventId:       reminder.googleEventId,
        googleFailureReason: reminder.googleFailureReason,
      },
      delivery: delivery ? {
        status:        delivery.status,
        attempts:      delivery.attempts,
        nextAttemptAt: delivery.nextAttemptAt,
        lastAttemptAt: delivery.lastAttemptAt,
        failureReason: delivery.failureReason,
      } : null,
    };
  },
});

/**
 * Returns up to `limit` queued, non-archived reminders for an identity,
 * sorted by runAt ascending (soonest first). Used by the Telegram /list command.
 *
 * Uses the by_identity index for efficient filtering. Archived reminders are
 * excluded defensively even though the cleanup cron only archives terminal-status
 * rows (sent/failed/cancelled) which would never appear in the queued filter.
 */
export const listActiveReminders = query({
  args: {
    identityId: v.id("identities"),
    limit:      v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    const reminders = await ctx.db
      .query("reminders")
      .withIndex("by_identity", (q) => q.eq("identityId", args.identityId))
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "queued"),
          q.eq(q.field("archivedAt"), undefined),  // exclude archived rows
        )
      )
      .collect();

    return reminders
      .sort((a, b) => a.runAt - b.runAt)
      .slice(0, limit);
  },
});
