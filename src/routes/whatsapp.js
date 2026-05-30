'use strict';

const express            = require('express');
const axios              = require('axios');
const MessagingResponse  = require('twilio').twiml.MessagingResponse;
const { logMessage }     = require('../convexClient');
const { openai }         = require('../openai');
const idempotency        = require('../idempotency');
const { checkLimit }     = require('../rateLimit');

const REPLY_TTL_MS      = 5 * 60 * 1000; // 5 minutes
const WA_RATE_WINDOW_MS = 60_000;         // 1 minute window
const WA_RATE_MAX       = 20;             // max 20 messages per minute per sender

const router = express.Router();

router.post('/sms', async (req, res) => {
    const smsCount    = req.session.counter || 0;
    const messageSid  = req.body.MessageSid;
    const number      = req.body.From.substring(9, req.body.From.length);

    // ── Idempotency guard ─────────────────────────────────────────────────────
    // Twilio retries the webhook if it does not receive a 2xx within ~15 s.
    // Return the cached reply immediately to avoid duplicate OpenAI calls.
    // This check runs before rate limiting so retries are never double-counted.
    const cachedReply = idempotency.get(messageSid);
    if (cachedReply !== undefined) {
        console.log(`[WhatsApp] Duplicate delivery for ${messageSid} — returning cached reply.`);
        const twiml = new MessagingResponse();
        twiml.message(cachedReply);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Rate limit guard ──────────────────────────────────────────────────────
    // Key by the sender's WhatsApp number; fall back to IP when unavailable.
    const rlKey    = req.body.From ? `whatsapp:${req.body.From}` : `ip:${req.ip || 'unknown'}`;
    const rlResult = checkLimit(rlKey, WA_RATE_WINDOW_MS, WA_RATE_MAX);
    if (!rlResult.allowed) {
        console.log(`[WhatsApp] Rate limit exceeded for ${rlKey} — request rejected.`);
        res.setHeader('Retry-After', Math.ceil((rlResult.resetAt - Date.now()) / 1000));
        return res.status(429).send('Too many requests. Please slow down.');
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Log inbound message to Convex (no-op if CONVEX_URL is unset)
    await logMessage({
        channel:       'whatsapp',
        address:       number,
        providerMsgId: messageSid,
        direction:     'inbound',
        text:          req.body.Body,
        rawPayload:    JSON.stringify(req.body),
    });

    let data = await axios.get(process.env.SUBSCRIPTION_API_URL + '/' + number);

    data = data.data.data;



    let subscription;

    console.log(data);

    if (data.subscription.length != 0) {


        subscription = data.subscription[0].sub;
    } else if (data.subscription.length == 0) {

        subscription = -1;
    }


    let message;

    if (subscription == 0) {
        message = "You dont have an active subscription. Please visit our website to view our plans";
    } else if (subscription == -1) {

        //console.log(isNaN(req.body.Body))
        if (isNaN(req.body.Body) == false) {

            message = "Tokens are selected";

            axios.post(process.env.SUBSCRIPTION_API_URL, {
                "contact_no": number,
                "sub": '7',
                "tokens": req.body.Body,
            });

        } else {

            message = "Please give me your required tokens";
        }


    } else {
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: req.body.Body }],
                max_tokens: parseInt(data.subscription[0].tokens),
            });
            message = completion.choices[0].message.content;
        } catch (err) {
            console.error('[OpenAI Error]', err.status || err.message);
            message = "Sorry, I couldn't process your request right now. Please try again later.";
        }
    }

    // Cache reply so retries skip OpenAI and return the same text.
    idempotency.set(messageSid, message, REPLY_TTL_MS);

    // Log outbound reply to Convex (no-op if CONVEX_URL is unset)
    await logMessage({
        channel:       'whatsapp',
        address:       number,
        providerMsgId: `${messageSid}:out`,
        direction:     'outbound',
        text:          message,
        rawPayload:    JSON.stringify({ reply: message, inboundMsgSid: messageSid }),
    });

    req.session.counter = smsCount + 1;

    const twiml = new MessagingResponse();
    twiml.message(message);

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

module.exports = router;
