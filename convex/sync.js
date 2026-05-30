import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

const BATCH_SIZE      = 10;
const MAX_ATTEMPTS    = 6;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — stale lock expiry
const MS_GRAPH_BASE   = "https://graph.microsoft.com/v1.0";
const GCAL_BASE       = "https://www.googleapis.com/calendar/v3";
const MS_TOKEN_BASE   = "https://login.microsoftonline.com";
const EVENT_DURATION  = 15 * 60 * 1000; // 15 minutes in ms

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

function backoffMs(completedAttempts) {
  return BACKOFF_MS[Math.min(completedAttempts - 1, BACKOFF_MS.length - 1)];
}

function isTransientHttp(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Format a UTC epoch (ms) as a local datetime string "YYYY-MM-DDTHH:mm:ss"
 * in the given IANA timezone, suitable for Microsoft Graph dateTime fields.
 */
function formatLocalDateTime(msEpoch, timezone) {
  return new Date(msEpoch)
    .toLocaleString("sv-SE", { timeZone: timezone })
    .replace(" ", "T");
}

// ── Internal queries ──────────────────────────────────────────────────────────

/**
 * Fetch up to BATCH_SIZE queued Microsoft sync jobs that are not currently locked.
 * Expired locks (crashed workers) are treated as unlocked.
 */
export const getDueJobs = internalQuery({
  args: {},
  handler: async (ctx, _args) => {
    const now = Date.now();

    const candidates = await ctx.db
      .query("reminder_sync_jobs")
      .withIndex("by_status_nextAttemptAt", (q) => q.eq("status", "queued"))
      .take(BATCH_SIZE);

    return candidates.filter(
      (j) => !j.lockedAt || (now - j.lockedAt) >= LOCK_TIMEOUT_MS
    );
  },
});

/**
 * Load a reminder row and its linked identity row together.
 */
export const getReminderWithIdentity = internalQuery({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, args) => {
    const reminder = await ctx.db.get(args.reminderId);
    if (!reminder) return null;
    const identity = await ctx.db.get(reminder.identityId);
    if (!identity) return null;
    return { reminder, identity };
  },
});

// ── Internal mutations ────────────────────────────────────────────────────────

/**
 * Atomically acquire a lock on a sync job.
 * Returns true if the lock was acquired, false if a live lock is already held.
 */
export const acquireSyncJobLock = internalMutation({
  args: {
    jobId:  v.id("reminder_sync_jobs"),
    lockId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "queued") return false;

    const now = Date.now();
    if (job.lockedAt && (now - job.lockedAt) < LOCK_TIMEOUT_MS) return false;

    await ctx.db.patch(args.jobId, { lockedAt: now, lockId: args.lockId });
    return true;
  },
});

/**
 * Re-queue a sync job for retry after a transient failure.
 * Verifies lockId ownership; clears the lock and updates backoff fields.
 */
export const requeueSyncJob = internalMutation({
  args: {
    jobId:         v.id("reminder_sync_jobs"),
    lockId:        v.string(),
    newAttempts:   v.number(),
    nextAttemptAt: v.number(),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.lockId !== args.lockId) return; // stale

    const patch = {
      attempts:      args.newAttempts,
      lastAttemptAt: Date.now(),
      nextAttemptAt: args.nextAttemptAt,
      lockedAt:      undefined,
      lockId:        undefined,
    };
    if (args.failureReason !== undefined) patch.failureReason = args.failureReason;
    await ctx.db.patch(args.jobId, patch);
  },
});

/**
 * Mark a sync job done or permanently failed. Always clears lock fields.
 */
export const markJob = internalMutation({
  args: {
    jobId:         v.id("reminder_sync_jobs"),
    status:        v.union(v.literal("done"), v.literal("failed")),
    failureReason: v.optional(v.string()),
    lastAttemptAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch = {
      status:   args.status,
      lockedAt: undefined,
      lockId:   undefined,
    };
    if (args.failureReason !== undefined) patch.failureReason = args.failureReason;
    if (args.lastAttemptAt !== undefined) patch.lastAttemptAt = args.lastAttemptAt;
    await ctx.db.patch(args.jobId, patch);
  },
});

/**
 * Update the Microsoft sync fields on a reminder row.
 */
export const updateReminderMsSync = internalMutation({
  args: {
    reminderId:      v.id("reminders"),
    msAccountId:     v.optional(v.id("oauth_accounts")),
    msEventId:       v.optional(v.string()),
    msSyncStatus:    v.union(v.literal("none"), v.literal("synced"), v.literal("failed")),
    msFailureReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch = { msSyncStatus: args.msSyncStatus };
    if (args.msAccountId     !== undefined) patch.msAccountId     = args.msAccountId;
    if (args.msEventId       !== undefined) patch.msEventId       = args.msEventId;
    if (args.msFailureReason !== undefined) patch.msFailureReason = args.msFailureReason;
    await ctx.db.patch(args.reminderId, patch);
  },
});

/**
 * Update the Google Calendar sync fields on a reminder row.
 */
export const updateReminderGoogleSync = internalMutation({
  args: {
    reminderId:          v.id("reminders"),
    googleAccountId:     v.optional(v.id("oauth_accounts")),
    googleEventId:       v.optional(v.string()),
    googleCalendarId:    v.optional(v.string()),
    googleSyncStatus:    v.union(v.literal("none"), v.literal("synced"), v.literal("failed")),
    googleFailureReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch = { googleSyncStatus: args.googleSyncStatus };
    if (args.googleAccountId     !== undefined) patch.googleAccountId     = args.googleAccountId;
    if (args.googleEventId       !== undefined) patch.googleEventId       = args.googleEventId;
    if (args.googleCalendarId    !== undefined) patch.googleCalendarId    = args.googleCalendarId;
    if (args.googleFailureReason !== undefined) patch.googleFailureReason = args.googleFailureReason;
    await ctx.db.patch(args.reminderId, patch);
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fail a sync job — either permanently or by re-queuing with backoff.
 *
 * - Permanent failures update the reminder's msSyncStatus to "failed".
 * - Transient failures under MAX_ATTEMPTS are re-queued without updating
 *   the reminder's sync status (it will succeed on a future attempt).
 */
async function failJob(ctx, job, lockId, reminderId, msAccountId, reason, transient = false) {
  const currentAttempts = job.attempts + 1;
  const permanent = !transient || currentAttempts >= MAX_ATTEMPTS;

  if (permanent) {
    if (reminderId) {
      await ctx.runMutation(internal.sync.updateReminderMsSync, {
        reminderId,
        msAccountId,
        msSyncStatus:    "failed",
        msFailureReason: permanent && transient
          ? `Max attempts reached. Last error: ${reason}`
          : reason,
      });
    }
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "failed",
      failureReason: permanent && transient
        ? `Max attempts reached. Last error: ${reason}`
        : reason,
      lastAttemptAt: Date.now(),
    });
  } else {
    await ctx.runMutation(internal.sync.requeueSyncJob, {
      jobId:         job._id,
      lockId,
      newAttempts:   currentAttempts,
      nextAttemptAt: Date.now() + backoffMs(currentAttempts),
      failureReason: reason,
    });
  }
}

/**
 * Fail a Google sync job — either permanently or by re-queuing with backoff.
 * Mirrors failJob but updates googleSyncStatus / googleFailureReason instead.
 */
async function failGoogleJob(ctx, job, lockId, reminderId, googleAccountId, reason, transient = false) {
  const currentAttempts = job.attempts + 1;
  const permanent = !transient || currentAttempts >= MAX_ATTEMPTS;

  if (permanent) {
    if (reminderId) {
      await ctx.runMutation(internal.sync.updateReminderGoogleSync, {
        reminderId,
        googleAccountId,
        googleSyncStatus:    "failed",
        googleFailureReason: permanent && transient
          ? `Max attempts reached. Last error: ${reason}`
          : reason,
      });
    }
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "failed",
      failureReason: permanent && transient
        ? `Max attempts reached. Last error: ${reason}`
        : reason,
      lastAttemptAt: Date.now(),
    });
  } else {
    await ctx.runMutation(internal.sync.requeueSyncJob, {
      jobId:         job._id,
      lockId,
      newAttempts:   currentAttempts,
      nextAttemptAt: Date.now() + backoffMs(currentAttempts),
      failureReason: reason,
    });
  }
}

/**
 * Handle a Google Calendar create sync job.
 *
 * Loads the linked google oauth_account, refreshes its token when expiring,
 * then POSTs to events.insert on the reminder's googleCalendarId (default "primary").
 * On success stores googleEventId and sets googleSyncStatus="synced".
 */
async function handleGoogleCreateJob(ctx, job, lockId) {
  const data = await ctx.runQuery(internal.sync.getReminderWithIdentity, {
    reminderId: job.reminderId,
  });

  if (!data) {
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "failed",
      failureReason: "Reminder row no longer exists",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  const { reminder, identity } = data;

  const account = await ctx.runQuery(api.oauth.getAccountByIdentityProvider, {
    identityId: identity._id,
    provider:   "google",
  });

  if (!account) {
    // No Google account linked — nothing to do; mark done quietly
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  let tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
    accountId: account._id,
  });

  if (!tokenRow) {
    await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
      "No token row found for linked Google account");
    return;
  }

  // Refresh token if expiring within 5 minutes
  if (tokenRow.expiresAt < Date.now() + 5 * 60 * 1000) {
    try {
      await ctx.runAction(internal.oauth.refreshGoogleToken, { accountId: account._id });
      tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, { accountId: account._id });
    } catch (err) {
      await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
        `Google token refresh failed: ${String(err.message ?? err).slice(0, 200)}`,
        true /* transient */);
      return;
    }
  }

  const calendarId = reminder.googleCalendarId ?? "primary";
  const startLocal  = formatLocalDateTime(reminder.runAt, reminder.timezone);
  const endLocal    = formatLocalDateTime(reminder.runAt + EVENT_DURATION, reminder.timezone);

  try {
    const res = await fetch(
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${tokenRow.accessToken}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          summary: reminder.title,
          start:   { dateTime: startLocal, timeZone: reminder.timezone },
          end:     { dateTime: endLocal,   timeZone: reminder.timezone },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
        `Google Calendar events.insert failed (${res.status}): ${body.slice(0, 200)}`,
        isTransientHttp(res.status));
      return;
    }

    const event = await res.json();

    await ctx.runMutation(internal.sync.updateReminderGoogleSync, {
      reminderId:       reminder._id,
      googleAccountId:  account._id,
      googleEventId:    event.id,
      googleCalendarId: calendarId,
      googleSyncStatus: "synced",
    });
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
  } catch (err) {
    await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
      `Google Calendar request error: ${String(err.message ?? err).slice(0, 200)}`,
      true /* network error — transient */);
  }
}

/**
 * Handle a Google Calendar delete sync job.
 *
 * Calls events.delete on the calendar + eventId stored on the reminder.
 * 404 is treated as success (idempotent). Clears googleEventId on success.
 */
async function handleGoogleDeleteJob(ctx, job, lockId) {
  const data = await ctx.runQuery(internal.sync.getReminderWithIdentity, {
    reminderId: job.reminderId,
  });

  if (!data) {
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "failed",
      failureReason: "Reminder row no longer exists",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  const { reminder, identity } = data;

  if (!reminder.googleEventId) {
    // Nothing to delete — mark done silently
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  const account = await ctx.runQuery(api.oauth.getAccountByIdentityProvider, {
    identityId: identity._id,
    provider:   "google",
  });

  if (!account) {
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  let tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
    accountId: account._id,
  });

  if (!tokenRow) {
    await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
      "No token row found for linked Google account");
    return;
  }

  // Refresh token if expiring within 5 minutes
  if (tokenRow.expiresAt < Date.now() + 5 * 60 * 1000) {
    try {
      await ctx.runAction(internal.oauth.refreshGoogleToken, { accountId: account._id });
      tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, { accountId: account._id });
    } catch (err) {
      await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
        `Google token refresh failed: ${String(err.message ?? err).slice(0, 200)}`,
        true);
      return;
    }
  }

  const calendarId = reminder.googleCalendarId ?? "primary";

  try {
    const res = await fetch(
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(reminder.googleEventId)}`,
      {
        method:  "DELETE",
        headers: { "Authorization": `Bearer ${tokenRow.accessToken}` },
      }
    );

    // 204 = deleted; 404 = already gone — both are success (idempotent)
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
        `Google Calendar events.delete failed (${res.status}): ${body.slice(0, 200)}`,
        isTransientHttp(res.status));
      return;
    }

    await ctx.runMutation(internal.sync.updateReminderGoogleSync, {
      reminderId:       reminder._id,
      googleAccountId:  account._id,
      googleSyncStatus: "none",
    });
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
  } catch (err) {
    await failGoogleJob(ctx, job, lockId, reminder._id, account._id,
      `Google Calendar delete request error: ${String(err.message ?? err).slice(0, 200)}`,
      true /* network error — transient */);
  }
}

/**
 * Handle a delete sync job: load the reminder's msEventId, ensure the user
 * has a valid (possibly refreshed) token, then DELETE /me/events/{msEventId}.
 *
 * 404 from Graph is treated as success (event already deleted — idempotent).
 */
async function handleDeleteJob(ctx, job, lockId, clientId, clientSecret, tenant) {
  const data = await ctx.runQuery(internal.sync.getReminderWithIdentity, {
    reminderId: job.reminderId,
  });

  if (!data) {
    // Reminder was deleted — discard the job permanently
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "failed",
      failureReason: "Reminder row no longer exists",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  const { reminder, identity } = data;

  if (!reminder.msEventId) {
    // Nothing to delete — mark done silently
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  const account = await ctx.runQuery(api.oauth.getAccountByIdentityProvider, {
    identityId: identity._id,
    provider:   "microsoft",
  });

  if (!account) {
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
    return;
  }

  let tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
    accountId: account._id,
  });

  if (!tokenRow) {
    await failJob(ctx, job, lockId, reminder._id, account._id,
      "No token row found for linked Microsoft account");
    return;
  }

  // Refresh token if expiring within 5 minutes
  if (tokenRow.expiresAt < Date.now() + 5 * 60 * 1000) {
    if (!clientId || !clientSecret) {
      await failJob(ctx, job, lockId, reminder._id, account._id,
        "MS_CLIENT_ID or MS_CLIENT_SECRET not set in Convex environment — cannot refresh token");
      return;
    }
    try {
      const refreshRes = await fetch(
        `${MS_TOKEN_BASE}/${tenant}/oauth2/v2.0/token`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            client_id:     clientId,
            client_secret: clientSecret,
            grant_type:    "refresh_token",
            refresh_token: tokenRow.refreshToken,
            scope:         tokenRow.scopes,
          }).toString(),
        }
      );
      if (!refreshRes.ok) {
        const body = await refreshRes.text();
        await failJob(ctx, job, lockId, reminder._id, account._id,
          `Token refresh failed (${refreshRes.status}): ${body.slice(0, 200)}`,
          isTransientHttp(refreshRes.status));
        return;
      }
      const refreshed = await refreshRes.json();
      await ctx.runMutation(api.oauth.upsertOAuthTokens, {
        accountId:    account._id,
        accessToken:  refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? tokenRow.refreshToken,
        expiresAt:    Date.now() + refreshed.expires_in * 1000,
        scopes:       refreshed.scope ?? tokenRow.scopes,
      });
      tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, { accountId: account._id });
    } catch (err) {
      await failJob(ctx, job, lockId, reminder._id, account._id,
        `Token refresh error: ${String(err.message ?? err).slice(0, 200)}`,
        true /* network error — transient */);
      return;
    }
  }

  try {
    const res = await fetch(
      `${MS_GRAPH_BASE}/me/events/${reminder.msEventId}`,
      {
        method:  "DELETE",
        headers: { "Authorization": `Bearer ${tokenRow.accessToken}` },
      }
    );

    // 204 = deleted; 404 = already gone — both are success (idempotent)
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      await failJob(ctx, job, lockId, reminder._id, account._id,
        `Graph DELETE /me/events failed (${res.status}): ${body.slice(0, 200)}`,
        isTransientHttp(res.status));
      return;
    }

    await ctx.runMutation(internal.sync.updateReminderMsSync, {
      reminderId:   reminder._id,
      msAccountId:  account._id,
      msSyncStatus: "none",
    });
    await ctx.runMutation(internal.sync.markJob, {
      jobId:         job._id,
      status:        "done",
      lastAttemptAt: Date.now(),
    });
  } catch (err) {
    await failJob(ctx, job, lockId, reminder._id, account._id,
      `Graph DELETE request error: ${String(err.message ?? err).slice(0, 200)}`,
      true /* network error — transient */);
  }
}

// ── Main cron action ──────────────────────────────────────────────────────────

/**
 * processMicrosoftSyncJobs — runs every 1 minute via convex/crons.js.
 *
 * For each queued Microsoft sync job:
 *   1. Acquire an optimistic lock — skip if another worker holds it.
 *   2. Load reminder + identity; find linked Microsoft oauth_account.
 *   3. Load oauth_tokens; refresh via Microsoft token endpoint if expiring soon.
 *   4. POST /me/calendar/events (create) or DELETE /me/events/{id} (delete).
 *   5a. Success: store msEventId, set msSyncStatus="synced", mark job done.
 *   5b. Transient error: re-queue with capped backoff.
 *   5c. Permanent error or MAX_ATTEMPTS reached: mark failed.
 */
export const processMicrosoftSyncJobs = internalAction({
  args: {},

  handler: async (ctx, _args) => {
    const clientId     = process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_CLIENT_SECRET;
    const tenant       = process.env.MS_TENANT || "common";

    const jobs = await ctx.runQuery(internal.sync.getDueJobs, {});
    let processed = 0;

    for (const job of jobs) {
      // ── 1. Acquire lock ───────────────────────────────────────────────────
      const lockId = crypto.randomUUID();
      const acquired = await ctx.runMutation(internal.sync.acquireSyncJobLock, {
        jobId: job._id,
        lockId,
      });
      if (!acquired) continue;

      // ── 2. Dispatch by provider × action ──────────────────────────────────
      if (job.provider === "google") {
        if (job.action === "delete") {
          await handleGoogleDeleteJob(ctx, job, lockId);
        } else {
          await handleGoogleCreateJob(ctx, job, lockId);
        }
        processed++;
        continue;
      }

      if (job.provider !== "microsoft") continue;

      // ── Microsoft dispatch ─────────────────────────────────────────────────
      if (job.action === "delete") {
        await handleDeleteJob(ctx, job, lockId, clientId, clientSecret, tenant);
        processed++;
        continue;
      }

      // Default: action === "create"

      // ── 2. Load reminder + identity ───────────────────────────────────────
      const data = await ctx.runQuery(internal.sync.getReminderWithIdentity, {
        reminderId: job.reminderId,
      });

      if (!data) {
        await ctx.runMutation(internal.sync.markJob, {
          jobId:         job._id,
          status:        "failed",
          failureReason: "Reminder row no longer exists",
          lastAttemptAt: Date.now(),
        });
        continue;
      }

      const { reminder, identity } = data;

      // ── 3. Find linked Microsoft account ──────────────────────────────────
      const account = await ctx.runQuery(api.oauth.getAccountByIdentityProvider, {
        identityId: identity._id,
        provider:   "microsoft",
      });

      if (!account) {
        // No account linked — nothing to do; mark done quietly
        await ctx.runMutation(internal.sync.markJob, {
          jobId:         job._id,
          status:        "done",
          lastAttemptAt: Date.now(),
        });
        continue;
      }

      // ── 4. Load tokens ────────────────────────────────────────────────────
      let tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
        accountId: account._id,
      });

      if (!tokenRow) {
        await failJob(ctx, job, lockId, reminder._id, account._id,
          "No token row found for linked Microsoft account");
        continue;
      }

      // ── 5. Refresh token if expiring within 5 minutes ────────────────────
      if (tokenRow.expiresAt < Date.now() + 5 * 60 * 1000) {
        if (!clientId || !clientSecret) {
          await failJob(ctx, job, lockId, reminder._id, account._id,
            "MS_CLIENT_ID or MS_CLIENT_SECRET not set in Convex environment — cannot refresh token");
          continue;
        }

        try {
          const refreshRes = await fetch(
            `${MS_TOKEN_BASE}/${tenant}/oauth2/v2.0/token`,
            {
              method:  "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body:    new URLSearchParams({
                client_id:     clientId,
                client_secret: clientSecret,
                grant_type:    "refresh_token",
                refresh_token: tokenRow.refreshToken,
                scope:         tokenRow.scopes,
              }).toString(),
            }
          );

          if (!refreshRes.ok) {
            const body = await refreshRes.text();
            await failJob(ctx, job, lockId, reminder._id, account._id,
              `Token refresh failed (${refreshRes.status}): ${body.slice(0, 200)}`,
              isTransientHttp(refreshRes.status));
            continue;
          }

          const refreshed = await refreshRes.json();
          await ctx.runMutation(api.oauth.upsertOAuthTokens, {
            accountId:    account._id,
            accessToken:  refreshed.access_token,
            refreshToken: refreshed.refresh_token ?? tokenRow.refreshToken,
            expiresAt:    Date.now() + refreshed.expires_in * 1000,
            scopes:       refreshed.scope ?? tokenRow.scopes,
          });

          tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
            accountId: account._id,
          });
        } catch (err) {
          await failJob(ctx, job, lockId, reminder._id, account._id,
            `Token refresh error: ${String(err.message ?? err).slice(0, 200)}`,
            true /* network error — transient */);
          continue;
        }
      }

      // ── 6. Create Microsoft Calendar event ───────────────────────────────
      const startLocal = formatLocalDateTime(reminder.runAt, reminder.timezone);
      const endLocal   = formatLocalDateTime(reminder.runAt + EVENT_DURATION, reminder.timezone);

      try {
        const graphRes = await fetch(
          `${MS_GRAPH_BASE}/me/calendar/events`,
          {
            method:  "POST",
            headers: {
              "Authorization": `Bearer ${tokenRow.accessToken}`,
              "Content-Type":  "application/json",
            },
            body: JSON.stringify({
              subject: reminder.title,
              body:    { contentType: "Text", content: "Created by bot" },
              start:   { dateTime: startLocal, timeZone: reminder.timezone },
              end:     { dateTime: endLocal,   timeZone: reminder.timezone },
            }),
          }
        );

        if (!graphRes.ok) {
          const body = await graphRes.text();
          await failJob(ctx, job, lockId, reminder._id, account._id,
            `Graph POST /me/calendar/events failed (${graphRes.status}): ${body.slice(0, 200)}`,
            isTransientHttp(graphRes.status));
          continue;
        }

        const event = await graphRes.json();

        // ── 7. Persist success ────────────────────────────────────────────
        await ctx.runMutation(internal.sync.updateReminderMsSync, {
          reminderId:   reminder._id,
          msAccountId:  account._id,
          msEventId:    event.id,
          msSyncStatus: "synced",
        });
        await ctx.runMutation(internal.sync.markJob, {
          jobId:         job._id,
          status:        "done",
          lastAttemptAt: Date.now(),
        });
        processed++;
      } catch (err) {
        await failJob(ctx, job, lockId, reminder._id, account._id,
          `Graph request error: ${String(err.message ?? err).slice(0, 200)}`,
          true /* network error — transient */);
      }
    }

    return { processed };
  },
});
