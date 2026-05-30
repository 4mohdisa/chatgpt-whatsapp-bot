import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Returns a single identity row by its Convex _id, or null.
 * Used by the OAuth /connect/outlook route to validate identityId.
 */
export const getById = query({
  args: { identityId: v.id("identities") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.identityId);
  },
});

/**
 * Patches user-configurable settings on an identity row.
 * Only fields explicitly provided in `args` are updated; others are left untouched.
 * Passing `undefined` for a field is a no-op for that field.
 *
 * Settable fields:
 *   defaultTimezone         — IANA timezone used when user omits tz in a reminder
 *   defaultChannel          — preferred outbound delivery channel ("telegram"|"whatsapp")
 *   defaultCalendarProvider — calendar backend ("microsoft"|"google"|"none")
 */
export const setIdentitySettings = mutation({
  args: {
    identityId:              v.id("identities"),
    defaultTimezone:         v.optional(v.string()),
    defaultChannel:          v.optional(v.union(
      v.literal("telegram"),
      v.literal("whatsapp"),
    )),
    defaultCalendarProvider: v.optional(v.union(
      v.literal("microsoft"),
      v.literal("google"),
      v.literal("none"),
    )),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.db.get(args.identityId);
    if (!identity) throw new Error(`Identity not found: ${args.identityId}`);

    const patch = {};
    if (args.defaultTimezone         !== undefined) patch.defaultTimezone         = args.defaultTimezone;
    if (args.defaultChannel          !== undefined) patch.defaultChannel          = args.defaultChannel;
    if (args.defaultCalendarProvider !== undefined) patch.defaultCalendarProvider = args.defaultCalendarProvider;

    if (Object.keys(patch).length === 0) return;  // nothing to update

    await ctx.db.patch(args.identityId, patch);
  },
});

/**
 * Returns the identity row for a given channel + address pair, or null.
 * Used by server.js to resolve identityId before creating a reminder.
 */
export const getByChannelAddress = query({
  args: {
    channel: v.string(),
    address: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("identities")
      .withIndex("by_channel_address", (q) =>
        q.eq("channel", args.channel).eq("address", args.address)
      )
      .first();
  },
});
