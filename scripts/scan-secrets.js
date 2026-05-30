#!/usr/bin/env node
'use strict';

/**
 * scripts/scan-secrets.js
 *
 * Lightweight pre-commit secret scanner. Reads staged file contents via git
 * and blocks the commit if obvious secret patterns are found.
 *
 * ── Enable as a git pre-commit hook ──────────────────────────────────────────
 *
 *   cp scripts/scan-secrets.js .git/hooks/pre-commit
 *   chmod +x .git/hooks/pre-commit
 *
 * Or create .git/hooks/pre-commit with:
 *
 *   #!/bin/sh
 *   node scripts/scan-secrets.js
 *
 * ── Run manually against current staged files ─────────────────────────────────
 *
 *   node scripts/scan-secrets.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { execSync } = require('child_process');
const path         = require('path');

// ── Patterns that indicate a real secret value in source ─────────────────────
//
// Kept intentionally simple and high-signal to avoid false positives.
// All patterns are tested against the full staged file content.
//
const PATTERNS = [
    {
        name:  'OpenAI API key (sk-...)',
        // Matches both legacy sk-xxx and new sk-proj-xxx formats.
        regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
    },
    {
        name:  'Telegram bot token (digits:base64url)',
        // Format: 8-10 digits colon 30+ base64url chars — produced by BotFather.
        // Real tokens are ~34 chars after the colon; {30,} avoids off-by-one brittleness.
        regex: /\d{8,10}:[A-Za-z0-9_-]{30,}/,
    },
    {
        name:  'Twilio Account SID (AC...)',
        // Always starts with AC followed by 32 lowercase hex chars.
        regex: /AC[a-f0-9]{32}/,
    },
    {
        name:  'Twilio Auth Token assigned as value',
        // Matches AUTH_TOKEN = <32 hex chars> in env-file or code style.
        regex: /AUTH_TOKEN\s*[=:]\s*['"]?[a-f0-9]{32}['"]?/i,
    },
    {
        name:  'Microsoft client secret assigned as value',
        // Catches MS_CLIENT_SECRET = somevalue in any file format.
        regex: /MS_CLIENT_SECRET\s*[=:]\s*['"]?\S{8,}['"]?/i,
    },
];

// ── File extensions and names to skip ────────────────────────────────────────
const SKIP_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg',
    '.pdf', '.zip', '.tar', '.gz', '.tgz',
    '.lock',
]);

// Always skip the scanner itself and lock files.
const SKIP_BASENAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    path.basename(__filename),
]);

// ── Collect staged files ──────────────────────────────────────────────────────
let stagedFiles;
try {
    const output = execSync('git diff --cached --name-only', { encoding: 'utf8' });
    stagedFiles = output.trim().split('\n').filter(Boolean);
} catch {
    // Not inside a git repository or git is unavailable — nothing to check.
    process.exit(0);
}

if (stagedFiles.length === 0) {
    process.exit(0);
}

// ── Scan each staged file ─────────────────────────────────────────────────────
let blocked = false;

for (const file of stagedFiles) {
    const ext  = path.extname(file).toLowerCase();
    const base = path.basename(file);

    if (SKIP_EXTENSIONS.has(ext) || SKIP_BASENAMES.has(base)) continue;

    // Read the staged (index) version of the file, not the working-tree copy.
    // `git show :path` returns the content as it would be committed.
    let content;
    try {
        content = execSync(`git show :${file}`, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    } catch {
        // File is deleted in this commit or unreadable — skip.
        continue;
    }

    for (const { name, regex } of PATTERNS) {
        if (regex.test(content)) {
            console.error(`[secret-scan] BLOCKED  "${name}" detected in staged file: ${file}`);
            blocked = true;
        }
    }
}

// ── Result ────────────────────────────────────────────────────────────────────
if (blocked) {
    console.error('');
    console.error('[secret-scan] Commit blocked. Remove or rotate the secret(s) listed above.');
    console.error('[secret-scan] If this is a false positive, review scripts/scan-secrets.js.');
    console.error('');
    process.exit(1);
}

console.log('[secret-scan] No obvious secrets detected in staged files. OK.');
process.exit(0);
