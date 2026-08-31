import { IdMapping } from './id-mapping.mjs';

/**
 * Shopify stores money in rupees; the OpenStore discount service stores it in PAISA
 * (confirmed: sending amount 15000 displayed as ₹150). Convert money rupees -> paisa.
 * Do NOT apply to percentages or quantities.
 */
function toPaisa(rupees) {
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : rupees;
}

/**
 * Maps a Shopify discount to the OpenStore/Ratio **Dashboard V2** discount shape — the exact
 * payload the PROD dashboard itself sends to
 *   POST /v3/api/dashboard/v2/discount/create
 *   PUT  /v3/api/dashboard/v2/discount/update/:id
 * (captured from the dashboard's own network calls; see "Discount Service V2 API Documentation").
 *
 * This is the shape the dashboard READS scope/conditions from. The older
 * os-discount/create endpoint (rules[].conditions/actions + product_attribute) stored a
 * representation the dashboard's "Applies to" / min-condition UI does NOT read, which is why
 * collection/product scope and minimums showed wrong. This mapper fixes that.
 *
 * Shape summary:
 *   - type: CART | BXGY
 *   - actions[]: { type, method: FLAT_OFF|PERCENT_OFF|FREE, amount, buy_rules?, get_rule?, get_quantity? }
 *   - cart_conditions: { type: CART_AMOUNT|CART_QUANTITY, min_value, reference?, product_matchers[] }
 *   - product_matchers[]: { match_by: CollectionId|VariantId|Id|Tag, ids[], min_quantity }
 *   - targeting: { applicable_for_all_users, applicable_user_ids[], ... }
 *   - usage_limit: { total_uses, per_user, per_order }
 * Money is sent in PAISA; status:published so active Shopify discounts go live.
 *
 * @param {Object} shopifyDiscount - The Shopify discount
 * @param {IdMapping} idMapping - ID mapping for collections (products/variants reuse Shopify ids)
 */
export function mapDiscountToOpenStore(shopifyDiscount, idMapping = new IdMapping()) {
  // Usage: OS tracks its own used-count from 0 (can't seed "already used"). total_uses:0 means
  // UNLIMITED, so we set total_uses = REMAINING (limit-used). Exhausted (remaining 0) can't be
  // expressed (0 == unlimited), so we flag it -> the caller creates it as draft.
  const usageLimit = shopifyDiscount.usage_limit;
  const usageCount = shopifyDiscount.usage_count || 0;
  const remaining = usageLimit != null ? Math.max(usageLimit - usageCount, 0) : null;
  const exhausted = remaining === 0;

  const status = shopifyDiscount.status === 'ACTIVE' ? 'published' : 'draft';

  const base = {
    mode: 'MANUAL',
    type: 'CART', // overridden to BXGY below when applicable
    title: shopifyDiscount.title,
    description: shopifyDiscount.title,
    terms_and_conditions: shopifyDiscount.title ? [shopifyDiscount.title] : [],
    status,
    valid_from: shopifyDiscount.starts_at || new Date().toISOString(),
    // valid_until only when Shopify has an end; omit for no-expiry (matches the dashboard).
    ...(shopifyDiscount.ends_at ? { valid_until: shopifyDiscount.ends_at } : {}),
    visibility: 'hidden',
    view_in_listing: true,
    usage_limit: {
      total_uses: remaining == null ? 0 : remaining, // 0 = unlimited
      per_user: shopifyDiscount.once_per_customer ? 1 : 0, // 0 = unlimited per user
      per_order: 1,
    },
    targeting: {
      applicable_for_all_users: mapCustomerSelection(shopifyDiscount.customer_selection),
      // Customer-specific: OS assigns its OWN customer UUID (NOT the Shopify id), translated via
      // idMapping.customers (built from email/phone lookup or create in stage 2).
      applicable_user_ids: mapCustomerUserIds(shopifyDiscount.customer_selection, idMapping),
      applicable_user_categories: [],
      exclude_user_ids: false,
      applicable_for_all_merchants: false,
      applicable_devices: ['website'],
    },
  };

  // Build type-specific actions + cart_conditions.
  const { type, actions, cartConditions, unmappedIds } = mapByType(shopifyDiscount, idMapping);
  base.type = type;
  if (actions) base.actions = actions;
  if (cartConditions) base.cart_conditions = cartConditions;

  return {
    ...base,
    _meta: {
      shopify_id: shopifyDiscount.shopify_id,
      shopify_type: shopifyDiscount.shopify_type,
      code_count: shopifyDiscount.code_count,
      codes: shopifyDiscount.codes,
      unmappedIds,
      exhausted,
    },
  };
}

function mapCustomerSelection(customerSelection) {
  if (!customerSelection) return true;
  return customerSelection.type === 'all';
}

// Translate Shopify customers -> OS customer UUIDs via idMapping (built by resolving each
// customer's email/phone against OS in stage 2). Unresolved customers are dropped (the caller
// tracks that via count so a customer-specific discount that resolved to nobody stays draft).
function mapCustomerUserIds(customerSelection, idMapping) {
  if (!customerSelection || customerSelection.type !== 'specific_customers') return [];
  return (customerSelection.customers ?? [])
    .map(c => (idMapping?.getCustomer ? idMapping.getCustomer(extractNumericId(c.id)) : null))
    .filter(Boolean);
}

function mapByType(discount, idMapping) {
  switch (discount.normalized_type) {
    case 'code_basic':
    case 'automatic_basic':
      return mapBasic(discount, idMapping);
    case 'code_bxgy':
    case 'automatic_bxgy':
      return mapBxgy(discount, idMapping);
    // Free shipping is not representable as a CART/BXGY discount -> no actions (caller skips it).
    case 'code_free_shipping':
    case 'automatic_free_shipping':
    default:
      return { type: 'CART', actions: [], cartConditions: null, unmappedIds: [] };
  }
}

// ---- CART (amount/percentage off, optionally scoped to products/collections) ----
function mapBasic(discount, idMapping) {
  const unmappedIds = [];
  const isPercentage = discount.value_type === 'percentage';

  // Minimum requirement (Shopify: subtotal amount or item quantity).
  const min = readMinimum(discount);

  // Product/collection scope -> product_matchers (the field the dashboard reads for "Applies to").
  // A quantity minimum is expressed on the matcher's min_quantity; otherwise min_quantity is 1.
  const isAllProducts = discount.items?.type === 'all' || !discount.items;
  let matcher = null;
  if (!isAllProducts) {
    const scopeMinQty = min.kind === 'quantity' ? min.value : 1;
    const m = buildMatcher(discount.items, idMapping, scopeMinQty);
    unmappedIds.push(...m.unmapped);
    if (m.matcher && !m.matcher.all_products) matcher = m.matcher;
    // If nothing resolved (e.g. all collections unmapped), matcher stays null -> treated as
    // sitewide; migrate-stage2 sees the unmappedIds and drafts it so we don't publish a wrong scope.
  }

  // Action. The action decides WHAT gets discounted:
  //   - A SCOPED PERCENTAGE must be a PRODUCT action with the scope in `buy_rules`, so the % is
  //     applied to the scoped items only. A CART percentage would wrongly discount the WHOLE cart
  //     (verified: dashboard shows the collection either way, but a CART % over-discounts).
  //   - Flat amounts stay CART-level (matches the dashboard's own flat+collection shape, e.g. DD150).
  //   - Unscoped percentage/flat is naturally CART-level.
  // buy_rules gets a clone of the matcher taken BEFORE any subtotal min_value is added to it
  // (min_value belongs on the eligibility matcher, not on the target rule).
  let action;
  if (matcher && isPercentage) {
    action = { type: 'PRODUCT', method: 'PERCENT_OFF', amount: Number(discount.value), buy_rules: [{ ...matcher }] };
  } else if (isPercentage) {
    action = { type: 'CART', method: 'PERCENT_OFF', amount: Number(discount.value) };
  } else {
    action = { type: 'CART', method: 'FLAT_OFF', amount: toPaisa(discount.value) };
  }

  // Assemble cart_conditions. KEY CONSTRAINT (verified against the V2 API):
  //   product_matchers are ONLY allowed on CART_QUANTITY — CART_AMOUNT rejects them.
  // So a SCOPED discount always uses CART_QUANTITY (product_matchers drive the dashboard display
  // + eligibility gate), and a subtotal minimum is carried as the matcher's `min_value` (paisa) —
  // "minimum cart value from matched products". Only an UNSCOPED subtotal minimum uses CART_AMOUNT.
  let cartConditions = null;
  if (matcher) {
    if (min.kind === 'subtotal') matcher.min_value = toPaisa(min.value);
    cartConditions = { type: 'CART_QUANTITY', min_value: 1, product_matchers: [matcher] };
  } else if (min.kind === 'subtotal') {
    cartConditions = { type: 'CART_AMOUNT', min_value: toPaisa(min.value), reference: 'SUBTOTAL' };
  } else if (min.kind === 'quantity') {
    cartConditions = { type: 'CART_QUANTITY', min_value: min.value };
  }

  return { type: 'CART', actions: [action], cartConditions, unmappedIds };
}

// ---- BXGY (buy X get Y) ----
function mapBxgy(discount, idMapping) {
  const cfg = discount.bxgy_configuration;
  if (!cfg) return { type: 'BXGY', actions: [], cartConditions: null, unmappedIds: [] };
  const unmappedIds = [];

  // Buy side -> buy_rules matcher with the required buy quantity.
  const buys = cfg.customer_buys;
  let buyQty = 1;
  if (buys?.value?.type === 'quantity' && buys.value.quantity != null) {
    const q = Number(buys.value.quantity);
    buyQty = Number.isFinite(q) && q >= 1 ? q : 1;
  }
  const buyMatch = buildMatcher(buys?.items, idMapping, buyQty);
  unmappedIds.push(...buyMatch.unmapped);
  const buyRules = [buyMatch.matcher || { all_products: true, min_quantity: buyQty }];

  // Get side -> get_rule matcher + get_quantity + method.
  const gets = cfg.customer_gets;
  const getsValue = gets?.value;
  let getQty = 1;
  if (getsValue?.detail?.quantity?.quantity != null) getQty = Number(getsValue.detail.quantity.quantity);
  else if (getsValue?.detail?.quantity != null) getQty = Number(getsValue.detail.quantity);
  if (!Number.isFinite(getQty) || getQty < 1) getQty = 1;

  const action = { type: 'BXGY' };
  const pctType = getsValue?.value_type === 'percentage' || getsValue?.detail?.effect?.value_type === 'percentage';
  const fixedType = getsValue?.value_type === 'fixed_amount' || getsValue?.detail?.effect?.value_type === 'fixed_amount';
  if (pctType) {
    const pct = getsValue.value ?? getsValue.detail?.effect?.value;
    if (Number(pct) === 100) {
      action.method = 'FREE';
    } else {
      action.method = 'PERCENT_OFF';
      action.amount = Number(pct);
    }
  } else if (fixedType) {
    action.method = 'FLAT_OFF';
    action.amount = toPaisa(getsValue.value ?? getsValue.detail?.effect?.value);
  } else {
    action.method = 'FREE';
  }

  const getMatch = buildMatcher(gets?.items, idMapping, 1);
  unmappedIds.push(...getMatch.unmapped);
  action.buy_rules = buyRules;
  action.get_rule = getMatch.matcher || { all_products: true };
  action.get_quantity = getQty;

  return { type: 'BXGY', actions: [action], cartConditions: null, unmappedIds };
}

// Read Shopify minimum_requirement into a normalized {kind, value}.
function readMinimum(discount) {
  const mr = discount.minimum_requirement;
  if (mr?.type === 'subtotal' && mr.value != null) {
    const v = Number(mr.value);
    if (Number.isFinite(v) && v > 0) return { kind: 'subtotal', value: v };
  } else if (mr?.type === 'quantity' && mr.value != null) {
    const v = Number(mr.value);
    if (Number.isFinite(v) && v > 0) return { kind: 'quantity', value: v };
  }
  return { kind: 'none' };
}

/**
 * Build a V2 ProductMatcher from Shopify items.
 * OpenStore reuses Shopify numeric IDs for PRODUCTS and VARIANTS (verified), so those map by
 * stripping the gid prefix. COLLECTIONS are the exception: OS assigns its OWN internal id and
 * stores the Shopify id under `external_id`, so collections MUST be translated via idMapping
 * (built from the OS /collections endpoint). Using a raw Shopify collection id would match no
 * OS collection and silently break the scope.
 * match_by values follow the V2 spec: Id (product_id) | VariantId | CollectionId | Tag.
 * Returns { matcher|null, unmapped[] }.
 */
function buildMatcher(items, idMapping, minQty = 1) {
  if (!items || items.type === 'all') {
    return { matcher: { all_products: true, min_quantity: minQty }, unmapped: [] };
  }

  if (items.type === 'specific_collections' && items.collections?.length > 0) {
    const ids = [];
    const unmapped = [];
    for (const c of items.collections) {
      const shopifyId = extractNumericId(c.id);
      const osId = idMapping?.getCollection ? idMapping.getCollection(shopifyId) : null;
      if (osId) ids.push(String(osId));
      else unmapped.push(shopifyId);
    }
    if (ids.length === 0) return { matcher: null, unmapped };
    return { matcher: { match_by: 'CollectionId', ids, min_quantity: minQty }, unmapped };
  }

  if (items.type === 'specific_products') {
    if (items.product_variants?.length > 0) {
      const ids = items.product_variants.map(v => extractNumericId(v.id)).filter(Boolean);
      return { matcher: { match_by: 'VariantId', ids, min_quantity: minQty }, unmapped: [] };
    }
    if (items.products?.length > 0) {
      const ids = items.products.map(p => extractNumericId(p.id)).filter(Boolean);
      return { matcher: { match_by: 'Id', ids, min_quantity: minQty }, unmapped: [] };
    }
  }

  return { matcher: null, unmapped: [] };
}

function extractNumericId(gid) {
  if (!gid) return null;
  const match = String(gid).match(/(\d+)$/);
  return match ? match[1] : gid;
}

/**
 * Determines if a discount should use discount set (multiple codes)
 */
export function shouldUseDiscountSet(shopifyDiscount) {
  return shopifyDiscount.code_count > 1;
}

// Derive a usable code from the discount title (for codeless/automatic Shopify discounts).
// OS mandates a code even though these auto-apply in Shopify; the title (e.g. "OFF15")
// is a meaningful, usable code — far better than a random string.
function titleAsCode(title) {
  if (!title) return null;
  const c = String(title).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length >= 3 ? c : null;
}

// Some Shopify apps create discounts with an unfilled placeholder title. Show something useful
// in OS instead of a wall of identical "{DISCOUNT_NAME}" rows.
const PLACEHOLDER_TITLE = /^\{.*\}$/; // e.g. "{DISCOUNT_NAME}"
function isPlaceholderTitle(t) {
  return !t || !String(t).trim() || PLACEHOLDER_TITLE.test(String(t).trim());
}

/**
 * Prepares payload for a single-code discount (strips _meta, derives the code/title).
 */
export function prepareSingleCodePayload(openStoreDiscount) {
  const realCode = openStoreDiscount._meta.codes[0]?.code;
  // Codeless (Shopify automatic) discounts: use the title as the code, not a random string.
  const code = realCode || titleAsCode(openStoreDiscount.title) || generateCode();

  const payload = { ...openStoreDiscount };
  delete payload._meta;

  // If the Shopify title is a placeholder/empty, use the code as the title so the dashboard
  // shows a meaningful, unique name instead of many identical "{DISCOUNT_NAME}" entries.
  if (isPlaceholderTitle(payload.title)) {
    payload.title = code;
    payload.description = code;
    payload.terms_and_conditions = [code];
  }

  return { ...payload, code };
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
