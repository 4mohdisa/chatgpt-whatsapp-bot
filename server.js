'use strict';

// Must be required first: loads dotenv and runs the env preflight check.
require('./src/config');

const http    = require('http');
const express = require('express');
const session = require('express-session');

const whatsappRouter = require('./src/routes/whatsapp');
const telegramRouter = require('./src/routes/telegram');
const outlookRouter  = require('./src/routes/outlook');
const googleRouter   = require('./src/routes/google');
const adminRouter    = require('./src/routes/admin');

// Warn early if Telegram token is absent (Telegram replies will be skipped).
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN not set — Telegram replies disabled.');
}

const app = express();

// Trust the specified number of proxy hops (or a specific IP/range) so that
// req.ip reflects the real client address when behind nginx, Heroku, Railway, etc.
// Set TRUST_PROXY=1 for a single reverse proxy; leave unset when running directly.
if (process.env.TRUST_PROXY) {
    const raw = process.env.TRUST_PROXY;
    const n   = Number(raw);
    app.set('trust proxy', Number.isNaN(n) ? raw : n);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'anything-you-want-but-keep-secret' }));

app.get('/', (req, res) => {
    res.send('Running............');
});

app.use(whatsappRouter);
app.use(telegramRouter);
app.use(outlookRouter);
app.use(googleRouter);
app.use(adminRouter);

http.createServer(app).listen(process.env.PORT || 3000, () => {
    console.log('Express server listening on port 3000');
});
