import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Look up an existing reminder_requests row by (channel, providerMsgId).
 * Returns the row or null.
 *
 * Called by the Node server before invoking OpenAI so retried webhook
 * deliveries skip extraction and return the already-created reminderId.
 */
export const getByChannelProviderMsgId = query({
  args: {
    channel:       v.string(),
    providerMsgId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reminder_requests")
      .withIndex("by_channel_providerMsgId", (q) =>
        q.eq("channel", args.channel).eq("providerMsgId", args.providerMsgId)
      )
      .first();
  },
});

/**
 * Insert a new reminder_requests row linking a provider message ID to a
 * created reminder. Idempotent: if a row for (channel, providerMsgId)
 * already exists the existing row is returned and nothing is inserted.
 *
 * Convex's OCC guarantees the check-then-insert is atomic, so concurrent
 * retries of the same update_id cannot produce two rows.
 *
 * Returns { created: boolean, reminderId }.
 */
export const createIfAbsent = mutation({
  args: {
    channel:       v.string(),
    providerMsgId: v.string(),
    identityId:    v.id("identities"),
    reminderId:    v.id("reminders"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("reminder_requests")
      .withIndex("by_channel_providerMsgId", (q) =>
        q.eq("channel", args.channel).eq("providerMsgId", args.providerMsgId)
      )
      .first();

    if (existing) {
      return { created: false, reminderId: existing.reminderId };
    }

    await ctx.db.insert("reminder_requests", {
      channel:       args.channel,
      providerMsgId: args.providerMsgId,
      identityId:    args.identityId,
      reminderId:    args.reminderId,
      createdAt:     Date.now(),
    });

    return { created: true, reminderId: args.reminderId };
  },
});
