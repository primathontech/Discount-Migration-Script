import path from 'node:path';
import { loadConfig } from './config.mjs';
import { extractStage1 } from './extract-stage1.mjs';
import { buildCsvRows, csvStringify, normalizeExtraction } from './normalize.mjs';
import { ShopifyAdminClient } from './shopify-client.mjs';
import { ensureDir, timestampForFilename, writeJson, writeText } from './utils.mjs';

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);

  if (argv.includes('--help')) {
    printHelp();
    return;
  }

  const config = await loadConfig({
    cwd,
    argv,
  });

  const client = new ShopifyAdminClient({
    shop: config.shop,
    token: config.token,
    apiVersion: config.apiVersion,
  });

  const timestamp = timestampForFilename();
  const extractedAt = new Date().toISOString();

  console.log(`Extracting Shopify discounts from ${config.shop} using Admin API ${config.apiVersion}...`);

  const extraction = await extractStage1({ client, config });
  const normalized = normalizeExtraction({
    shopInfo: extraction.shopInfo,
    rawDiscountNodes: extraction.rawDiscountNodes,
    config,
    extractedAt,
  });

  await ensureDir(config.outputDir);

  const jsonPath = path.join(config.outputDir, `discounts_${timestamp}.json`);
  const csvPath = path.join(config.outputDir, `discounts_${timestamp}.csv`);

  await writeJson(jsonPath, normalized);
  await writeText(csvPath, csvStringify(buildCsvRows(normalized)));

  console.log(`Wrote ${normalized.discounts.length} discounts to:`);
  console.log(`- ${jsonPath}`);
  console.log(`- ${csvPath}`);
  console.log(
    `Summary: ${normalized.summary.total_discounts} discounts, ${normalized.summary.total_codes} codes`,
  );
}

function printHelp() {
  console.log('Usage: node ./src/cli.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --shop=store.myshopify.com');
  console.log('  --token=shpat_xxx');
  console.log('  --merchant=merchant-slug');
  console.log('  --apiVersion=2026-01');
  console.log('  --recentlyExpiredDays=30');
  console.log('  --status=active      Filter discounts by status (active|expired|scheduled|all). Default: active');
  console.log('  --discountPageSize=50');
  console.log('  --codePageSize=100');
  console.log('  --metafieldPageSize=100');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
