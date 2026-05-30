import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Upserts a user + identity for the given channel/address pair,
 * then inserts the message — unless a message with this providerMsgId
 * already exists (idempotency guard).
 *
 * Returns the message _id (existing or newly created).
 */
export const upsertIdentityAndLogMessage = mutation({
  args: {
    channel:       v.string(),  // e.g. "whatsapp"
    address:       v.string(),  // e.g. "+447700900123"
    providerMsgId: v.string(),  // e.g. Twilio SID "SM..."
    direction:     v.string(),  // "inbound" | "outbound"
    text:          v.string(),
    rawPayload:    v.string(),  // JSON.stringify(req.body)
  },

  handler: async (ctx, args) => {
    // ── 1. Upsert identity (and user if this is their first message) ─────────
    let identity = await ctx.db
      .query("identities")
      .withIndex("by_channel_address", (q) =>
        q.eq("channel", args.channel).eq("address", args.address)
      )
      .first();

    if (identity === null) {
      const userId = await ctx.db.insert("users", {
        createdAt: Date.now(),
      });

      const identityId = await ctx.db.insert("identities", {
        userId,
        channel:   args.channel,
        address:   args.address,
        createdAt: Date.now(),
      });

      identity = await ctx.db.get(identityId);
    }

    // ── 2. Idempotency guard — skip if we have already stored this message ───
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_provider_msg_id", (q) =>
        q.eq("providerMsgId", args.providerMsgId)
      )
      .first();

    if (existing !== null) {
      return existing._id;
    }

    // ── 3. Insert the new message row ────────────────────────────────────────
    return await ctx.db.insert("messages", {
      identityId:    identity._id,
      channel:       args.channel,
      providerMsgId: args.providerMsgId,
      direction:     args.direction,
      text:          args.text,
      rawPayload:    args.rawPayload,
      createdAt:     Date.now(),
    });
  },
});
