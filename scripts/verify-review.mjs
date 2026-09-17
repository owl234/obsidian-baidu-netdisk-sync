#!/usr/bin/env node

/**
 * Obsidian Community Plugin Review Verifier
 * Reads credentials from .env or process.env, queries the Obsidian plugin portal,
 * and prints an audit report for the latest release and branch reviews.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Load environment variables from .env if present
function loadEnv() {
  const envPath = resolve(rootDir, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

// Read local manifest.json
let localManifest = { version: 'Unknown', id: 'baidu-netdisk-sync' };
try {
  const manifestPath = resolve(rootDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    localManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  }
} catch {
  // ignore
}

const PLUGIN_URL = process.env.OBS_PLUGIN_URL || 'https://community.obsidian.md/account/plugins/baidu-netdisk-sync';
const OBS_TOKEN = process.env.OBS_TOKEN;
const OBS_STRIPE_MID = process.env.OBS_STRIPE_MID;

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

async function triggerCheckRelease(cookies) {
  const checkUrl = `${PLUGIN_URL}/check-release`;
  try {
    const res = await fetch(checkUrl, {
      headers: {
        'Cookie': cookies.join('; '),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    const text = await res.text();
    if (text.includes('This entry was refreshed in the last few minutes')) {
      console.log(`${colors.dim}ℹ️  Check-release triggered (rate-limit cooldown active).${colors.reset}`);
    } else {
      console.log(`${colors.dim}ℹ️  Check-release triggered successfully.${colors.reset}`);
    }
  } catch {
    // ignore
  }
}

async function main() {
  if (!OBS_TOKEN) {
    console.error(`${colors.red}❌ Error: OBS_TOKEN is not set.${colors.reset}`);
    console.error(`Please set OBS_TOKEN in your .env file or environment variables.`);
    console.error(`Refer to .env.example for guidance.`);
    process.exit(1);
  }

  const cookies = [];
  if (OBS_STRIPE_MID) cookies.push(`__stripe_mid=${OBS_STRIPE_MID}`);
  cookies.push(`obs_token=${OBS_TOKEN}`);

  // If --check or --refresh flag is passed, trigger release check first
  if (process.argv.includes('--check') || process.argv.includes('--refresh')) {
    await triggerCheckRelease(cookies);
  }

  console.log(`${colors.cyan}${colors.bold}🔍 Checking Obsidian Community Plugin Review Status...${colors.reset}`);
  console.log(`${colors.dim}Target URL: ${PLUGIN_URL}${colors.reset}`);
  console.log(`${colors.dim}Local Target Version: ${localManifest.version}${colors.reset}\n`);

  let html;
  try {
    const res = await fetch(PLUGIN_URL, {
      headers: {
        'Cookie': cookies.join('; '),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (res.status === 401 || res.status === 403) {
      console.error(`${colors.red}❌ Authentication Failed (HTTP ${res.status}). Your OBS_TOKEN may be invalid or expired.${colors.reset}`);
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`${colors.red}❌ Request failed with HTTP status ${res.status}${colors.reset}`);
      process.exit(1);
    }
    html = await res.text();
  } catch (err) {
    console.error(`${colors.red}❌ Network error: ${err.message}${colors.reset}`);
    process.exit(1);
  }

  // Extract Next.js payload chunks
  const chunkRegex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/g;
  let fullPayload = '';
  let match;
  while ((match = chunkRegex.exec(html)) !== null) {
    try {
      fullPayload += JSON.parse(`"${match[1]}"`);
    } catch {
      fullPayload += match[1];
    }
  }

  if (!fullPayload) {
    fullPayload = html;
  }

  // 1. Check Top-Level Red Alert Banners
  const criticalBanners = [];
  if (fullPayload.includes('No release matches your manifest version')) {
    const msgMatch = fullPayload.match(/No release matches your manifest version.*?children":"([^"]+)"/);
    const detail = msgMatch ? msgMatch[1] : "Your manifest.json points at a version that doesn't have a matching GitHub release.";
    criticalBanners.push({
      title: 'No release matches your manifest version',
      detail,
    });
  }
  if (fullPayload.includes('The latest release of this entry failed one or more automated checks')) {
    criticalBanners.push({
      title: 'Latest Release Failed Automated Checks',
      detail: 'The latest release of this entry failed one or more automated checks in the Obsidian review portal.',
    });
  }

  // 2. Parse All Audit Runs (distinguishing Release vs Branch/Preview)
  const runMatches = [...fullPayload.matchAll(/(?:Version|Ref).*?"children":"([^"]+)".*?Commit.*?"children":"([a-f0-9]{7,})".*?"children":"(Completed|Failed|Passed|Pending|Approved)"/gs)];
  
  const allRuns = [];
  for (let i = 0; i < runMatches.length; i++) {
    const r = runMatches[i];
    const isVersion = fullPayload.slice(Math.max(0, r.index - 30), r.index + 20).includes('Version');
    const label = r[1];
    const commit = r[2];
    const status = r[3];
    const startPos = r.index;
    const endPos = i + 1 < runMatches.length ? runMatches[i + 1].index : fullPayload.length;
    const slice = fullPayload.slice(startPos, endPos);

    allRuns.push({
      isRelease: isVersion,
      label,
      commit,
      status,
      slice,
    });
  }

  // Find target release run (or latest release run)
  const releaseRuns = allRuns.filter(r => r.isRelease);
  const previewRuns = allRuns.filter(r => !r.isRelease);

  const matchedRelease = releaseRuns.find(r => r.label === localManifest.version) || releaseRuns[0];
  const latestPreview = previewRuns[0];

  // Parse markdown issues from the matched release run (or fallback to latest preview)
  const targetRun = matchedRelease || latestPreview;
  const targetSlice = targetRun ? targetRun.slice : fullPayload;

  const mdRegex = /"markdown":"(.*?)"/g;
  const rawBlocks = [];
  while ((match = mdRegex.exec(targetSlice)) !== null) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      rawBlocks.push(decoded);
    } catch {
      rawBlocks.push(match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
  }

  // Extract referenced RSC template strings (e.g. $47 -> 47:T...,)
  const referencedIds = [...targetSlice.matchAll(/\$([a-f0-9]{1,4})\b/g)].map(m => m[1]);
  for (const refId of referencedIds) {
    const refPat = new RegExp(`${refId}:T[a-f0-9]+,(.*?)(?=\\n\\w+:|$)`, 's');
    const refMatch = fullPayload.match(refPat);
    if (refMatch) {
      let text = refMatch[1];
      const jsonBoundary = text.search(/\d+[a-z0-9]?:\[/);
      if (jsonBoundary !== -1) {
        text = text.slice(0, jsonBoundary);
      }
      const decoded = text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      rawBlocks.push(decoded);
    }
  }

  // Deduplicate blocks
  const uniqueBlocks = [];
  const seen = new Set();
  for (const b of rawBlocks) {
    const trimmed = b.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      uniqueBlocks.push(trimmed);
    }
  }

  const parsedItems = [];
  for (const block of uniqueBlocks) {
    const lines = block.split('\n');
    let currentItem = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('**Error**:')) {
        currentItem = { type: 'Error', text: trimmed, details: [] };
        parsedItems.push(currentItem);
      } else if (trimmed.includes('**Warning**:')) {
        currentItem = { type: 'Warning', text: trimmed, details: [] };
        parsedItems.push(currentItem);
      } else if (trimmed.includes('**Recommendation**:')) {
        currentItem = { type: 'Recommendation', text: trimmed, details: [] };
        parsedItems.push(currentItem);
      } else if (trimmed.includes('**Pass**:')) {
        currentItem = { type: 'Pass', text: trimmed, details: [] };
        parsedItems.push(currentItem);
      } else if (currentItem && trimmed.startsWith('- ')) {
        const cleanDetail = trimmed.replace(/\d+[a-f0-9]?:\[.*$/, '').trim();
        if (cleanDetail) {
          currentItem.details.push(cleanDetail);
        }
      }
    }
  }

  // Deduplicate items
  const seenItems = new Set();
  const categories = {
    errors: [],
    warnings: [],
    recommendations: [],
    passes: [],
  };

  for (const item of parsedItems) {
    const key = `${item.type}:${item.text}:${item.details.join('|')}`;
    if (!seenItems.has(key)) {
      seenItems.add(key);
      if (item.type === 'Error') categories.errors.push(item);
      else if (item.type === 'Warning') categories.warnings.push(item);
      else if (item.type === 'Recommendation') categories.recommendations.push(item);
      else if (item.type === 'Pass') categories.passes.push(item);
    }
  }

  // Print Summary Header
  console.log('='.repeat(65));
  console.log(`${colors.bold}📦 Plugin:${colors.reset} baidu-netdisk-sync`);
  console.log(`${colors.bold}🎯 Local Manifest Version:${colors.reset} ${localManifest.version}`);

  if (matchedRelease) {
    console.log(`${colors.bold}🔖 Latest Scanned Release:${colors.reset} ${matchedRelease.label} (${matchedRelease.commit}) -> ${matchedRelease.status}`);
  } else {
    console.log(`${colors.bold}🔖 Latest Scanned Release:${colors.reset} ${colors.yellow}None found in portal${colors.reset}`);
  }

  if (latestPreview) {
    console.log(`${colors.bold}🌿 Branch Preview Review:${colors.reset} ${latestPreview.label} (${latestPreview.commit}) -> ${latestPreview.status}`);
  }

  let finalStatus = targetRun ? targetRun.status : 'Unknown';
  let statusBadge = finalStatus;
  if (finalStatus === 'Passed' || finalStatus === 'Approved' || finalStatus === 'Completed') {
    statusBadge = `${colors.bgGreen}${colors.bold} ${finalStatus.toUpperCase()} ${colors.reset}`;
  } else if (finalStatus === 'Failed') {
    statusBadge = `${colors.bgRed}${colors.bold} ${finalStatus.toUpperCase()} ${colors.reset}`;
  } else {
    statusBadge = `${colors.yellow}${colors.bold} ${finalStatus.toUpperCase()} ${colors.reset}`;
  }
  console.log(`${colors.bold}🚦 Target Run Status:${colors.reset} ${statusBadge}`);
  console.log('='.repeat(65));

  // Print Critical Alert Banners
  if (criticalBanners.length > 0) {
    console.log(`\n${colors.red}${colors.bold}🛑 CRITICAL REPOSITORY BANNERS (${criticalBanners.length}):${colors.reset}`);
    for (const b of criticalBanners) {
      console.log(`  ${colors.red}• ${b.title}${colors.reset}`);
      console.log(`    ${colors.dim}${b.detail}${colors.reset}`);
    }
  }

  // Print Errors
  if (categories.errors.length > 0) {
    console.log(`\n${colors.red}${colors.bold}🚨 AUDIT ERRORS (${categories.errors.length}) - MUST FIX FOR APPROVAL:${colors.reset}`);
    for (const err of categories.errors) {
      console.log(`  ${colors.red}• ${err.text.replace(/^-\s*/, '')}${colors.reset}`);
      for (const d of err.details) {
        console.log(`    ${colors.dim}${d}${colors.reset}`);
      }
    }
  }

  // Print Warnings
  if (categories.warnings.length > 0) {
    console.log(`\n${colors.yellow}${colors.bold}⚠️  WARNINGS (${categories.warnings.length}):${colors.reset}`);
    for (const warn of categories.warnings) {
      console.log(`  ${colors.yellow}• ${warn.text.replace(/^-\s*/, '')}${colors.reset}`);
      for (const d of warn.details) {
        console.log(`    ${colors.dim}${d}${colors.reset}`);
      }
    }
  }

  // Print Passes
  if (categories.passes.length > 0) {
    console.log(`\n${colors.green}${colors.bold}✅ PASSED AUDITS (${categories.passes.length}):${colors.reset}`);
    for (const p of categories.passes) {
      console.log(`  ${colors.green}• ${p.text.replace(/^-\s*/, '')}${colors.reset}`);
    }
  }

  console.log('\n' + '='.repeat(65));

  const hasCriticalFailure = criticalBanners.length > 0 || categories.errors.length > 0 || finalStatus === 'Failed';

  if (hasCriticalFailure) {
    console.log(`${colors.red}❌ Verification Failed: Action required before community distribution can succeed.${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`${colors.green}✨ Verification Succeeded: All checks passed!${colors.reset}\n`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
