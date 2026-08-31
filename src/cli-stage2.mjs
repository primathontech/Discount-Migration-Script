import path from 'node:path';
import fs from 'node:fs/promises';
import { OpenStoreClient } from './openstore-client.mjs';
import { migrateStage2, printMigrationSummary } from './migrate-stage2.mjs';
import { loadIdMapping, generateMappingTemplate, IdMapping } from './id-mapping.mjs';
import { MigrationLedger, resetLedgerFile } from './migration-ledger.mjs';
import { loadDotEnv, parseArgs, ensureDir, timestampForFilename, writeJson, sleep } from './utils.mjs';
import { writeXlsxReport } from './xlsx-report.mjs';

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);

  if (argv.includes('--help')) {
    printHelp();
    return;
  }

  await loadDotEnv(cwd);
  const args = parseArgs(argv);

  // Required parameters
  const merchantId = args.merchantId ?? process.env.OPENSTORE_MERCHANT_ID;
  const cookie = args.cookie ?? process.env.OPENSTORE_COOKIE;
  const inputFile = args.input ?? args._[0];

  if (!merchantId) {
    console.error('Error: --merchantId or OPENSTORE_MERCHANT_ID is required');
    process.exit(1);
  }

  if (!cookie) {
    console.error('Error: --cookie or OPENSTORE_COOKIE is required');
    process.exit(1);
  }

  if (!inputFile) {
    console.error('Error: Input file path is required');
    console.error('Usage: node ./src/cli-stage2.mjs <input-file.json> --merchantId=xxx --cookie=xxx');
    process.exit(1);
  }

  // Load extracted discounts
  console.log(`Loading discounts from ${inputFile}...`);
  const inputPath = path.isAbsolute(inputFile) ? inputFile : path.join(cwd, inputFile);

  let extraction;
  try {
    const content = await fs.readFile(inputPath, 'utf-8');
    extraction = JSON.parse(content);
  } catch (error) {
    console.error(`Error reading input file: ${error.message}`);
    process.exit(1);
  }

  const discounts = extraction.discounts;
  if (!discounts || discounts.length === 0) {
    console.error('No discounts found in input file');
    process.exit(1);
  }

  console.log(`Found ${discounts.length} discounts to migrate`);
  console.log(`Merchant ID: ${merchantId}`);

  // Generate mapping template if requested
  if (args.generateMapping) {
    const csvContent = generateMappingTemplate(discounts);
    const mappingPath = path.join(path.dirname(inputPath), 'id_mapping_template.csv');
    await fs.writeFile(mappingPath, csvContent, 'utf-8');

    // Count entries
    const lines = csvContent.trim().split('\n');
    const collections = lines.filter(l => l.startsWith('collection,')).length;
    const products = lines.filter(l => l.startsWith('product,')).length;
    const variants = lines.filter(l => l.startsWith('variant,')).length;

    console.log(`\nGenerated ID mapping template: ${mappingPath}`);
    console.log(`Collections to map: ${collections}`);
    console.log(`Products to map: ${products}`);
    console.log(`Variants to map: ${variants}`);
    console.log('\nCSV format: type,shopify_id,openstore_id,title');
    console.log('Fill in the openstore_id column and save as id_mapping.csv');
    return;
  }

  // Load ID mapping if provided
  const mappingFile = args.mapping ?? process.env.OPENSTORE_ID_MAPPING;
  let idMapping;
  if (mappingFile) {
    const mappingPath = path.isAbsolute(mappingFile) ? mappingFile : path.join(process.cwd(), mappingFile);
    idMapping = await loadIdMapping(mappingPath);
    const summary = idMapping.getSummary();
    console.log(`Loaded ID mapping: ${summary.collections} collections, ${summary.products} products, ${summary.variants} variants`);
  } else {
    // Products/variants need no mapping (OS reuses Shopify ids). Collections DO — they are
    // loaded live from the OS /collections endpoint below.
    idMapping = new IdMapping();
  }

  // Optional: filter by status
  const statusFilter = args.status ?? 'ready';
  let filteredDiscounts = statusFilter === 'all'
    ? discounts
    : discounts.filter(d => d.migration_status === statusFilter);

  if (filteredDiscounts.length !== discounts.length) {
    console.log(`Filtered to ${filteredDiscounts.length} discounts with status: ${statusFilter}`);
  }

  // Optional: --code=XYZ migrates only discounts whose code OR title matches (case-insensitive substring)
  if (args.code) {
    const needle = String(args.code).toLowerCase();
    const before = filteredDiscounts.length;
    filteredDiscounts = filteredDiscounts.filter(d => {
      const inTitle = (d.title ?? '').toLowerCase().includes(needle);
      const inCodes = (d.codes ?? []).some(c => (c.code ?? '').toLowerCase().includes(needle));
      return inTitle || inCodes;
    });
    console.log(`--code=${args.code}: filtered from ${before} to ${filteredDiscounts.length} discount(s)`);
    for (const d of filteredDiscounts) {
      console.log(`  match: "${d.title}" [codes: ${(d.codes ?? []).map(c => c.code).join(', ')}]`);
    }
  }

  // Optional: --active-only restricts to Shopify ACTIVE discounts and excludes auto-generated FBT-BUNDLE-P-* bundles
  if (args['active-only'] === 'true' || args.activeOnly === 'true') {
    const before = filteredDiscounts.length;
    filteredDiscounts = filteredDiscounts.filter(d =>
      d.status === 'ACTIVE' && !d.title?.startsWith('FBT-BUNDLE-P-'),
    );
    console.log(`--active-only: filtered from ${before} to ${filteredDiscounts.length} discounts (ACTIVE + non-FBT)`);
  }

  // Process discounts WITH a real code before codeless ones. Some Shopify discounts appear twice
  // (a real coded one + a codeless "title-as-code" twin with the same effective code). Creating
  // the real coded one first makes it win the code slot (published); the codeless twin then 409s,
  // instead of the codeless draft grabbing the slot and stranding the real one as draft.
  const hasRealCode = (d) => (d.codes && d.codes.length > 0);
  filteredDiscounts = [...filteredDiscounts].sort((a, b) => (hasRealCode(a) === hasRealCode(b) ? 0 : (hasRealCode(a) ? -1 : 1)));

  // Optional: limit number of discounts
  const limit = args.limit ? parseInt(args.limit, 10) : null;
  if (limit && limit > 0) {
    filteredDiscounts = filteredDiscounts.slice(0, limit);
    console.log(`Limited to first ${limit} discount(s)`);
  }

  // Dry run mode
  const dryRun = args.dryRun === 'true' || args.dryRun === true;
  if (dryRun) {
    console.log('\n=== DRY RUN MODE ===');
    console.log('No discounts will be created. Remove --dryRun to execute.\n');

    let singleCode = 0;
    let multiCode = 0;
    for (const d of filteredDiscounts) {
      if (d.code_count > 1) {
        multiCode++;
      } else {
        singleCode++;
      }
    }

    console.log(`Would create:`);
    console.log(`  - ${singleCode} single-code discounts`);
    console.log(`  - ${multiCode} discount sets (multi-code)`);
    return;
  }

  // Collect cookies: primary OPENSTORE_COOKIE plus optional OPENSTORE_COOKIE_2..N
  // for round-robin rotation when one is throttled.
  const cookies = [cookie];
  for (let i = 2; i <= 10; i++) {
    const extra = process.env[`OPENSTORE_COOKIE_${i}`];
    if (extra && extra.trim()) cookies.push(extra.trim());
  }
  if (cookies.length > 1) {
    console.log(`Cookies: ${cookies.length} loaded (rotation enabled)`);
  } else {
    console.log('Cookies: 1 loaded (no rotation)');
  }

  // Initialize client
  const client = new OpenStoreClient({
    merchantId,
    cookies,
    baseUrl: args.baseUrl ?? process.env.OPENSTORE_BASE_URL ?? 'https://gkx.gokwik.co',
    maxRetries: parseInt(args.maxRetries ?? process.env.OPENSTORE_MAX_RETRIES ?? '6', 10),
    baseBackoffMs: parseInt(args.baseBackoffMs ?? process.env.OPENSTORE_BASE_BACKOFF_MS ?? '5000', 10),
    maxBackoffMs: parseInt(args.maxBackoffMs ?? process.env.OPENSTORE_MAX_BACKOFF_MS ?? '60000', 10),
  });

  const config = {
    delayMs: parseInt(args.delay ?? '100', 10),
    concurrency: parseInt(args.concurrency ?? '1', 10),
    // --skip-sets: defer multi-code discount sets (they expand to 1 discount per code).
    skipSets: args['skip-sets'] === 'true' || args.skipSets === 'true',
    // --skip-customer-specific: defer customer-specific discounts (handled after phone fetch).
    skipCustomerSpecific: args['skip-customer-specific'] === 'true' || args.skipCustomerSpecific === 'true',
  };

  // Collection scoping needs Shopify->OS collection id translation (OS assigns its own
  // collection ids; the Shopify id is stored as `external_id`). Load it live from OS so
  // collection-scoped discounts point at the correct OS collection instead of a dead id.
  if (!idMapping) idMapping = new IdMapping();
  if (Object.keys(idMapping.collections).length === 0) {
    try {
      const collMap = await client.fetchCollectionMap();
      idMapping.collections = { ...collMap, ...idMapping.collections };
      console.log(`Loaded ${Object.keys(collMap).length} OS collections for Shopify->OS collection id mapping.`);
    } catch (e) {
      console.warn(`WARN: could not load OS collections (${e.message}). Collection-scoped discounts will fall back to all-products.`);
    }
  }

  // Customer-specific discounts: OS uses its own customer UUIDs (not Shopify ids). Resolve
  // each referenced customer by EMAIL against OS; create the customer if missing (unless
  // --no-create-customers). Build Shopify customerId -> OS UUID into idMapping.customers.
  const createMissing = args['create-customers'] !== 'false' && args.createCustomers !== 'false';
  const uniqueCustomers = new Map(); // shopifyId -> {email, phone, firstName, lastName, name}
  for (const d of (config.skipCustomerSpecific ? [] : filteredDiscounts)) {
    if (d.customer_selection?.type !== 'specific_customers') continue;
    for (const c of (d.customer_selection.customers || [])) {
      const sid = String(c.id || '').match(/(\d+)$/)?.[1];
      if (!sid || uniqueCustomers.has(sid)) continue;
      const dn = c.display_name || '';
      uniqueCustomers.set(sid, {
        email: c.email || null,
        phone: c.phone || null,
        firstName: c.first_name || dn.split(' ')[0] || '',
        lastName: c.last_name || dn.split(' ').slice(1).join(' ') || '',
        name: dn || null,
      });
    }
  }
  if (uniqueCustomers.size > 0) {
    console.log(`Resolving ${uniqueCustomers.size} unique customer(s) for customer-specific discounts...`);
    let found = 0, created = 0, failed = 0;
    for (const [sid, info] of uniqueCustomers) {
      try {
        let cust = await client.findCustomer({ email: info.email, phone: info.phone });
        // OS create requires a PHONE (email is optional), so gate creation on phone — this
        // also covers customers who have no email but do have a phone (e.g. from the address).
        if (!cust && createMissing && info.phone) {
          cust = await client.createCustomer(info);
          if (cust?.id) created++;
        } else if (cust?.id) {
          found++;
        }
        if (cust?.id) idMapping.customers[sid] = cust.id;
        else { failed++; console.warn(`  WARN customer unresolved (shopify ${sid}, ${info.email || 'no-email'})`); }
      } catch (e) {
        failed++;
        console.warn(`  WARN customer resolve failed (shopify ${sid}, ${info.email || 'no-email'}): ${e.message}`);
      }
      await sleep(config.delayMs > 0 ? config.delayMs : 100);
    }
    console.log(`Customers: found ${found}, created ${created}, unresolved ${failed}.`);
  }

  // Set up the migration ledger (persistent skip-list of already-migrated shopify_ids).
  // Lives next to the input file so it stays merchant-specific.
  const ledgerPath = path.join(path.dirname(inputPath), '.migrated.jsonl');
  if (args.resetLedger === 'true' || args.resetLedger === true) {
    await resetLedgerFile(ledgerPath);
    console.log(`Ledger reset: ${ledgerPath}`);
  }
  const ledger = new MigrationLedger(ledgerPath);
  await ledger.load();
  // A targeted --code run means "(re)create just this one" (e.g. delete one in the dashboard,
  // then recreate it). The resume ledger would skip an already-migrated code, so bypass it here
  // — 409 still guards against a genuine duplicate that still exists in OS.
  const bypassLedger = !!args.code;
  if (bypassLedger) {
    console.log('Ledger: bypassed for --code run (will (re)create the matched discount(s)).');
  } else if (ledger.size() > 0) {
    console.log(`Ledger: ${ledger.size()} discount(s) already migrated, will be skipped.`);
  } else {
    console.log(`Ledger: empty (new ledger at ${ledgerPath})`);
  }

  // Run migration
  console.log('\nStarting migration...\n');
  let results;
  try {
    results = await migrateStage2({
      client,
      discounts: filteredDiscounts,
      config,
      idMapping,
      ledger: bypassLedger ? null : ledger,
    });
  } finally {
    await ledger.close();
  }

  // Print summary
  printMigrationSummary(results);

  // Save results
  const outputDir = path.dirname(inputPath);
  const timestamp = timestampForFilename();
  const resultsPath = path.join(outputDir, `migration_results_${timestamp}.json`);

  await writeJson(resultsPath, {
    input_file: inputFile,
    merchant_id: merchantId,
    migrated_at: new Date().toISOString(),
    summary: {
      total: filteredDiscounts.length,
      successful: results.successful.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
    },
    results,
  });

  console.log(`\nResults saved to: ${resultsPath}`);

  // Write the human-readable Excel (CSV) report: one row per code with its migration outcome.
  if (results.report && results.report.length > 0) {
    const cols = ['code', 'title', 'customer', 'used', 'limit', 'collection', 'status', 'migrated_ok', 'notes'];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const row of results.report) lines.push(cols.map((c) => esc(row[c])).join(','));
    const csvPath = path.join(outputDir, `migration_report_${timestamp}.csv`);
    // UTF-8 BOM so Excel opens it with correct encoding.
    await fs.writeFile(csvPath, '﻿' + lines.join('\n') + '\n', 'utf8');
    console.log(`CSV report saved to:  ${csvPath}  (${results.report.length} rows)`);

    // Also write the 2-tab Excel workbook: Tab 1 = grouped summary, Tab 2 = all codes.
    try {
      const xlsxPath = path.join(outputDir, `migration_report_${timestamp}.xlsx`);
      const { counts } = writeXlsxReport(results.report, xlsxPath);
      console.log(`Excel (2 tabs) saved to: ${xlsxPath}`);
      console.log('  Summary:');
      for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)}  ${k}`);
    } catch (e) {
      console.warn(`WARN: could not write .xlsx (${e.message}). CSV report is still available.`);
    }
  }
}

function printHelp() {
  console.log('Usage: node ./src/cli-stage2.mjs <input-file.json> [options]');
  console.log('');
  console.log('Migrate extracted Shopify discounts to OpenStore');
  console.log('');
  console.log('Required:');
  console.log('  <input-file.json>     Path to extracted discounts JSON file');
  console.log('  --merchantId=xxx      OpenStore merchant ID');
  console.log('  --cookie=xxx          OpenStore auth cookie');
  console.log('');
  console.log('Optional:');
  console.log('  --mapping=file.json   ID mapping file (Shopify IDs → OpenStore IDs)');
  console.log('  --generateMapping     Generate a mapping template from the input file');
  console.log('  --limit=1             Only migrate first N discounts (for testing)');
  console.log('  --status=ready        Only migrate discounts with this status (default: ready)');
  console.log('  --status=all          Migrate all discounts');
  console.log('  --active-only         Only Shopify ACTIVE discounts, exclude FBT-BUNDLE-P-* bundles');
  console.log('  --code=XYZ            Only migrate discounts whose code or title matches (substring)');
  console.log('  --dryRun=true         Preview what would be created without actually creating');
  console.log('  --delay=100           Delay between API calls in ms (default: 100)');
  console.log('  --concurrency=1       Number of parallel workers (default: 1; try 5-10 for full runs)');
  console.log('  --resetLedger=true    Wipe the local .migrated.jsonl skip-list before running');
  console.log('  --maxRetries=6        Max retries on 429/5xx (default: 6)');
  console.log('  --baseBackoffMs=5000  Initial cool-off on 429 in ms; doubles each retry (default: 5000)');
  console.log('  --maxBackoffMs=60000  Cap for cool-off between retries in ms (default: 60000)');
  console.log('  --baseUrl=xxx         OpenStore API base URL');
  console.log('');
  console.log('Environment variables (alternative to flags):');
  console.log('  OPENSTORE_MERCHANT_ID');
  console.log('  OPENSTORE_COOKIE');
  console.log('  OPENSTORE_BASE_URL');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
