'use strict';

// Requires src/config.js to have been loaded first so dotenv has run.
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey:       process.env.OPENAI_API_KEY,
    organization: process.env.OPENAI_ORGANIZATION,
});

module.exports = { openai };
