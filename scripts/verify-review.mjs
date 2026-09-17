#!/usr/bin/env node

/**
 * Obsidian Community Plugin Review Verifier
 * Reads credentials from .env or process.env, queries the Obsidian plugin portal,
 * and prints an audit report for the latest (or specified) plugin release.
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

async function main() {
  if (!OBS_TOKEN) {
    console.error(`${colors.red}❌ Error: OBS_TOKEN is not set.${colors.reset}`);
    console.error(`Please set OBS_TOKEN in your .env file or environment variables.`);
    console.error(`Refer to .env.example for guidance.`);
    process.exit(1);
  }

  console.log(`${colors.cyan}${colors.bold}🔍 Checking Obsidian Community Plugin Review Status...${colors.reset}`);
  console.log(`${colors.dim}Target URL: ${PLUGIN_URL}${colors.reset}\n`);

  const cookies = [];
  if (OBS_STRIPE_MID) cookies.push(`__stripe_mid=${OBS_STRIPE_MID}`);
  cookies.push(`obs_token=${OBS_TOKEN}`);

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

  // Parse Version, Commit, and Status
  // Pattern example: ["Version",":"," ",[...,"1.0.7"]],["Commit",":"," ",[...,"96b0e16"]],[...,"Failed"]
  const versionMatches = [...fullPayload.matchAll(/Version.*?"children":"([^"]+)".*?Commit.*?"children":"([^"]+)".*?"children":"(Failed|Passed|Pending|Approved)"/gs)];
  
  let latestVersion = 'Unknown';
  let latestCommit = 'Unknown';
  let overallStatus = 'Unknown';

  if (versionMatches.length > 0) {
    latestVersion = versionMatches[0][1];
    latestCommit = versionMatches[0][2];
    overallStatus = versionMatches[0][3];
  } else {
    // Fallback search
    const verMatch = fullPayload.match(/Version.*?(\d+\.\d+\.\d+)/);
    if (verMatch) latestVersion = verMatch[1];
    const statusMatch = fullPayload.match(/(Failed|Passed|Approved|Pending)/);
    if (statusMatch) overallStatus = statusMatch[1];
  }

  // Extract markdown issue blocks
  const mdRegex = /"markdown":"(.*?)"/g;
  const rawBlocks = [];
  while ((match = mdRegex.exec(fullPayload)) !== null) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      rawBlocks.push(decoded);
    } catch {
      rawBlocks.push(match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
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
        currentItem.details.push(trimmed);
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
  console.log(`${colors.bold}🔖 Latest Audited Version:${colors.reset} ${latestVersion} (${latestCommit})`);
  
  let statusBadge = overallStatus;
  if (overallStatus === 'Passed' || overallStatus === 'Approved') {
    statusBadge = `${colors.bgGreen}${colors.bold} ${overallStatus.toUpperCase()} ${colors.reset}`;
  } else if (overallStatus === 'Failed') {
    statusBadge = `${colors.bgRed}${colors.bold} ${overallStatus.toUpperCase()} ${colors.reset}`;
  } else {
    statusBadge = `${colors.yellow}${colors.bold} ${overallStatus.toUpperCase()} ${colors.reset}`;
  }
  console.log(`${colors.bold}🚦 Review Status:${colors.reset} ${statusBadge}`);
  console.log('='.repeat(65));

  // Print Errors
  if (categories.errors.length > 0) {
    console.log(`\n${colors.red}${colors.bold}🚨 ERRORS (${categories.errors.length}) - MUST FIX FOR APPROVAL:${colors.reset}`);
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

  // Print Recommendations
  if (categories.recommendations.length > 0) {
    console.log(`\n${colors.blue}${colors.bold}💡 RECOMMENDATIONS (${categories.recommendations.length}):${colors.reset}`);
    for (const rec of categories.recommendations) {
      console.log(`  ${colors.blue}• ${rec.text.replace(/^-\s*/, '')}${colors.reset}`);
      for (const d of rec.details) {
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

  if (overallStatus === 'Failed' || categories.errors.length > 0) {
    console.log(`${colors.red}❌ Verification Failed: Release contains errors that violate Obsidian guidelines.${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`${colors.green}✨ Verification Succeeded: All critical checks passed!${colors.reset}\n`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
