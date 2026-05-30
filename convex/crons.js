import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Every minute: pick up queued deliveries whose scheduledFor <= now
 * and send them via the appropriate channel (Telegram / WhatsApp).
 */
crons.interval(
  "process-due-deliveries",
  { minutes: 1 },
  internal.deliveries.processQueue,
);

/**
 * Every minute: pick up queued Microsoft Calendar sync jobs and create
 * Outlook events for reminders whose user has a linked Microsoft account.
 */
crons.interval(
  "process-microsoft-sync-jobs",
  { minutes: 1 },
  internal.sync.processMicrosoftSyncJobs,
);

/**
 * Daily at 02:00 UTC: soft-archive reminders with terminal status
 * (sent / failed / cancelled) that are older than 30 days. Their delivery
 * rows are archived in the same operation. Rows are never deleted.
 */
crons.daily(
  "archive-old-reminders",
  { hourUTC: 2, minuteUTC: 0 },
  internal.cleanup.archiveOldData,
);

export default crons;
