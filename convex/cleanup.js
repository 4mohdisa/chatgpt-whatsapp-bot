import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of reminder rows archived in a single cron run.
 * Distributed evenly across the three terminal statuses (sent/failed/cancelled).
 * Increase if daily volume exceeds this; decrease if runs are hitting timeouts.
 */
const BATCH_SIZE  = 200;

/**
 * How old a terminal reminder must be (in ms) before it is eligible for archival.
 * Default: 30 days. Adjust via environment variable or by editing this constant.
 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

/** Number of rows fetched per terminal status. */
const PER_STATUS = Math.ceil(BATCH_SIZE / 3);     // ≤ 67 per status

// ── Internal mutation ─────────────────────────────────────────────────────────

/**
 * Archives one batch of eligible reminders and their associated delivery rows.
 *
 * Eligibility: status is "sent", "failed", or "cancelled" AND runAt is older
 * than RETENTION_MS AND the row has not already been archived.
 *
 * Archival is a soft operation: rows are patched with `archivedAt` — they are
 * never deleted. All writes execute inside a single Convex transaction so the
 * operation is all-or-nothing.
 *
 * Returns the count of reminder rows archived in this batch.
 */
export const archiveBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now    = Date.now();
    const cutoff = now - RETENTION_MS;

    // ── Query terminal-status reminders older than the cutoff ─────────────────
    // The existing by_status_run_at compound index makes each query efficient.
    // We filter archivedAt === undefined to skip rows already processed by a
    // previous run (safe because the index scan may return previously-archived
    // rows if .take() was applied before the filter in an earlier implementation).

    const sentBatch = await ctx.db
      .query("reminders")
      .withIndex("by_status_run_at", (q) =>
        q.eq("status", "sent").lt("runAt", cutoff)
      )
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .take(PER_STATUS);

    const cancelledBatch = await ctx.db
      .query("reminders")
      .withIndex("by_status_run_at", (q) =>
        q.eq("status", "cancelled").lt("runAt", cutoff)
      )
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .take(PER_STATUS);

    const failedBatch = await ctx.db
      .query("reminders")
      .withIndex("by_status_run_at", (q) =>
        q.eq("status", "failed").lt("runAt", cutoff)
      )
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .take(PER_STATUS);

    const eligible = [...sentBatch, ...cancelledBatch, ...failedBatch];
    if (eligible.length === 0) return 0;

    // ── Archive each reminder row and its associated delivery rows ────────────
    for (const reminder of eligible) {
      await ctx.db.patch(reminder._id, { archivedAt: now });

      // Cascade: archive all delivery rows for this reminder.
      // by_reminder_id index makes this lookup fast.
      const deliveries = await ctx.db
        .query("deliveries")
        .withIndex("by_reminder_id", (q) => q.eq("reminderId", reminder._id))
        .collect();

      for (const delivery of deliveries) {
        if (delivery.archivedAt === undefined) {
          await ctx.db.patch(delivery._id, { archivedAt: now });
        }
      }
    }

    return eligible.length;
  },
});

// ── Internal action (cron entry point) ───────────────────────────────────────

/**
 * Scheduled daily by convex/crons.js.
 *
 * Archives reminders whose status is "sent", "failed", or "cancelled" and
 * whose runAt is older than 30 days. Delivery rows belonging to each archived
 * reminder are also archived. Rows are never deleted — archivedAt is set so
 * data remains recoverable via the Convex dashboard or direct queries.
 *
 * A single run archives at most BATCH_SIZE (200) reminders. If more rows are
 * eligible, subsequent daily runs will process the remainder.
 */
export const archiveOldData = internalAction({
  args: {},
  handler: async (ctx) => {
    const archived = await ctx.runMutation(internal.cleanup.archiveBatch, {});
    console.log(`[Cleanup] Archived ${archived} reminder(s) and their deliveries.`);
  },
});
