// Delete OpenStore discounts, with flags. DRY RUN by default — pass --confirm to actually delete.
//
// Pick exactly one target:
//   --status=draft          delete all draft / unpublished discounts
//   --status=published      delete all published discounts
//   --all                   delete ALL discounts (every status)
//   --codes=A,B,C           delete these specific codes
//   --codes-file=path       delete codes listed in a file (one per line)
//
// Options:
//   --confirm               actually delete (default: just report counts)
//   --merchantId= --cookie= --baseUrl=   (else taken from .env)
//
// Examples:
//   node ./src/cli-delete.mjs --status=draft                 # dry run: how many drafts
//   node ./src/cli-delete.mjs --status=draft --confirm       # delete all drafts
//   node ./src/cli-delete.mjs --codes=SAVE10,WELCOME --confirm
import fs from 'node:fs';
import { OpenStoreClient } from './openstore-client.mjs';
import { loadDotEnv, parseArgs, sleep } from './utils.mjs';

function printHelp() {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { printHelp(); return; }

  await loadDotEnv(cwd);
  const args = parseArgs(argv);
  const merchantId = args.merchantId ?? process.env.OPENSTORE_MERCHANT_ID;
  const cookie = args.cookie ?? process.env.OPENSTORE_COOKIE;
  const baseUrl = args.baseUrl ?? process.env.OPENSTORE_BASE_URL ?? 'https://gkx.gokwik.co';
  if (!merchantId || !cookie) { console.error('Error: OPENSTORE_MERCHANT_ID and OPENSTORE_COOKIE required (in .env or as --merchantId/--cookie).'); process.exit(1); }

  // Resolve target mode
  const isAll = args.all === true || args.all === 'true';
  const status = args.status; // 'draft' | 'published' | undefined
  let codes = null;
  if (args.codes) codes = String(args.codes).split(',').map((c) => c.trim()).filter(Boolean);
  else if (args['codes-file']) codes = fs.readFileSync(args['codes-file'], 'utf8').split(/\r?\n/).map((c) => c.trim()).filter(Boolean);

  const modes = [isAll && 'all', status && `status:${status}`, codes && `codes:${codes.length}`].filter(Boolean);
  if (modes.length !== 1) { console.error('Error: choose exactly ONE target: --status=draft|published, --all, --codes=..., or --codes-file=...'); process.exit(1); }
  if (status && !['draft', 'published'].includes(status)) { console.error("Error: --status must be 'draft' or 'published'."); process.exit(1); }

  const confirm = args.confirm === true || args.confirm === 'true';
  const client = new OpenStoreClient({ merchantId, cookies: [cookie], baseUrl });
  console.log(`Merchant: ${merchantId} | mode: ${modes[0]} | ${confirm ? 'DELETE (--confirm)' : 'DRY RUN'}`);

  // ---- resolve target discount ids ----
  const targets = []; // {id, code, status}
  if (codes) {
    for (const code of codes) {
      const rows = await client.fetchDiscountsPage({ search: code, limit: 20 });
      for (const x of rows) if ((x.code || '').toUpperCase() === code.toUpperCase()) targets.push({ id: x.id, code: x.code, status: x.status });
    }
    const found = new Set(targets.map((t) => t.code.toUpperCase()));
    const missing = codes.filter((c) => !found.has(c.toUpperCase()));
    console.log(`Codes requested: ${codes.length} | found in OS: ${targets.length}${missing.length ? ` | not found: ${missing.length}` : ''}`);
  } else {
    // status / all: page through (fetchStatus undefined = every status)
    const fetchStatus = isAll ? undefined : status;
    let page = 1;
    while (true) {
      const rows = await client.fetchDiscountsPage({ status: fetchStatus, page, limit: 100 });
      for (const x of rows) targets.push({ id: x.id, code: x.code, status: x.status });
      if (rows.length < 100) break;
      page += 1;
      if (page % 20 === 0) console.log(`  ...scanned ${targets.length}`);
      if (page > 5000) { console.log('  (stopped scan at 500k)'); break; }
    }
    console.log(`Discounts matching ${modes[0]}: ${targets.length}`);
  }

  if (targets.length === 0) { console.log('Nothing to delete.'); return; }
  if (!confirm) {
    console.log('DRY RUN — sample:', targets.slice(0, 10).map((t) => t.code));
    console.log(`Pass --confirm to delete ${targets.length} discount(s).`);
    return;
  }

  // ---- delete in batches of 100 (bulk soft-delete) ----
  let deleted = 0, failed = 0;
  const ids = targets.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const res = await client.bulkDeleteDiscounts(batch);
      deleted += (res.data?.updated || batch).length;
    } catch (e) {
      failed += batch.length;
      console.log(`  batch ${i / 100 + 1} FAILED: ${e.message.slice(0, 120)}`);
    }
    console.log(`  deleted ${Math.min(i + 100, ids.length)}/${ids.length}`);
    await sleep(300);
  }
  console.log(`\nDone. deleted=${deleted} failed=${failed}`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
