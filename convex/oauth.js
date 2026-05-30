import { mutation, query, internalAction, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Public query: look up an oauth_account by (identityId, provider).
 * Used by server.js to check whether a user already has a linked account.
 */
export const getAccountByIdentityProvider = query({
  args: {
    identityId: v.id("identities"),
    provider:   v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("oauth_accounts")
      .withIndex("by_identity_provider", (q) =>
        q.eq("identityId", args.identityId).eq("provider", args.provider)
      )
      .first();
  },
});

/**
 * Internal query: fetch the current token row for an account.
 * Called by the refresh action — not exposed to external clients.
 */
export const getTokensByAccountId = internalQuery({
  args: { accountId: v.id("oauth_accounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("oauth_tokens")
      .withIndex("by_account_id", (q) => q.eq("accountId", args.accountId))
      .first();
  },
});

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Public mutation: upsert an oauth_account row for (identityId, provider).
 * Patches in place if a row already exists. Returns the accountId (_id).
 */
export const upsertOAuthAccount = mutation({
  args: {
    identityId:        v.id("identities"),
    provider:          v.string(),
    tenantId:          v.optional(v.string()),
    userPrincipalName: v.string(),
    msUserId:          v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("oauth_accounts")
      .withIndex("by_identity_provider", (q) =>
        q.eq("identityId", args.identityId).eq("provider", args.provider)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        tenantId:          args.tenantId,
        userPrincipalName: args.userPrincipalName,
        msUserId:          args.msUserId,
      });
      return existing._id;
    }

    return await ctx.db.insert("oauth_accounts", {
      identityId:        args.identityId,
      provider:          args.provider,
      tenantId:          args.tenantId,
      userPrincipalName: args.userPrincipalName,
      msUserId:          args.msUserId,
      createdAt:         Date.now(),
    });
  },
});

/**
 * Public mutation: upsert the token row for an account.
 * Keeps exactly one row per account — patches in place if it exists.
 * Returns the token row _id.
 */
export const upsertOAuthTokens = mutation({
  args: {
    accountId:    v.id("oauth_accounts"),
    accessToken:  v.string(),
    refreshToken: v.string(),
    expiresAt:    v.number(),
    scopes:       v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("oauth_tokens")
      .withIndex("by_account_id", (q) => q.eq("accountId", args.accountId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken:  args.accessToken,
        refreshToken: args.refreshToken,
        expiresAt:    args.expiresAt,
        scopes:       args.scopes,
      });
      return existing._id;
    }

    return await ctx.db.insert("oauth_tokens", {
      accountId:    args.accountId,
      accessToken:  args.accessToken,
      refreshToken: args.refreshToken,
      expiresAt:    args.expiresAt,
      scopes:       args.scopes,
      createdAt:    Date.now(),
    });
  },
});

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Internal action: refresh a Microsoft access token using the stored
 * refresh token for the given accountId.
 *
 * Reads MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT from Convex env vars.
 * Not wired into reminder delivery yet — call explicitly when needed.
 *
 * Returns { expiresAt } on success; throws on failure.
 */
export const refreshMicrosoftToken = internalAction({
  args: { accountId: v.id("oauth_accounts") },
  handler: async (ctx, args) => {
    const clientId     = process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_CLIENT_SECRET;
    const tenant       = process.env.MS_TENANT || "common";

    if (!clientId || !clientSecret) {
      throw new Error("MS_CLIENT_ID or MS_CLIENT_SECRET not set in Convex environment");
    }

    // ── 1. Load current token row ─────────────────────────────────────────────
    const tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
      accountId: args.accountId,
    });

    if (!tokenRow) {
      throw new Error(`No token row found for accountId ${args.accountId}`);
    }

    // ── 2. Exchange refresh token with Microsoft ──────────────────────────────
    const res = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
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

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Microsoft token refresh failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = await res.json();

    // ── 3. Persist refreshed tokens ───────────────────────────────────────────
    // Microsoft may not always return a new refresh_token; keep the old one if absent.
    const expiresAt = Date.now() + data.expires_in * 1000;

    await ctx.runMutation(api.oauth.upsertOAuthTokens, {
      accountId:    args.accountId,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token ?? tokenRow.refreshToken,
      expiresAt,
      scopes:       data.scope ?? tokenRow.scopes,
    });

    return { expiresAt };
  },
});

/**
 * Internal action: refresh a Google access token using the stored
 * refresh token for the given accountId.
 *
 * Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from Convex env vars.
 * Not wired into reminder sync yet — call explicitly when needed.
 *
 * Google does not always issue a new refresh_token on refresh; the
 * existing one is kept when the response omits it.
 *
 * Returns { expiresAt } on success; throws on failure.
 */
export const refreshGoogleToken = internalAction({
  args: { accountId: v.id("oauth_accounts") },
  handler: async (ctx, args) => {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set in Convex environment");
    }

    // ── 1. Load current token row ─────────────────────────────────────────────
    const tokenRow = await ctx.runQuery(internal.oauth.getTokensByAccountId, {
      accountId: args.accountId,
    });

    if (!tokenRow) {
      throw new Error(`No token row found for accountId ${args.accountId}`);
    }

    // ── 2. Exchange refresh token with Google ─────────────────────────────────
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    "refresh_token",
        refresh_token: tokenRow.refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google token refresh failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = await res.json();

    // ── 3. Persist refreshed tokens ───────────────────────────────────────────
    // Google does not re-issue a refresh_token unless prompt=consent was used;
    // keep the stored one when the response omits it.
    const expiresAt = Date.now() + data.expires_in * 1000;

    await ctx.runMutation(api.oauth.upsertOAuthTokens, {
      accountId:    args.accountId,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token ?? tokenRow.refreshToken,
      expiresAt,
      scopes:       data.scope ?? tokenRow.scopes,
    });

    return { expiresAt };
  },
});
