import { compact, daysAgoIso, toNumber, uniqueBy } from './utils.mjs';

export function normalizeExtraction({ shopInfo, rawDiscountNodes, config, extractedAt }) {
  const threshold = daysAgoIso(config.recentlyExpiredDays);
  const includedDiscounts = [];
  const skippedDiscounts = [];

  for (const rawNode of rawDiscountNodes) {
    const normalized = normalizeDiscountNode(rawNode, threshold);
    if (!normalized.included) {
      skippedDiscounts.push(normalized);
      continue;
    }

    includedDiscounts.push(normalized.discount);
  }

  const summary = buildSummary(includedDiscounts);

  return {
    merchant: config.merchantSlug,
    extracted_at: extractedAt,
    shopify_store: shopInfo.myshopifyDomain,
    shopify_shop_name: shopInfo.name,
    shop_currency: shopInfo.currencyCode,
    shop_timezone: shopInfo.ianaTimezone,
    summary,
    skipped: skippedDiscounts.map(({ reason, raw }) => ({
      shopify_id: raw.id,
      shopify_type: raw.discount?.__typename ?? 'Unknown',
      reason,
      title: raw.discount?.title ?? null,
      status: raw.discount?.status ?? null,
    })),
    discounts: includedDiscounts,
  };
}

export function buildCsvRows(extraction) {
  return extraction.discounts.map((discount) => ({
    shopify_id: discount.shopify_id,
    title: discount.title,
    type: discount.normalized_type,
    status: discount.status,
    value: formatCsvValue(discount),
    code: discount.activation_method === 'automatic' ? 'AUTOMATIC' : (discount.codes[0]?.code ?? ''),
    code_count: String(discount.codes.length),
    starts_at: discount.starts_at ?? '',
    ends_at: discount.ends_at ?? '',
    usage_limit: discount.usage_limit ?? '',
    usage_count: discount.usage_count ?? '',
    scope: formatScope(discount),
    migration_status: discount.migration_status,
    migration_notes: discount.migration_notes ?? '',
  }));
}

export function csvStringify(rows) {
  if (rows.length === 0) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(
      headers
        .map((header) => escapeCsvValue(row[header] ?? ''))
        .join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

function escapeCsvValue(value) {
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }

  return stringValue;
}

function normalizeDiscountNode(raw, recentlyExpiredThresholdIso) {
  const discount = raw.discount;
  if (!discount?.__typename) {
    return { included: false, reason: 'missing_discount_payload', raw };
  }

  const endsAt = discount.endsAt ?? null;

  // Only include ACTIVE and SCHEDULED discounts, exclude all EXPIRED
  if (!['ACTIVE', 'SCHEDULED'].includes(discount.status)) {
    return { included: false, reason: 'filtered_out_by_status', raw };
  }

  const base = {
    shopify_id: raw.id,
    shopify_type: discount.__typename,
    normalized_type: normalizedType(discount.__typename),
    title: discount.title ?? '',
    status: discount.status,
    activation_method: activationMethod(discount.__typename),
    discount_class: discountClass(discount.__typename),
    starts_at: discount.startsAt ?? null,
    ends_at: endsAt,
    created_at: discount.createdAt ?? null,
    updated_at: discount.updatedAt ?? null,
    usage_limit: discount.usageLimit ?? null,
    usage_count: discount.asyncUsageCount ?? null,
    once_per_customer: discount.appliesOncePerCustomer ?? null,
    combines_with: normalizeCombinesWith(discount.combinesWith),
    customer_selection: normalizeContext(discount.context),
    minimum_requirement: normalizeMinimumRequirement(discount.minimumRequirement),
    codes: normalizeCodes(discount.codes),
    warnings: [],
  };

  let normalized;

  switch (discount.__typename) {
    case 'DiscountCodeBasic':
    case 'DiscountAutomaticBasic':
      normalized = {
        ...base,
        ...normalizeBasicDiscount(discount),
      };
      break;
    case 'DiscountCodeBxgy':
    case 'DiscountAutomaticBxgy':
      normalized = {
        ...base,
        ...normalizeBxgyDiscount(discount),
      };
      break;
    case 'DiscountCodeFreeShipping':
    case 'DiscountAutomaticFreeShipping':
      normalized = {
        ...base,
        ...normalizeFreeShippingDiscount(discount),
      };
      break;
    case 'DiscountCodeApp':
    case 'DiscountAutomaticApp':
      normalized = {
        ...base,
        ...normalizeAppDiscount(discount, raw.metafields ?? []),
      };
      break;
    default:
      normalized = {
        ...base,
        value_type: null,
        value: null,
        items: null,
        migration_status: 'unsupported',
        migration_notes: `Unsupported discount type: ${discount.__typename}`,
      };
  }

  normalized.code_count = normalized.codes.length;

  normalized.status_bucket = discount.status.toLowerCase();

  if (hasScopePagination(normalized)) {
    normalized.migration_status =
      normalized.migration_status === 'ready' ? 'needs_review' : normalized.migration_status;
    normalized.migration_notes = mergeNotes(
      normalized.migration_notes,
      'Scoped products, variants, or collections exceed the first 100 records and need follow-up extraction.',
    );
    normalized.warnings.push('scope_truncated');
  }

  return { included: true, discount: normalized, raw };
}

function normalizeBasicDiscount(discount) {
  const valueInfo = normalizeCustomerGetsValue(discount.customerGets?.value);

  return {
    value_type: valueInfo.value_type,
    value: valueInfo.value,
    applies_on_each_item: valueInfo.applies_on_each_item,
    value_detail: valueInfo.detail,
    items: normalizeItems(discount.customerGets?.items),
    app_config: null,
    migration_status: 'ready',
    migration_notes: null,
  };
}

function normalizeBxgyDiscount(discount) {
  return {
    value_type: 'bxgy',
    value: null,
    items: normalizeItems(discount.customerGets?.items),
    bxgy_configuration: {
      customer_buys: {
        value: normalizeCustomerBuysValue(discount.customerBuys?.value),
        items: normalizeItems(discount.customerBuys?.items),
      },
      customer_gets: {
        value: normalizeCustomerGetsValue(discount.customerGets?.value),
        items: normalizeItems(discount.customerGets?.items),
      },
      uses_per_order_limit: discount.usesPerOrderLimit ?? null,
    },
    app_config: null,
    migration_status: 'ready',
    migration_notes: null,
  };
}

function normalizeFreeShippingDiscount(discount) {
  return {
    value_type: 'free_shipping',
    value: null,
    items: null,
    destination_selection: normalizeDestinationSelection(discount.destinationSelection),
    maximum_shipping_price: normalizeMoney(discount.maximumShippingPrice),
    applies_on_one_time_purchase: discount.appliesOnOneTimePurchase ?? null,
    applies_on_subscription: discount.appliesOnSubscription ?? null,
    recurring_cycle_limit: discount.recurringCycleLimit ?? null,
    app_config: null,
    migration_status: 'ready',
    migration_notes: null,
  };
}

function normalizeAppDiscount(discount, metafields) {
  const appConfig = {
    function_id: discount.appDiscountType?.functionId ?? null,
    app_key: discount.appDiscountType?.appKey ?? null,
    discount_type_title: discount.appDiscountType?.title ?? null,
    description: discount.appDiscountType?.description ?? null,
    discount_classes: discount.appDiscountType?.discountClasses ?? [],
    metafields: Object.fromEntries(
      metafields.map((metafield) => [`${metafield.namespace}.${metafield.key}`, metafield.value]),
    ),
    raw_metafields: metafields,
  };

  const functionConfiguration = metafields.find(
    (metafield) =>
      metafield.key === 'function-configuration' ||
      `${metafield.namespace}.${metafield.key}`.endsWith('.function-configuration'),
  );

  if (functionConfiguration) {
    appConfig.function_configuration = tryParseJson(functionConfiguration.value);
  }

  return {
    value_type: null,
    value: null,
    items: null,
    app_config: appConfig,
    applies_on_one_time_purchase: discount.appliesOnOneTimePurchase ?? null,
    applies_on_subscription: discount.appliesOnSubscription ?? null,
    recurring_cycle_limit: discount.recurringCycleLimit ?? null,
    migration_status: 'needs_review',
    migration_notes:
      'App-managed discount. The extractor preserved app metadata and metafields, but the discount logic still needs mapping review.',
  };
}

function normalizeCodes(codesConnection) {
  const codes = uniqueBy(codesConnection?.nodes ?? [], (code) => code.id ?? code.code);

  return codes.map((code) => ({
    id: code.id ?? null,
    code: code.code,
    usage_count: code.asyncUsageCount ?? null,
  }));
}

function normalizeCombinesWith(value) {
  if (!value) {
    return {
      product_discounts: false,
      order_discounts: false,
      shipping_discounts: false,
    };
  }

  return {
    product_discounts: Boolean(value.productDiscounts),
    order_discounts: Boolean(value.orderDiscounts),
    shipping_discounts: Boolean(value.shippingDiscounts),
  };
}

function normalizeContext(context) {
  if (!context) {
    return { type: 'unknown' };
  }

  switch (context.__typename) {
    case 'DiscountBuyerSelectionAll':
      return { type: 'all' };
    case 'DiscountCustomers':
      return {
        type: 'specific_customers',
        customers: (context.customers ?? []).map((customer) => ({
          id: customer.id,
          email: customer.email ?? null,
          display_name: customer.displayName ?? null,
          first_name: customer.firstName ?? null,
          last_name: customer.lastName ?? null,
          // Best available phone: contact phone, else default-address phone, else any
          // address phone (OS customer-create requires a phone). Normalized to 10 digits.
          phone: bestCustomerPhone(customer),
        })),
      };
    case 'DiscountCustomerSegments':
      return {
        type: 'specific_segments',
        segments: (context.segments ?? []).map((segment) => ({
          id: segment.id,
          name: segment.name ?? null,
        })),
      };
    default:
      return { type: 'unknown', raw_type: context.__typename };
  }
}

function normalizeMinimumRequirement(requirement) {
  if (!requirement) {
    return {
      type: 'none',
      value: null,
      currency_code: null,
    };
  }

  if (requirement.__typename === 'DiscountMinimumSubtotal') {
    return {
      type: 'subtotal',
      value: toNumber(requirement.greaterThanOrEqualToSubtotal?.amount),
      currency_code: requirement.greaterThanOrEqualToSubtotal?.currencyCode ?? null,
    };
  }

  if (requirement.__typename === 'DiscountMinimumQuantity') {
    return {
      type: 'quantity',
      value: requirement.greaterThanOrEqualToQuantity ?? null,
      currency_code: null,
    };
  }

  return {
    type: 'unknown',
    value: null,
    currency_code: null,
  };
}

function normalizeCustomerGetsValue(value) {
  if (!value) {
    return {
      value_type: null,
      value: null,
      applies_on_each_item: null,
      detail: null,
    };
  }

  if (value.__typename === 'DiscountPercentage') {
    return {
      value_type: 'percentage',
      value: normalizePercentage(value.percentage),
      applies_on_each_item: null,
      detail: null,
    };
  }

  if (value.__typename === 'DiscountAmount') {
    return {
      value_type: 'fixed_amount',
      value: toNumber(value.amount?.amount),
      applies_on_each_item: value.appliesOnEachItem ?? null,
      detail: {
        currency_code: value.amount?.currencyCode ?? null,
      },
    };
  }

  if (value.__typename === 'DiscountOnQuantity') {
    return {
      value_type: 'bxgy',
      value: null,
      applies_on_each_item: null,
      detail: {
        quantity: value.quantity ?? null,
        effect: normalizeCustomerGetsValue(value.effect),
      },
    };
  }

  return {
    value_type: 'unknown',
    value: null,
    applies_on_each_item: null,
    detail: { raw_type: value.__typename },
  };
}

function normalizeCustomerBuysValue(value) {
  if (!value) {
    return null;
  }

  if (value.__typename === 'DiscountQuantity') {
    return {
      type: 'quantity',
      quantity: value.quantity ?? null,
    };
  }

  if (value.__typename === 'DiscountPurchaseAmount') {
    return {
      type: 'amount',
      amount: toNumber(value.amount),
    };
  }

  return {
    type: 'unknown',
    raw_type: value.__typename,
  };
}

function normalizeItems(items) {
  if (!items) {
    return null;
  }

  if (items.__typename === 'AllDiscountItems') {
    return {
      type: 'all',
    };
  }

  if (items.__typename === 'DiscountProducts') {
    const products = items.products?.nodes ?? [];
    const variants = items.productVariants?.nodes ?? [];

    return {
      type: 'specific_products',
      products: products.map((product) => ({
        id: product.id,
        handle: product.handle ?? null,
        title: product.title ?? null,
      })),
      product_variants: variants.map((variant) => ({
        id: variant.id,
        title: variant.title ?? null,
        sku: variant.sku ?? null,
        product: variant.product
          ? {
              id: variant.product.id,
              handle: variant.product.handle ?? null,
              title: variant.product.title ?? null,
            }
          : null,
      })),
      page_info: {
        products: items.products?.pageInfo ?? null,
        product_variants: items.productVariants?.pageInfo ?? null,
      },
    };
  }

  if (items.__typename === 'DiscountCollections') {
    return {
      type: 'specific_collections',
      collections: (items.collections?.nodes ?? []).map((collection) => ({
        id: collection.id,
        handle: collection.handle ?? null,
        title: collection.title ?? null,
      })),
      page_info: {
        collections: items.collections?.pageInfo ?? null,
      },
    };
  }

  return {
    type: 'unknown',
    raw_type: items.__typename,
  };
}

function normalizeDestinationSelection(destinationSelection) {
  if (!destinationSelection) {
    return null;
  }

  if (destinationSelection.__typename === 'DiscountCountryAll') {
    return {
      type: 'all_countries',
      all_countries: true,
    };
  }

  if (destinationSelection.__typename === 'DiscountCountries') {
    return {
      type: 'specific_countries',
      countries: destinationSelection.countries ?? [],
      include_rest_of_world: destinationSelection.includeRestOfWorld ?? false,
    };
  }

  return {
    type: 'unknown',
    raw_type: destinationSelection.__typename,
  };
}

function normalizeMoney(money) {
  if (!money) {
    return null;
  }

  return {
    amount: toNumber(money.amount),
    currency_code: money.currencyCode ?? null,
  };
}

function normalizePercentage(value) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }

  return numeric <= 1 ? numeric * 100 : numeric;
}

function normalizedType(typename) {
  return `${activationMethod(typename)}_${discountClass(typename)}`;
}

function activationMethod(typename) {
  return typename.includes('Automatic') ? 'automatic' : 'code';
}

function discountClass(typename) {
  if (typename.includes('Basic')) {
    return 'basic';
  }

  if (typename.includes('Bxgy')) {
    return 'bxgy';
  }

  if (typename.includes('FreeShipping')) {
    return 'free_shipping';
  }

  if (typename.includes('App')) {
    return 'app';
  }

  return 'unknown';
}

function hasScopePagination(discount) {
  return compact([
    discount.items?.page_info?.products?.hasNextPage,
    discount.items?.page_info?.product_variants?.hasNextPage,
    discount.items?.page_info?.collections?.hasNextPage,
    discount.bxgy_configuration?.customer_buys?.items?.page_info?.products?.hasNextPage,
    discount.bxgy_configuration?.customer_buys?.items?.page_info?.product_variants?.hasNextPage,
    discount.bxgy_configuration?.customer_buys?.items?.page_info?.collections?.hasNextPage,
    discount.bxgy_configuration?.customer_gets?.items?.page_info?.products?.hasNextPage,
    discount.bxgy_configuration?.customer_gets?.items?.page_info?.product_variants?.hasNextPage,
    discount.bxgy_configuration?.customer_gets?.items?.page_info?.collections?.hasNextPage,
  ]).some(Boolean);
}

function buildSummary(discounts) {
  const byType = {
    code_basic: 0,
    code_bxgy: 0,
    code_free_shipping: 0,
    automatic_basic: 0,
    automatic_bxgy: 0,
    automatic_free_shipping: 0,
    code_app: 0,
    automatic_app: 0,
  };

  const byStatus = {
    active: 0,
    scheduled: 0,
  };

  let totalCodes = 0;

  for (const discount of discounts) {
    if (discount.normalized_type in byType) {
      byType[discount.normalized_type] += 1;
    }

    if (discount.status_bucket in byStatus) {
      byStatus[discount.status_bucket] += 1;
    }

    totalCodes += discount.codes.length;
  }

  return {
    total_discounts: discounts.length,
    by_type: byType,
    total_codes: totalCodes,
    by_status: byStatus,
  };
}

function formatCsvValue(discount) {
  if (discount.value_type === 'percentage' && discount.value !== null) {
    return `${discount.value}%`;
  }

  if (discount.value_type === 'fixed_amount' && discount.value !== null) {
    const currency = discount.value_detail?.currency_code ?? '';
    return compact([currency, discount.value]).join(' ');
  }

  if (discount.value_type === 'free_shipping') {
    return 'Free shipping';
  }

  if (discount.value_type === 'bxgy') {
    return 'BXGY';
  }

  if (discount.discount_class === 'app') {
    return 'App-managed';
  }

  return '';
}

function formatScope(discount) {
  const items =
    discount.items ??
    discount.bxgy_configuration?.customer_gets?.items ??
    discount.bxgy_configuration?.customer_buys?.items;

  if (!items) {
    return discount.discount_class === 'free_shipping' ? 'Shipping destinations' : '';
  }

  if (items.type === 'all') {
    return 'All products';
  }

  if (items.type === 'specific_products') {
    const label = items.products[0]?.handle ?? items.product_variants[0]?.sku ?? 'Specific products';
    return items.products.length + items.product_variants.length > 1
      ? `Products: ${label} (+more)`
      : `Products: ${label}`;
  }

  if (items.type === 'specific_collections') {
    const label = items.collections[0]?.handle ?? 'Specific collections';
    return items.collections.length > 1 ? `Collections: ${label} (+more)` : `Collections: ${label}`;
  }

  return '';
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mergeNotes(first, second) {
  if (!first) {
    return second;
  }

  return `${first} ${second}`;
}

// Normalize an (Indian) phone to a plain 10-digit string; drop spaces, +91, leading 0.
function cleanPhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : null;
}

// Best phone for a Shopify customer: contact phone, else default-address phone, else any
// address phone. OS customer-create requires a phone, and it is often only on the address.
function bestCustomerPhone(customer) {
  return cleanPhone(customer.phone)
    || cleanPhone(customer.defaultAddress?.phone)
    || cleanPhone((customer.addresses?.nodes ?? customer.addresses ?? []).map((a) => a?.phone).find(Boolean));
}
