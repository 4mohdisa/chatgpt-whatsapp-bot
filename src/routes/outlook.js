'use strict';

const express                        = require('express');
const axios                          = require('axios');
const { convex, anyApi }             = require('../convexClient');
const { missingMicrosoftVars }       = require('../config');

const MS_SCOPES = 'openid profile email offline_access User.Read Calendars.ReadWrite';

const router = express.Router();

/**
 * GET /connect/outlook?identityId=<convex_identity_id>
 *
 * Validates the identityId in Convex, then redirects the user to the
 * Microsoft consent screen. The identityId is carried through the OAuth
 * state parameter so the callback can link the account.
 *
 * Required env vars: MS_CLIENT_ID, MS_REDIRECT_URI
 * Optional env var:  MS_TENANT (defaults to "common")
 */
router.get('/connect/outlook', async (req, res) => {
    const { identityId } = req.query;

    if (!identityId) {
        return res.status(400).send('Missing required query param: identityId');
    }

    if (!convex) {
        return res.status(503).send('Convex is not configured. Set CONVEX_URL to enable OAuth.');
    }

    const missing = missingMicrosoftVars();
    if (missing.length > 0) {
        return res.status(503).send(`Microsoft OAuth is not configured. Missing vars: ${missing.join(', ')}`);
    }

    const MS_CLIENT_ID    = process.env.MS_CLIENT_ID;
    const MS_TENANT       = process.env.MS_TENANT || 'common';
    const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI;

    // Validate identityId exists before redirecting
    let identity;
    try {
        identity = await convex.query(anyApi.identities.getById, { identityId });
    } catch (err) {
        console.error('[OAuth] Identity lookup failed:', err.message || err);
        return res.status(500).send('Failed to validate identity. Please try again.');
    }

    if (!identity) {
        return res.status(400).send('Unknown identityId. Please send a message via WhatsApp or Telegram first to register.');
    }

    // Encode identityId in state to recover it in the callback
    const state = Buffer.from(JSON.stringify({ identityId })).toString('base64url');

    const authUrl = new URL(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id',     MS_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri',  MS_REDIRECT_URI);
    authUrl.searchParams.set('scope',         MS_SCOPES);
    authUrl.searchParams.set('state',         state);
    authUrl.searchParams.set('response_mode', 'query');

    res.redirect(authUrl.toString());
});

/**
 * GET /auth/outlook/callback
 *
 * Microsoft redirects here after the user consents. Exchanges the code for
 * tokens, fetches the user profile from Graph /me, and persists the linked
 * oauth_account + oauth_tokens rows in Convex.
 *
 * Required env vars: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI
 * Optional env var:  MS_TENANT (defaults to "common")
 */
router.get('/auth/outlook/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
        console.error('[OAuth] Microsoft returned error:', error, error_description);
        return res.status(400).send(`Microsoft OAuth error: ${error} — ${error_description || 'No description'}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state in callback.');
    }

    if (!convex) {
        return res.status(503).send('Convex is not configured.');
    }

    const missingCb = missingMicrosoftVars();
    if (missingCb.length > 0) {
        return res.status(503).send(`Microsoft OAuth is not fully configured. Missing vars: ${missingCb.join(', ')}`);
    }

    const MS_CLIENT_ID     = process.env.MS_CLIENT_ID;
    const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
    const MS_TENANT        = process.env.MS_TENANT || 'common';
    const MS_REDIRECT_URI  = process.env.MS_REDIRECT_URI;

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
            `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id:     MS_CLIENT_ID,
                client_secret: MS_CLIENT_SECRET,
                code,
                redirect_uri:  MS_REDIRECT_URI,
                grant_type:    'authorization_code',
                scope:         MS_SCOPES,
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        tokenData = tokenRes.data;
    } catch (err) {
        console.error('[OAuth] Token exchange failed:', err.response?.data || err.message);
        return res.status(502).send('Failed to exchange authorization code for tokens. Please try again.');
    }

    // ── 3. Extract tenant ID from access token JWT payload ────────────────────
    let tenantId;
    try {
        const payload = JSON.parse(
            Buffer.from(tokenData.access_token.split('.')[1], 'base64').toString('utf8')
        );
        tenantId = payload.tid;
    } catch (_) {
        // Non-fatal: tenantId is optional in the schema
    }

    // ── 4. Fetch user profile from Microsoft Graph ────────────────────────────
    let msUser;
    try {
        const meRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        msUser = meRes.data;
    } catch (err) {
        console.error('[OAuth] Graph /me failed:', err.response?.data || err.message);
        return res.status(502).send('Failed to fetch Microsoft profile. Please try again.');
    }

    // ── 5. Persist oauth_account + oauth_tokens in Convex ────────────────────
    try {
        const accountId = await convex.mutation(anyApi.oauth.upsertOAuthAccount, {
            identityId,
            provider:          'microsoft',
            tenantId,
            userPrincipalName: msUser.userPrincipalName,
            msUserId:          msUser.id,
        });

        await convex.mutation(anyApi.oauth.upsertOAuthTokens, {
            accountId,
            accessToken:  tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt:    Date.now() + tokenData.expires_in * 1000,
            scopes:       tokenData.scope || MS_SCOPES,
        });
    } catch (err) {
        console.error('[OAuth] Failed to persist to Convex:', err.message || err);
        return res.status(500).send('Authenticated with Microsoft but failed to save account. Please try again.');
    }

    res.send(`
        <h2>&#x2705; Outlook connected successfully</h2>
        <p>Signed in as <strong>${msUser.userPrincipalName}</strong>.</p>
        <p>You can now close this tab.</p>
    `);
});

module.exports = router;
