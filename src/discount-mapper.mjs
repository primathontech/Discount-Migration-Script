import { IdMapping } from './id-mapping.mjs';

/**
 * Shopify stores money in rupees; the OpenStore create endpoint stores it in PAISA
 * (confirmed: sending value 539.1 displayed as ₹5.39). Convert money rupees -> paisa.
 * Do NOT apply to percentages or quantities.
 */
function toPaisa(rupees) {
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : rupees;
}

/**
 * Maps Shopify discount format to OpenStore format — matches the PROD dashboard's own
 * create payload (POST /v3/api/api/v1/admin/os-discount/create). Money is sent in PAISA;
 * status:published so active discounts go live.
 * @param {Object} shopifyDiscount - The Shopify discount
 * @param {IdMapping} idMapping - ID mapping for collections/products/variants
 */
export function mapDiscountToOpenStore(shopifyDiscount, idMapping = new IdMapping()) {
  // Usage: OS tracks its own used-count from 0 (can't seed "already used"), and coerces
  // available_coupons:0 to unlimited. So we set available_coupons = REMAINING (limit-used).
  // Exhausted (remaining 0) -> can't express as 0, so flag it to be created as draft.
  const usageLimit = shopifyDiscount.usage_limit;
  const usageCount = shopifyDiscount.usage_count || 0;
  const remaining = usageLimit != null ? Math.max(usageLimit - usageCount, 0) : null;
  const exhausted = remaining === 0;

  const base = {
    applicable_for_all_merchants: false,
    frequency: 'unlimited',
    applicable_device: 'website',
    title: shopifyDiscount.title,
    description: shopifyDiscount.title,
    visibility: 'hidden',
    // Active Shopify discounts must land published; others stay draft.
    status: shopifyDiscount.status === 'ACTIVE' ? 'published' : 'draft',
    start_date: shopifyDiscount.starts_at || new Date().toISOString(),
    end_date: shopifyDiscount.ends_at || '9999-12-31T23:59:59Z',
    terms_and_conditions: shopifyDiscount.title ? [shopifyDiscount.title] : [],
    applicable_for_all_users: mapCustomerSelection(shopifyDiscount.customer_selection),
    exclude_applicable_user_id: false,
    applicable_user_categories: [],
    // Customer-specific discounts: OS assigns its OWN customer UUID (NOT the Shopify id),
    // so translate via idMapping.customers (built from email lookup / create in stage 2).
    applicable_user_id: mapCustomerUserIds(shopifyDiscount.customer_selection, idMapping),
    // Remaining uses (limit - already used); no limit -> effectively unlimited.
    available_coupons: remaining == null ? 1000000 : (remaining >= 1 ? remaining : 1),
    max_coupon_per_customer: shopifyDiscount.once_per_customer ? 1 : 1000000,
  };

  // Map rules based on discount type
  const { rules, unmappedIds } = mapRules(shopifyDiscount, idMapping);

  return {
    ...base,
    rules,
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
// customer's email against OS in stage 2). Falls back to nothing if unresolved (the caller
// tracks that so we don't silently target the wrong/empty audience).
function mapCustomerUserIds(customerSelection, idMapping) {
  if (!customerSelection || customerSelection.type !== 'specific_customers') return [];
  return (customerSelection.customers ?? [])
    .map(c => (idMapping?.getCustomer ? idMapping.getCustomer(extractNumericId(c.id)) : null))
    .filter(Boolean);
}

function mapRules(discount, idMapping) {
  switch (discount.normalized_type) {
    case 'code_basic':
    case 'automatic_basic':
      return mapBasicDiscountRules(discount, idMapping);

    case 'code_bxgy':
    case 'automatic_bxgy':
      return mapBxgyRules(discount, idMapping);

    case 'code_free_shipping':
    case 'automatic_free_shipping':
      return { rules: [], unmappedIds: [] };

    default:
      return { rules: [], unmappedIds: [] };
  }
}

function mapBasicDiscountRules(discount, idMapping) {
  const conditions = [];
  const actions = [];
  const unmappedIds = [];

  const isAllProducts = discount.items?.type === 'all' || !discount.items;
  const isPercentage = discount.value_type === 'percentage';
  const isFixedAmount = discount.value_type === 'fixed_amount';

  // Build conditions
  const condition = {
    discount_type: 'CartDiscount',
  };

  // Add minimum requirement (value can be string or number)
  if (discount.minimum_requirement?.type === 'subtotal' && discount.minimum_requirement.value != null) {
    const value = Number(discount.minimum_requirement.value);
    if (!isNaN(value) && value > 0) {
      condition.min_cart_value = toPaisa(value); // money -> paisa
    }
  } else if (discount.minimum_requirement?.type === 'quantity' && discount.minimum_requirement.value != null) {
    const value = Number(discount.minimum_requirement.value);
    if (!isNaN(value) && value > 0) {
      condition.min_product_quantity = value;
    }
  }

  // Resolve product scope
  let resolvedAllProducts = isAllProducts;
  let resolvedAttribute = null;
  let resolvedList = [];

  if (!isAllProducts) {
    const { productAttribute, applicableList, unmapped } = mapItemsToOpenStore(discount.items, idMapping);
    unmappedIds.push(...unmapped);

    // OpenStore supports ProductId / VariantId / CollectionId scopes (confirmed via the
    // dashboard "Amount off products" form). IDs are the Shopify numeric IDs (OS reuses them).
    if (productAttribute && applicableList.length > 0) {
      resolvedAttribute = productAttribute;
      resolvedList = applicableList;
    } else {
      // No resolvable scope (empty list) — fall back to cart-level rather than fail.
      resolvedAllProducts = true;
    }
  }

  if (resolvedAllProducts) {
    condition.allow_all = true;
    if (condition.min_product_quantity) {
      delete condition.min_product_quantity;
    }
  } else {
    condition.product_attribute = resolvedAttribute;
    condition.applicable_list = resolvedList;
    if (!condition.min_product_quantity || typeof condition.min_product_quantity !== 'number') {
      condition.min_product_quantity = 1;
    }
  }

  conditions.push(condition);

  // Build actions (money in RUPEES)
  const action = {
    discount_type: 'CartDiscount',
  };

  if (resolvedAllProducts) {
    // Cart-level discount
    if (isPercentage) {
      action.applicability_type = 'cart_percentage_discount';
      action.value = discount.value; // percentage — no paisa conversion
    } else if (isFixedAmount) {
      action.applicability_type = 'cart_fixed_discount';
      action.value = toPaisa(discount.value); // money -> paisa
    }
  } else {
    // Product-level discount
    action.applicability_type = 'product_discount';
    action.discount_method = isPercentage ? 'percentage' : 'flat';
    action.value = isPercentage ? discount.value : toPaisa(discount.value); // flat money -> paisa
    action.product_attribute = resolvedAttribute;
    action.eligible_list = resolvedList;
  }

  actions.push(action);

  return {
    rules: [{
      priority: 1,
      conditions,
      actions,
    }],
    unmappedIds,
  };
}

function mapBxgyRules(discount, idMapping) {
  const bxgyConfig = discount.bxgy_configuration;
  if (!bxgyConfig) {
    return { rules: [], unmappedIds: [] };
  }

  const conditions = [];
  const actions = [];
  const unmappedIds = [];

  // Build conditions (customer_buys)
  const customerBuys = bxgyConfig.customer_buys;
  const condition = {
    discount_type: 'BxGy',
  };

  if (customerBuys?.value?.type === 'quantity' && customerBuys.value.quantity != null) {
    const qty = Number(customerBuys.value.quantity);
    condition.min_product_quantity = isNaN(qty) || qty < 1 ? 1 : qty;
  } else {
    condition.min_product_quantity = 1;
  }

  if (customerBuys?.items?.type === 'all') {
    condition.allow_all = true;
  } else if (customerBuys?.items) {
    const { productAttribute, applicableList, unmapped } = mapItemsToOpenStore(customerBuys.items, idMapping);
    unmappedIds.push(...unmapped);
    if (productAttribute && applicableList.length > 0) {
      condition.product_attribute = productAttribute;
      condition.applicable_list = applicableList;
    } else {
      condition.allow_all = true;
    }
  } else {
    condition.allow_all = true;
  }

  conditions.push(condition);

  // Build actions (customer_gets)
  const customerGets = bxgyConfig.customer_gets;
  const action = {
    discount_type: 'BxGy',
  };

  // Determine eligible quantity (the "Get Y" part)
  const getsValue = customerGets?.value;
  let eligibleQty = 1;
  if (getsValue?.detail?.quantity?.quantity != null) {
    eligibleQty = Number(getsValue.detail.quantity.quantity);
  } else if (getsValue?.detail?.quantity != null) {
    eligibleQty = Number(getsValue.detail.quantity);
  }
  action.eligible_qty = isNaN(eligibleQty) || eligibleQty < 1 ? 1 : eligibleQty;

  // Discount method
  if (getsValue?.value_type === 'percentage' || getsValue?.detail?.effect?.value_type === 'percentage') {
    const percentage = getsValue.value || getsValue.detail?.effect?.value;
    if (percentage === 100) {
      action.discount_method = 'free';
    } else {
      action.discount_method = 'percentage';
      action.value = percentage;
    }
  } else if (getsValue?.value_type === 'fixed_amount' || getsValue?.detail?.effect?.value_type === 'fixed_amount') {
    action.discount_method = 'flat';
    action.value = toPaisa(getsValue.value || getsValue.detail?.effect?.value); // money -> paisa
  } else {
    action.discount_method = 'free';
  }

  // Eligible items
  if (customerGets?.items?.type === 'all') {
    action.allow_all = true;
  } else if (customerGets?.items) {
    const { productAttribute, applicableList, unmapped } = mapItemsToOpenStore(customerGets.items, idMapping);
    unmappedIds.push(...unmapped);
    if (productAttribute && applicableList.length > 0) {
      action.product_attribute = productAttribute;
      action.eligible_list = applicableList;
    } else {
      action.allow_all = true;
    }
  } else {
    action.allow_all = true;
  }

  actions.push(action);

  return {
    rules: [{
      priority: 1,
      conditions,
      actions,
    }],
    unmappedIds,
  };
}

function mapFreeShippingRules(discount, idMapping) {
  // OpenStore may not have direct free shipping support
  // Return empty rules with a warning
  return { rules: [], unmappedIds: [] };
}

function mapItemsToOpenStore(items, idMapping) {
  if (!items) {
    return { productAttribute: null, applicableList: [], unmapped: [] };
  }

  // OpenStore reuses Shopify's numeric IDs for PRODUCTS and VARIANTS (verified:
  // admin_graphql_api_id "gid://shopify/Product/<id>" == OS product id), so those map by
  // stripping the gid prefix. COLLECTIONS are the exception: OS assigns its OWN internal
  // collection id and stores the Shopify id under `external_id`. So collections MUST be
  // translated via idMapping (built from the OS /collections endpoint) — using the raw
  // Shopify collection id would match no OS collection and silently break the scope.
  // Attribute names are SINGULAR, matching the dashboard payload (product_attribute: "VariantId").
  if (items.type === 'specific_collections' && items.collections?.length > 0) {
    const mapped = [];
    const unmapped = [];
    for (const c of items.collections) {
      const shopifyId = extractNumericId(c.id);
      const osId = idMapping?.getCollection ? idMapping.getCollection(shopifyId) : null;
      if (osId) {
        mapped.push(String(osId));
      } else {
        unmapped.push(shopifyId);
      }
    }
    return {
      productAttribute: 'CollectionId',
      applicableList: mapped,
      unmapped,
    };
  }

  if (items.type === 'specific_products') {
    if (items.product_variants?.length > 0) {
      return {
        productAttribute: 'VariantId',
        applicableList: items.product_variants.map(v => extractNumericId(v.id)).filter(Boolean),
        unmapped: [],
      };
    }
    if (items.products?.length > 0) {
      return {
        productAttribute: 'ProductId',
        applicableList: items.products.map(p => extractNumericId(p.id)).filter(Boolean),
        unmapped: [],
      };
    }
  }

  return { productAttribute: null, applicableList: [], unmapped: [] };
}

function extractNumericId(gid) {
  if (!gid) return null;
  const match = gid.match(/(\d+)$/);
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

/**
 * Prepares payload for single-code discount
 */
// Some Shopify apps create discounts with an unfilled placeholder title. Show something useful
// in OS instead of a wall of identical "{DISCOUNT_NAME}" rows.
const PLACEHOLDER_TITLE = /^\{.*\}$/; // e.g. "{DISCOUNT_NAME}"
function isPlaceholderTitle(t) {
  return !t || !String(t).trim() || PLACEHOLDER_TITLE.test(String(t).trim());
}

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

  return {
    ...payload,
    code,
  };
}

/**
 * Prepares payload for discount set (multiple codes)
 */
export function prepareDiscountSetPayload(openStoreDiscount) {
  const codes = openStoreDiscount._meta.codes || [];
  const primaryCode = codes[0]?.code || generateCode();

  const payload = { ...openStoreDiscount };
  delete payload._meta;

  // For discount sets with specific codes
  if (codes.length > 0) {
    return {
      ...payload,
      code: primaryCode,
      number_of_random_coupons: codes.length,
      // OpenStore generates random codes, we'll need to handle specific codes differently
      // For now, generate random codes with a prefix based on the discount title
      prefix: `${sanitizePrefix(openStoreDiscount.title)}-`,
      suffix: '',
      length: 6,
      max_discount_per_user: payload.max_coupon_per_customer,
    };
  }

  return {
    ...payload,
    code: primaryCode,
    number_of_random_coupons: 1,
  };
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function sanitizePrefix(title) {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}
