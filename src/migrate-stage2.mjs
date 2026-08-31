import { OpenStoreClient } from './openstore-client.mjs';
import {
  mapDiscountToOpenStore,
  prepareSingleCodePayload,
} from './discount-mapper.mjs';
import { IdMapping } from './id-mapping.mjs';
import { sleep } from './utils.mjs';

export async function migrateStage2({ client, discounts, config, idMapping, ledger }) {
  const mapping = idMapping || new IdMapping();
  const results = {
    successful: [],
    failed: [],
    skipped: [],
    report: [], // one row per code -> written to a CSV the user opens in Excel
  };

  const concurrency = Math.max(1, config.concurrency ?? 1);
  const total = discounts.length;

  // --- report helpers -------------------------------------------------------
  const customerDesc = (discount, payload) => {
    const cs = discount.customer_selection;
    if (!cs || !cs.type || cs.type === 'all') return 'all';
    if (cs.type === 'specific_customers') {
      const totalC = (cs.customers || []).length;
      const resolved = payload ? (payload.targeting?.applicable_user_ids?.length ?? 0) : null;
      return resolved != null ? `specific ${resolved}/${totalC}` : `specific ${totalC}`;
    }
    if (cs.type === 'specific_segments') return 'segments';
    return cs.type;
  };
  const collectionDesc = (discount, osd) => {
    const t = discount.items?.type;
    if (t === 'specific_collections') {
      const totalC = (discount.items.collections || []).length;
      const unmapped = (osd?._meta?.unmappedIds || []).length;
      return `collections ${totalC - unmapped}/${totalC}`;
    }
    if (t === 'specific_products') return discount.items.product_variants?.length ? 'variants' : 'products';
    return 'all';
  };
  const buildNotes = (discount, payload, osd) => {
    const notes = [];
    const cs = discount.customer_selection;
    if (cs?.type === 'specific_customers') {
      const totalC = (cs.customers || []).length;
      const resolved = payload?.targeting?.applicable_user_ids?.length ?? 0;
      if (totalC === 0) notes.push('customer-specific but no customer selected in Shopify');
      else if (resolved < totalC) notes.push('customer-specific: customer has no phone in Shopify');
    }
    if (discount.items?.type === 'specific_collections') {
      const unmapped = osd?._meta?.unmappedIds || [];
      if (unmapped.length) notes.push(`collection(s) not in OS -> sitewide: ${unmapped.join('|')}`);
    }
    if (discount.usage_limit != null && (discount.usage_count || 0) >= discount.usage_limit) {
      notes.push(`exhausted (limit=${discount.usage_limit} used=${discount.usage_count})`);
    }
    if (discount.activation_method === 'code' && !(discount.codes && discount.codes.length)) {
      notes.push('codeless: title-as-code');
    }
    return notes;
  };
  const pushRow = ({ discount, code, statusFinal, outcome, osd, payload, extra }) => {
    const notes = buildNotes(discount, payload, osd);
    if (extra) notes.push(extra);
    const okMap = { created: 'YES', exists: 'YES (already in OS)', failed: 'NO', skipped: 'NO' };
    results.report.push({
      code: code ?? (discount.codes?.[0]?.code || ''),
      title: discount.title ?? '',
      customer: customerDesc(discount, payload),
      used: discount.usage_count ?? '',
      limit: discount.usage_limit ?? '',
      collection: collectionDesc(discount, osd),
      status: statusFinal ?? '',
      migrated_ok: okMap[outcome] ?? outcome,
      notes: notes.join('; '),
    });
  };

  console.log(
    `Migrating ${total} discounts to OpenStore (concurrency=${concurrency}, delay=${config.delayMs}ms)...`,
  );

  // Create one single-code discount (with an optional code + status override).
  // ledgerKey lets discount-set codes each track independently for safe resume.
  async function createSingle({ openStoreDiscount, discount, progress, title, ledgerKey, codeOverride, statusOverride, labelSuffix = '' }) {
    if (ledger?.has(ledgerKey)) {
      results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'already_in_ledger' });
      pushRow({ discount, code: codeOverride, statusFinal: 'n/a', outcome: 'skipped', osd: openStoreDiscount, extra: 'already in ledger (previously migrated)' });
      return;
    }
    const payload = prepareSingleCodePayload(openStoreDiscount);
    if (codeOverride) payload.code = codeOverride;
    if (statusOverride) payload.status = statusOverride;
    try {
      const response = await client.createDiscount(payload);
      results.successful.push({
        shopify_id: discount.shopify_id,
        title,
        code: payload.code,
        openstore_id: response.data?.id || response.data?._id || null,
      });
      if (ledger) await ledger.record(ledgerKey);
      pushRow({ discount, code: payload.code, statusFinal: payload.status, outcome: 'created', osd: openStoreDiscount, payload });
      console.log(`${progress} "${title}"${labelSuffix} -> created (${payload.code}, ${payload.status})`);
    } catch (error) {
      if (error.message.includes('(409)')) {
        results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'already_exists_409' });
        if (ledger) await ledger.record(ledgerKey);
        pushRow({ discount, code: payload.code, statusFinal: payload.status, outcome: 'exists', osd: openStoreDiscount, payload });
        console.log(`${progress} "${title}"${labelSuffix} -> already exists (409)`);
      } else {
        results.failed.push({ shopify_id: discount.shopify_id, title, code: payload.code, error: error.message });
        pushRow({ discount, code: payload.code, statusFinal: payload.status, outcome: 'failed', osd: openStoreDiscount, payload, extra: error.message });
        console.log(`${progress} FAILED "${title}"${labelSuffix}: ${error.message}`);
      }
    }
    if (config.delayMs > 0) await sleep(config.delayMs);
  }

  async function processOne(discount, i) {
    const progress = `[${i + 1}/${total}]`;
    const title = discount.title ?? '(no title)';
    const isSet = discount.code_count > 1;

    // Non-set: ledger short-circuit by shopify_id (sets are checked per-code inside).
    if (!isSet && ledger?.has(discount.shopify_id)) {
      results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'already_in_ledger' });
      pushRow({ discount, statusFinal: 'n/a', outcome: 'skipped', extra: 'already in ledger (previously migrated)' });
      return;
    }

    if (discount.migration_status === 'unsupported') {
      console.log(`${progress} SKIP "${title}" - unsupported type`);
      results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'unsupported_type' });
      pushRow({ discount, statusFinal: 'n/a', outcome: 'skipped', extra: 'unsupported discount type' });
      return;
    }
    if (discount.value_type === 'free_shipping') {
      console.log(`${progress} SKIP "${title}" - free shipping not supported`);
      results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'free_shipping_not_supported' });
      pushRow({ discount, statusFinal: 'n/a', outcome: 'skipped', extra: 'free shipping not supported' });
      return;
    }
    // Defer customer-specific discounts (handled separately once customer phones are fetched).
    if (config.skipCustomerSpecific && discount.customer_selection?.type === 'specific_customers') {
      console.log(`${progress} SKIP "${title}" - customer-specific, deferred (--skip-customer-specific)`);
      results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'customer_specific_deferred' });
      pushRow({ discount, statusFinal: 'n/a', outcome: 'skipped', extra: 'customer-specific deferred (phone fetch)' });
      return;
    }

    let openStoreDiscount;
    try {
      openStoreDiscount = mapDiscountToOpenStore(discount, mapping);
    } catch (e) {
      results.failed.push({ shopify_id: discount.shopify_id, title, error: e.message });
      pushRow({ discount, statusFinal: 'n/a', outcome: 'failed', extra: `map error: ${e.message}` });
      console.log(`${progress} FAILED "${title}": ${e.message}`);
      return;
    }
    if (!openStoreDiscount.actions || openStoreDiscount.actions.length === 0) {
      console.log(`${progress} SKIP "${title}" - could not map (no action; e.g. free shipping/unsupported)`);
      results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'could_not_map_rules' });
      pushRow({ discount, statusFinal: 'n/a', outcome: 'skipped', osd: openStoreDiscount, extra: 'could not map (no action)' });
      return;
    }
    if (openStoreDiscount._meta?.unmappedIds?.length > 0) {
      console.log(`${progress} WARN "${title}" - ${openStoreDiscount._meta.unmappedIds.length} unmapped IDs (will use allow_all)`);
    }

    const isCodeDiscount = discount.activation_method === 'code';
    const hasNoCode = !discount.codes || discount.codes.length === 0;

    // A) Discount set: expand into one single discount PER real code (preserves real codes).
    if (isSet) {
      if (config.skipSets) {
        console.log(`${progress} SKIP "${title}" - discount set (${discount.code_count} codes), deferred (--skip-sets)`);
        results.skipped.push({ shopify_id: discount.shopify_id, title, reason: 'discount_set_deferred' });
        pushRow({ discount, statusFinal: 'n/a', outcome: 'skipped', osd: openStoreDiscount, extra: `discount set (${discount.code_count} codes) deferred` });
        return;
      }
      const codes = discount.codes || [];
      for (let k = 0; k < codes.length; k++) {
        const code = codes[k]?.code;
        if (!code) continue;
        await createSingle({
          openStoreDiscount, discount, progress, title,
          ledgerKey: `${discount.shopify_id}::${code}`,
          codeOverride: code,
          labelSuffix: ` [set ${k + 1}/${codes.length}]`,
        });
      }
      return;
    }

    // B) Code-type discount with NO code in Shopify: create using the title as the code and
    //    PUBLISH it (unless exhausted). Many of these are duplicates of a real coded discount;
    //    real-coded discounts are processed first (see cli sort), so the real one wins the code
    //    slot and these harmlessly 409. The truly-unique ones become live.
    if (isCodeDiscount && hasNoCode) {
      await createSingle({
        openStoreDiscount, discount, progress, title,
        ledgerKey: discount.shopify_id,
        statusOverride: openStoreDiscount._meta?.exhausted ? 'draft' : undefined,
        labelSuffix: ' [codeless title-as-code]',
      });
      return;
    }

    // C) Normal single-code (and automatic codeless -> title-as-code via mapper, keep mapped status).
    //    Force DRAFT on a real gap so we never publish a broken discount:
    //    - exhausted (OS can't express 0 remaining)
    //    - customer-specific that resolved to ZERO customers (would target nobody)
    //    - collection-scoped where a collection isn't in OS (scope would fall to sitewide)
    const customerBroken = discount.customer_selection?.type === 'specific_customers'
      && (openStoreDiscount.targeting?.applicable_user_ids?.length ?? 0) === 0;
    const collectionBroken = discount.items?.type === 'specific_collections'
      && (openStoreDiscount._meta?.unmappedIds?.length ?? 0) > 0;
    const hasRealGap = openStoreDiscount._meta?.exhausted || customerBroken || collectionBroken;
    await createSingle({
      openStoreDiscount, discount, progress, title,
      ledgerKey: discount.shopify_id,
      statusOverride: hasRealGap ? 'draft' : undefined,
    });
  }

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      await processOne(discounts[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return results;
}

export function printMigrationSummary(results) {
  console.log('\n=== Migration Summary ===');
  console.log(`Successful: ${results.successful.length}`);
  console.log(`Failed: ${results.failed.length}`);
  console.log(`Skipped: ${results.skipped.length}`);

  if (results.failed.length > 0) {
    console.log('\nFailed discounts:');
    for (const failed of results.failed.slice(0, 10)) {
      console.log(`  - ${failed.title}: ${failed.error}`);
    }
    if (results.failed.length > 10) {
      console.log(`  ... and ${results.failed.length - 10} more`);
    }
  }

  if (results.skipped.length > 0) {
    console.log('\nSkipped discounts:');
    const byReason = {};
    for (const skipped of results.skipped) {
      byReason[skipped.reason] = (byReason[skipped.reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`  - ${reason}: ${count}`);
    }
  }
}
