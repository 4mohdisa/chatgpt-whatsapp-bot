import { query } from "./_generated/server";

/**
 * getHealthStats — called by GET /admin/health on the Node server.
 *
 * Returns:
 *   - deliveryCounts: counts of delivery rows grouped by status
 *   - syncJobCounts:  counts of reminder_sync_job rows grouped by status
 *   - recentDeliveryFailures: up to 20 most recently failed deliveries
 *   - recentSyncFailures:     up to 20 most recently failed sync jobs
 *
 * Queries run against the by_status_nextAttemptAt index for efficient
 * status-prefix scans. Collecting all rows of each status is acceptable
 * for a low-frequency admin diagnostic endpoint.
 */
export const getHealthStats = query({
  args: {},
  handler: async (ctx) => {
    // ── Delivery counts by status ─────────────────────────────────────────────
    const [dQueued, dSent, dFailed, dCancelled] = await Promise.all([
      ctx.db
        .query("deliveries")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "queued"))
        .collect(),
      ctx.db
        .query("deliveries")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "sent"))
        .collect(),
      ctx.db
        .query("deliveries")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "failed"))
        .collect(),
      ctx.db
        .query("deliveries")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "cancelled"))
        .collect(),
    ]);

    // ── Sync job counts by status ─────────────────────────────────────────────
    const [sQueued, sDone, sFailed] = await Promise.all([
      ctx.db
        .query("reminder_sync_jobs")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "queued"))
        .collect(),
      ctx.db
        .query("reminder_sync_jobs")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "done"))
        .collect(),
      ctx.db
        .query("reminder_sync_jobs")
        .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "failed"))
        .collect(),
    ]);

    // ── Recent failures (most recent 20, sorted by last attempt time) ─────────
    const recentDeliveryFailures = dFailed
      .sort((a, b) =>
        (b.lastAttemptAt ?? b._creationTime) - (a.lastAttemptAt ?? a._creationTime)
      )
      .slice(0, 20)
      .map((d) => ({
        id:            d._id,
        channel:       d.channel,
        attempts:      d.attempts,
        failureReason: d.failureReason ?? null,
        lastAttemptAt: d.lastAttemptAt ?? null,
        scheduledFor:  d.scheduledFor,
      }));

    const recentSyncFailures = sFailed
      .sort((a, b) =>
        (b.lastAttemptAt ?? b._creationTime) - (a.lastAttemptAt ?? a._creationTime)
      )
      .slice(0, 20)
      .map((j) => ({
        id:            j._id,
        provider:      j.provider,
        action:        j.action,
        attempts:      j.attempts,
        failureReason: j.failureReason ?? null,
        lastAttemptAt: j.lastAttemptAt ?? null,
      }));

    return {
      deliveryCounts: {
        queued:    dQueued.length,
        sent:      dSent.length,
        failed:    dFailed.length,
        cancelled: dCancelled.length,
      },
      syncJobCounts: {
        queued: sQueued.length,
        done:   sDone.length,
        failed: sFailed.length,
      },
      recentDeliveryFailures,
      recentSyncFailures,
    };
  },
});
