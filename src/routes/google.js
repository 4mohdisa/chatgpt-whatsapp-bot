'use strict';

const express                    = require('express');
const axios                      = require('axios');
const { convex, anyApi }         = require('../convexClient');
const { missingGoogleVars }      = require('../config');

// Scopes requested at consent time.
// openid + email gives us the stable `sub` identifier and email for the account row.
// calendar.events is requested now so re-consent is not needed when sync is wired up.
const GOOGLE_SCOPES = [
    'openid',
    'profile',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const router = express.Router();

/**
 * GET /connect/google?identityId=<convex_identity_id>
 *
 * Validates the identityId in Convex, then redirects the user to the
 * Google consent screen. The identityId is carried through the OAuth
 * state parameter so the callback can link the account.
 *
 * Required env vars: GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI
 */
router.get('/connect/google', async (req, res) => {
    const { identityId } = req.query;

    if (!identityId) {
        return res.status(400).send('Missing required query param: identityId');
    }

    if (!convex) {
        return res.status(503).send('Convex is not configured. Set CONVEX_URL to enable OAuth.');
    }

    const missing = missingGoogleVars();
    if (missing.length > 0) {
        return res.status(503).send(`Google OAuth is not configured. Missing vars: ${missing.join(', ')}`);
    }

    // Validate identityId exists before redirecting
    let identity;
    try {
        identity = await convex.query(anyApi.identities.getById, { identityId });
    } catch (err) {
        console.error('[Google OAuth] Identity lookup failed:', err.message || err);
        return res.status(500).send('Failed to validate identity. Please try again.');
    }

    if (!identity) {
        return res.status(400).send('Unknown identityId. Please send a message via WhatsApp or Telegram first to register.');
    }

    // Encode identityId in state to recover it in the callback.
    // base64url avoids URL-encoding issues in the redirect.
    const state = Buffer.from(JSON.stringify({ identityId })).toString('base64url');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',     process.env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',  process.env.GOOGLE_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         GOOGLE_SCOPES);
    authUrl.searchParams.set('state',         state);
    authUrl.searchParams.set('access_type',   'offline');   // request refresh_token
    authUrl.searchParams.set('prompt',        'consent');   // always show consent screen so refresh_token is issued

    res.redirect(authUrl.toString());
});

/**
 * GET /auth/google/callback
 *
 * Google redirects here after the user consents. Exchanges the code for
 * tokens, fetches the user profile from Google's userinfo endpoint, and
 * persists the linked oauth_account + oauth_tokens rows in Convex.
 *
 * Field mapping to the shared oauth_accounts schema:
 *   userPrincipalName = Google email
 *   msUserId          = Google `sub` (stable account identifier, analogous to MS user object ID)
 *   tenantId          = not applicable for Google; omitted
 *
 * Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 */
router.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        console.error('[Google OAuth] Google returned error:', error);
        return res.status(400).send(`Google OAuth error: ${error}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state in callback.');
    }

    if (!convex) {
        return res.status(503).send('Convex is not configured.');
    }

    const missingCb = missingGoogleVars();
    if (missingCb.length > 0) {
        return res.status(503).send(`Google OAuth is not fully configured. Missing vars: ${missingCb.join(', ')}`);
    }

    const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;

    // ── 1. Decode identityId from state ───────────────────────────────────────
    let identityId;
    try {
        ({ identityId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')));
    } catch (_) {
        return res.status(400).send('Invalid state parameter.');
    }

    if (!identityId) {
        return res.status(400).send('Missing identityId in state.');
    }

    // ── 2. Exchange authorization code for tokens ─────────────────────────────
    let tokenData;
    try {
        const tokenRes = await axios.post(
            'https://oauth2.googleapis.com/token',
            new URLSearchParams({
                code,
                client_id:     GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri:  GOOGLE_REDIRECT_URI,
                grant_type:    'authorization_code',
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        tokenData = tokenRes.data;
    } catch (err) {
        console.error('[Google OAuth] Token exchange failed:', err.response?.data || err.message);
        return res.status(502).send('Failed to exchange authorization code for tokens. Please try again.');
    }

    // ── 3. Fetch user profile from Google userinfo endpoint ───────────────────
    let googleUser;
    try {
        const userinfoRes = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        googleUser = userinfoRes.data;
    } catch (err) {
        console.error('[Google OAuth] Userinfo failed:', err.response?.data || err.message);
        return res.status(502).send('Failed to fetch Google profile. Please try again.');
    }

    // ── 4. Persist oauth_account + oauth_tokens in Convex ────────────────────
    // Reuse the shared schema: sub → msUserId (stable Google account ID),
    // email → userPrincipalName, tenantId omitted (not applicable for Google).
    try {
        const accountId = await convex.mutation(anyApi.oauth.upsertOAuthAccount, {
            identityId,
            provider:          'google',
            userPrincipalName: googleUser.email,
            msUserId:          googleUser.sub,
        });

        await convex.mutation(anyApi.oauth.upsertOAuthTokens, {
            accountId,
            accessToken:  tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt:    Date.now() + tokenData.expires_in * 1000,
            scopes:       tokenData.scope || GOOGLE_SCOPES,
        });
    } catch (err) {
        console.error('[Google OAuth] Failed to persist to Convex:', err.message || err);
        return res.status(500).send('Authenticated with Google but failed to save account. Please try again.');
    }

    res.send(`
        <h2>&#x2705; Google account connected successfully</h2>
        <p>Signed in as <strong>${googleUser.email}</strong>.</p>
        <p>You can now close this tab.</p>
    `);
});

module.exports = router;
