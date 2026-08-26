import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadDotEnv(cwd) {
  const envPath = path.join(cwd, '.env');

  try {
    const content = await readFile(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const equalsIndex = line.indexOf('=');
      if (equalsIndex === -1) {
        continue;
      }

      const key = line.slice(0, equalsIndex).trim();
      const value = line.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export function parseArgs(argv) {
  const args = { _: [] };

  for (const entry of argv) {
    if (!entry.startsWith('--')) {
      args._.push(entry);
      continue;
    }

    const [flag, value = 'true'] = entry.slice(2).split('=');
    args[flag] = value;
  }

  return args;
}

export function requireValue(label, value) {
  if (!value) {
    throw new Error(`Missing required configuration: ${label}`);
  }

  return value;
}

export function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }

  return parsed;
}

export function slugifyMerchant(input) {
  return input
    .toLowerCase()
    .replace(/\.myshopify\.com$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.-]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function daysAgoIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, value) {
  await writeFile(filePath, value, 'utf8');
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compact(array) {
  return array.filter(Boolean);
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}
