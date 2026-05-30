import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const BATCH_SIZE      = 25;
const MAX_ATTEMPTS    = 6;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — stale lock expiry

// Capped exponential backoff schedule (milliseconds):
//   attempt 1 → 30 s, attempt 2 → 2 m, attempt 3 → 10 m,
//   attempt 4 → 30 m, attempt 5+ → 2 h
const BACKOFF_MS = [
  30_000,           //  30 s
  2  * 60_000,      //   2 m
  10 * 60_000,      //  10 m
  30 * 60_000,      //  30 m
  2  * 60 * 60_000, //   2 h
];

/**
 * Returns the ms to wait before the next retry.
 * `completedAttempts` is the total number of attempts made so far.
 */
function backoffMs(completedAttempts) {
  return BACKOFF_MS[Math.min(completedAttempts - 1, BACKOFF_MS.length - 1)];
}

/**
 * True for HTTP status codes that represent transient failures worth retrying:
 * 408 Request Timeout, 429 Too Many Requests, 5xx Server Errors.
 */
function isTransientHttp(status) {
  return status === 408 || status === 429 || status >= 500;
}

// ── Internal queries ──────────────────────────────────────────────────────────

/**
 * Internal query: returns up to BATCH_SIZE due queued deliveries that are not
 * currently locked, each enriched with its linked reminder and identity rows.
 *
 * A delivery is considered locked if its lockedAt is within the last
 * LOCK_TIMEOUT_MS. Expired locks (crashed workers) are treated as unlocked.
 */
export const getDueDeliveries = internalQuery({
  args: {},
  handler: async (ctx, _args) => {
    const now = Date.now();

    const candidates = await ctx.db
      .query("deliveries")
      .withIndex("by_status_nextAttemptAt", (q) =>
        q.eq("status", "queued").lte("nextAttemptAt", now)
      )
      .take(BATCH_SIZE);

    // Filter out rows whose lock is still active
    const unlocked = candidates.filter(
      (d) => !d.lockedAt || (now - d.lockedAt) >= LOCK_TIMEOUT_MS
    );

    const enriched = [];
    for (const delivery of unlocked) {
      const reminder = await ctx.db.get(delivery.reminderId);
      if (!reminder) continue;
      const identity = await ctx.db.get(reminder.identityId);
      if (!identity) continue;
      enriched.push({ delivery, reminder, identity });
    }
    return enriched;
  },
});

// ── Internal mutations ────────────────────────────────────────────────────────

/**
 * Atomically acquire a lock on a delivery.
 *
 * Returns true if the lock was acquired, false if:
 * - the delivery no longer exists or is not queued, or
 * - a live lock is already held by another worker.
 *
 * An expired lock (lockedAt older than LOCK_TIMEOUT_MS) is overwritten.
 */
export const acquireDeliveryLock = internalMutation({
  args: {
    deliveryId: v.id("deliveries"),
    lockId:     v.string(),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.status !== "queued") return false;

    const now = Date.now();
    if (delivery.lockedAt && (now - delivery.lockedAt) < LOCK_TIMEOUT_MS) {
      return false; // live lock held by another worker
    }

    await ctx.db.patch(args.deliveryId, { lockedAt: now, lockId: args.lockId });
    return true;
  },
});

/**
 * Re-queue a delivery for retry after a transient failure.
 *
 * Verifies lockId ownership to prevent stale lock releases.
 * Sets nextAttemptAt based on the capped backoff schedule.
 * Clears the lock so the next cron run can pick it up.
 */
export const requeueDelivery = internalMutation({
  args: {
    deliveryId:    v.id("deliveries"),
    lockId:        v.string(),
    newAttempts:   v.number(),
    nextAttemptAt: v.number(),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    // Stale call — ignore
    if (!delivery || delivery.lockId !== args.lockId) return;

    const patch = {
      attempts:      args.newAttempts,
      lastAttemptAt: Date.now(),
      nextAttemptAt: args.nextAttemptAt,
      lockedAt:      undefined,
      lockId:        undefined,
    };
    if (args.failureReason !== undefined) patch.failureReason = args.failureReason;
    await ctx.db.patch(args.deliveryId, patch);
  },
});

/**
 * Internal mutation: atomically update a delivery to a terminal state.
 *
 * Idempotency guard: if the delivery is no longer "queued" the mutation is a
 * no-op (another cron run already claimed it).
 *
 * On success (status="sent") the linked reminder is also marked sent,
 * provided it is still in the "queued" state.
 *
 * Always clears lock fields regardless of terminal status.
 */
export const markDelivery = internalMutation({
  args: {
    deliveryId:    v.id("deliveries"),
    status:        v.union(v.literal("sent"), v.literal("failed")),
    sentAt:        v.optional(v.number()),
    failureReason: v.optional(v.string()),
    lastAttemptAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.status !== "queued") return; // idempotent

    const patch = {
      status:   args.status,
      lockedAt: undefined,
      lockId:   undefined,
    };
    if (args.sentAt        !== undefined) patch.sentAt        = args.sentAt;
    if (args.failureReason !== undefined) patch.failureReason = args.failureReason;
    if (args.lastAttemptAt !== undefined) patch.lastAttemptAt = args.lastAttemptAt;
    await ctx.db.patch(args.deliveryId, patch);

    if (args.status === "sent") {
      const reminder = await ctx.db.get(delivery.reminderId);
      if (reminder && reminder.status === "queued") {
        await ctx.db.patch(delivery.reminderId, { status: "sent" });
      }
    }
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Handle a transient HTTP or network error for a delivery.
 * Re-queues with backoff if under MAX_ATTEMPTS; otherwise marks permanently failed.
 */
async function handleTransientFailure(ctx, delivery, lockId, reason) {
  const currentAttempts = delivery.attempts + 1;
  if (currentAttempts < MAX_ATTEMPTS) {
    await ctx.runMutation(internal.deliveries.requeueDelivery, {
      deliveryId:    delivery._id,
      lockId,
      newAttempts:   currentAttempts,
      nextAttemptAt: Date.now() + backoffMs(currentAttempts),
      failureReason: reason,
    });
  } else {
    await ctx.runMutation(internal.deliveries.markDelivery, {
      deliveryId:    delivery._id,
      status:        "failed",
      failureReason: `Max attempts reached. Last error: ${reason}`,
      lastAttemptAt: Date.now(),
    });
  }
}

/**
 * Mark a delivery as permanently failed (config errors, permanent HTTP 4xx).
 */
async function handlePermanentFailure(ctx, delivery, reason) {
  await ctx.runMutation(internal.deliveries.markDelivery, {
    deliveryId:    delivery._id,
    status:        "failed",
    failureReason: reason,
    lastAttemptAt: Date.now(),
  });
}

// ── Main cron action ──────────────────────────────────────────────────────────

/**
 * processQueue — cron target (runs every 1 minute via convex/crons.js).
 *
 * For each due queued delivery:
 *   1. Acquire an optimistic lock — skip if another worker holds it.
 *   2. Attempt delivery to the appropriate channel.
 *   3a. Success: mark sent.
 *   3b. Transient error (network, 408, 429, 5xx): re-queue with capped backoff.
 *       After MAX_ATTEMPTS transient errors, mark permanently failed.
 *   3c. Permanent error (4xx except 408/429) or missing config: mark failed.
 *
 * Missing credentials fail only the affected deliveries, not the whole batch.
 */
export const processQueue = internalAction({
  args: {},

  handler: async (ctx, _args) => {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const twilioSid     = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken   = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom    = process.env.TWILIO_WHATSAPP_FROM;

    // ── 1. Fetch due, unlocked deliveries enriched with reminder + identity ───
    const batch = await ctx.runQuery(internal.deliveries.getDueDeliveries, {});

    let processed = 0;

    for (const { delivery, reminder, identity } of batch) {

      // ── 2. Acquire lock ─────────────────────────────────────────────────────
      const lockId = crypto.randomUUID();
      const acquired = await ctx.runMutation(internal.deliveries.acquireDeliveryLock, {
        deliveryId: delivery._id,
        lockId,
      });
      if (!acquired) continue; // another worker got there first

      // ── 3. Dispatch by channel ───────────────────────────────────────────────

      if (delivery.channel === "telegram") {
        // ── Telegram ──────────────────────────────────────────────────────────

        if (identity.channel !== "telegram") {
          await handlePermanentFailure(ctx, delivery,
            `Identity channel mismatch: expected telegram, got ${identity.channel}`);
          continue;
        }

        if (!telegramToken) {
          await handlePermanentFailure(ctx, delivery,
            "TELEGRAM_BOT_TOKEN is not set in Convex environment");
          continue;
        }

        try {
          const res = await fetch(
            `https://api.telegram.org/bot${telegramToken}/sendMessage`,
            {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ chat_id: identity.address, text: reminder.title }),
            }
          );

          if (!res.ok) {
            const body = await res.text();
            const reason = `Telegram API ${res.status}: ${body.slice(0, 200)}`;
            if (isTransientHttp(res.status)) {
              await handleTransientFailure(ctx, delivery, lockId, reason);
            } else {
              await handlePermanentFailure(ctx, delivery, reason);
            }
            continue;
          }

          await ctx.runMutation(internal.deliveries.markDelivery, {
            deliveryId:    delivery._id,
            status:        "sent",
            sentAt:        Date.now(),
            lastAttemptAt: Date.now(),
          });
          processed++;
        } catch (err) {
          // Network / runtime error — always transient
          await handleTransientFailure(ctx, delivery, lockId,
            String(err.message ?? err).slice(0, 200));
        }

      } else if (delivery.channel === "whatsapp") {
        // ── WhatsApp via Twilio ────────────────────────────────────────────────

        if (identity.channel !== "whatsapp") {
          await handlePermanentFailure(ctx, delivery,
            `Identity channel mismatch: expected whatsapp, got ${identity.channel}`);
          continue;
        }

        if (!twilioSid || !twilioToken || !twilioFrom) {
          await handlePermanentFailure(ctx, delivery,
            "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_FROM is not set in Convex environment");
          continue;
        }

        const to   = `whatsapp:${identity.address}`;
        const from = twilioFrom.startsWith("whatsapp:") ? twilioFrom : `whatsapp:${twilioFrom}`;
        const text = `Reminder: ${reminder.title}`;

        try {
          const res = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
            {
              method:  "POST",
              headers: {
                "Authorization": `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`,
                "Content-Type":  "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ From: from, To: to, Body: text }).toString(),
            }
          );

          if (!res.ok) {
            const body = await res.text();
            const reason = `Twilio API ${res.status}: ${body.slice(0, 200)}`;
            if (isTransientHttp(res.status)) {
              await handleTransientFailure(ctx, delivery, lockId, reason);
            } else {
              await handlePermanentFailure(ctx, delivery, reason);
            }
            continue;
          }

          await ctx.runMutation(internal.deliveries.markDelivery, {
            deliveryId:    delivery._id,
            status:        "sent",
            sentAt:        Date.now(),
            lastAttemptAt: Date.now(),
          });
          processed++;
        } catch (err) {
          await handleTransientFailure(ctx, delivery, lockId,
            String(err.message ?? err).slice(0, 200));
        }

      } else {
        // Unknown channel — release lock and leave for future channel support
        await ctx.runMutation(internal.deliveries.requeueDelivery, {
          deliveryId:    delivery._id,
          lockId,
          newAttempts:   delivery.attempts,
          nextAttemptAt: delivery.nextAttemptAt,
        });
      }
    }

    return { processed };
  },
});
