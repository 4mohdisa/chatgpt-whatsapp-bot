# ChatGPT WhatsApp Bot Project Report

## Overview

This repository contains a Node.js webhook service that connects WhatsApp messaging (via Twilio) to an OpenAI model. The bot replies to users in WhatsApp, and enforces access using a subscription and token limit check via an external subscription API.

## Current Repository Structure

1. **server.js** — Single file implementation containing the full webhook, subscription gating, and OpenAI call flow.
2. **package.json** — Dependency manifest.
3. **Readme.md** — Existing documentation.
4. **.env and .env.example** — Runtime configuration and a template.
5. **chat-example.jpeg** — Example screenshot.
6. **node_modules** — Not present. The app is not currently runnable.

## What The App Does Today

1. Receives inbound WhatsApp messages from Twilio via an HTTP webhook endpoint.
2. Looks up subscription status for the sender number using `SUBSCRIPTION_API_URL`.
3. Handles onboarding for new users by asking them to select a token limit.
4. Blocks inactive users and prompts them to upgrade.
5. Sends active users' prompts to OpenAI and returns the response to WhatsApp.

## Tech Stack

1. **Runtime and server** — Node.js, Express, CommonJS modules.
2. **Messaging gateway** — Twilio Programmable Messaging for WhatsApp.
3. **AI** — OpenAI SDK (currently v3.x) with a deprecated model reference (`text-davinci-003`).
4. **Subscription gating** — External REST API (`chatgpt.talhasultan.dev`).
5. **Session handling** — `express-session` in memory.
6. **Database** — Convex reactive database for persistence, scheduled functions, and cron jobs. (Legacy MySQL packages remain but are unused.)

## Current Status

1. Not runnable until dependencies are installed.
2. No lockfile — installs are non-deterministic.
3. Minimal operational hardening — no robust error handling, no rate limiting, no persistence.

## Critical Security Issue

> An OpenAI API key exists in `.env` and is flagged as exposed. **Treat this as compromised.** Revoke and rotate immediately, then ensure secrets never appear in committed files.

## Known Technical Debt

1. Deprecated model usage — migrate to a current chat model.
2. Outdated OpenAI SDK — migrate to the current SDK and API patterns.
3. No structured logging and limited observability.
4. No persistence layer for users, messages, or reminders.
5. Session state in memory — will break across restarts and cannot scale horizontally.

## Planned Direction For The Next Version

**Goal:** Evolve from a simple chat bot into a lightweight reminder assistant (Memorae style).

### Initial MVP Features

1. Capture reminder intents from chat messages.
2. Store reminders in a real database.
3. Create events in Outlook Calendar via Microsoft Graph OAuth.
4. Send confirmations and reminder notifications via Telegram bot delivery.
5. Add a simple web dashboard for authentication, connected accounts, and reminder management.

### Recommended Additions

1. **Convex** for persistence and scheduling — Convex will serve as the reactive database and backend platform, providing:
   - **Data storage** for users, identities (WhatsApp and Telegram), reminders, and deliveries.
   - **Scheduled functions** and **cron jobs** for reminder notifications and outbound message delivery.
   - Real-time reactivity and TypeScript-based queries for type-safe database operations.
2. OpenAI Responses API with structured outputs for reliable reminder extraction.

## Immediate Next Steps

1. Revoke and rotate `OPENAI_API_KEY`, then update `.env.example` to avoid real secrets.
2. Run `npm install` and generate `package-lock.json`.
3. Add basic error handling around subscription API and OpenAI calls.
4. Replace `text-davinci-003` and upgrade OpenAI SDK.
5. Split `server.js` into modules (webhooks, subscriptions, ai, config) to support growth.
6. Decide the MVP delivery channel for reminders — Telegram recommended for fastest outbound notifications.