import { mutation } from "./_generated/server";
import { v } from "convex/values";

// ── Constants ──────────────────────────────────────────────────────────────────

// Unambiguous chars: excludes 0/O, 1/I, S/5, etc. to reduce transcription errors.
const CODE_CHARS  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function generateCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Find-or-create an app_user row for a Clerk user.
 * Idempotent: calling multiple times for the same clerkUserId is safe.
 * Returns the app_user _id.
 */
export const upsertAppUser = mutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("app_users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();

    if (existing) return existing._id;

    return await ctx.db.insert("app_users", {
      clerkUserId: args.clerkUserId,
      createdAt:   Date.now(),
    });
  },
});

/**
 * Issue a one-time link code for a Clerk user.
 *
 * An optional channel restricts which chat channel can redeem the code.
 * If omitted, any channel can redeem it.
 *
 * Returns { code } — the caller displays this to the user in the dashboard.
 * The code expires after 15 minutes.
 */
export const issueLinkCode = mutation({
  args: {
    clerkUserId: v.string(),
    channel:     v.optional(v.union(
      v.literal("telegram"),
      v.literal("whatsapp"),
    )),
  },
  handler: async (ctx, args) => {
    const now  = Date.now();
    const code = generateCode();

    await ctx.db.insert("link_codes", {
      code,
      clerkUserId: args.clerkUserId,
      channel:     args.channel,
      status:      "issued",
      expiresAt:   now + CODE_TTL_MS,
      createdAt:   now,
    });

    return { code };
  },
});

/**
 * Redeem a link code sent by a user in a chat channel.
 *
 * Validates:
 *   - Code exists and has status "issued"
 *   - Code has not expired (also marks it "expired" if past expiresAt)
 *   - If code.channel is set, it must match args.channel
 *
 * On success:
 *   - Marks code "used" and records the identityId that redeemed it
 *   - Patches identity.clerkUserId with the code's clerkUserId
 *
 * Returns { ok: true } on success.
 * Returns { ok: false, reason } on failure where reason is one of:
 *   "invalid"       — code not found
 *   "used"          — code already redeemed
 *   "expired"       — code past its expiry time
 *   "wrong_channel" — code was issued for a different channel
 */
export const redeemLinkCode = mutation({
  args: {
    code:       v.string(),
    channel:    v.string(),
    identityId: v.id("identities"),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("link_codes")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .first();

    if (!row)                      return { ok: false, reason: "invalid" };
    if (row.status === "used")     return { ok: false, reason: "used" };
    if (row.status === "expired")  return { ok: false, reason: "expired" };

    if (row.expiresAt <= Date.now()) {
      await ctx.db.patch(row._id, { status: "expired" });
      return { ok: false, reason: "expired" };
    }

    if (row.channel && row.channel !== args.channel) {
      return { ok: false, reason: "wrong_channel" };
    }

    // ── Mark code used ────────────────────────────────────────────────────────
    await ctx.db.patch(row._id, {
      status:     "used",
      identityId: args.identityId,
    });

    // ── Bind Clerk user to this identity ──────────────────────────────────────
    await ctx.db.patch(args.identityId, { clerkUserId: row.clerkUserId });

    return { ok: true };
  },
});
