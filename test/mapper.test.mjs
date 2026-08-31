import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDiscountToOpenStore, prepareSingleCodePayload } from '../src/discount-mapper.mjs';

// idMapping stub: collections translate to OS internal ids; customers to OS UUIDs.
const idMapping = {
  getCollection: (shopifyId) => (shopifyId === '999' ? null : 'OS_' + shopifyId),
  getCustomer: (shopifyId) => 'CUST_' + shopifyId,
  collections: {},
  customers: {},
};

test('V4 shape: flat amount off, collection-scoped -> CART + CART_QUANTITY + product_matchers', () => {
  const d = {
    title: 'DD150', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'fixed_amount', value: 150,
    starts_at: '2026-08-20T00:00:00Z',
    codes: [{ code: 'DD150' }], code_count: 1,
    items: { type: 'specific_collections', collections: [{ id: 'gid://shopify/Collection/290444673201' }] },
    customer_selection: { type: 'all' },
  };
  const m = mapDiscountToOpenStore(d, idMapping);
  const p = prepareSingleCodePayload(m);
  assert.equal(p.type, 'CART');
  assert.equal(p.status, 'published');
  assert.equal(p.code, 'DD150');
  // money -> paisa
  assert.deepEqual(p.actions, [{ type: 'CART', method: 'FLAT_OFF', amount: 15000 }]);
  // scope rides on CART_QUANTITY (CART_AMOUNT rejects product_matchers)
  assert.equal(p.cart_conditions.type, 'CART_QUANTITY');
  const matcher = p.cart_conditions.product_matchers[0];
  assert.equal(matcher.match_by, 'CollectionId');
  assert.deepEqual(matcher.ids, ['OS_290444673201']); // translated to OS id
  assert.equal(matcher.min_quantity, 1);
});

test('percentage off, no scope, subtotal minimum -> CART_AMOUNT (min in paisa), no matchers', () => {
  const d = {
    title: '20% off', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'percentage', value: 20,
    codes: [{ code: 'PCT20' }], code_count: 1,
    items: { type: 'all' },
    minimum_requirement: { type: 'subtotal', value: 1000 },
    customer_selection: { type: 'all' },
  };
  const p = prepareSingleCodePayload(mapDiscountToOpenStore(d, idMapping));
  assert.deepEqual(p.actions, [{ type: 'CART', method: 'PERCENT_OFF', amount: 20 }]);
  assert.equal(p.cart_conditions.type, 'CART_AMOUNT');
  assert.equal(p.cart_conditions.min_value, 100000); // 1000 rupees -> paisa
  assert.equal(p.cart_conditions.reference, 'SUBTOTAL');
  assert.ok(!p.cart_conditions.product_matchers);
});

test('scoped PERCENTAGE -> PRODUCT action with buy_rules (applies to scoped items, not whole cart)', () => {
  const d = {
    title: 'VINU10', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'percentage', value: 10,
    codes: [{ code: 'VINU10' }], code_count: 1,
    items: { type: 'specific_collections', collections: [{ id: 'gid://shopify/Collection/167521615949' }] },
    customer_selection: { type: 'all' },
  };
  const p = prepareSingleCodePayload(mapDiscountToOpenStore(d, idMapping));
  const a = p.actions[0];
  assert.equal(a.type, 'PRODUCT'); // NOT CART — a CART % would discount the whole cart
  assert.equal(a.method, 'PERCENT_OFF');
  assert.equal(a.amount, 10);
  assert.equal(a.buy_rules[0].match_by, 'CollectionId');
  assert.deepEqual(a.buy_rules[0].ids, ['OS_167521615949']);
  // and it still displays: product_matchers present on cart_conditions
  assert.equal(p.cart_conditions.product_matchers[0].match_by, 'CollectionId');
});

test('scoped FLAT amount stays CART-level (matches dashboard flat+collection shape)', () => {
  const d = {
    title: 'DD150', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'fixed_amount', value: 150,
    codes: [{ code: 'DD150' }], code_count: 1,
    items: { type: 'specific_collections', collections: [{ id: 'gid://shopify/Collection/290444673201' }] },
    customer_selection: { type: 'all' },
  };
  const p = prepareSingleCodePayload(mapDiscountToOpenStore(d, idMapping));
  assert.equal(p.actions[0].type, 'CART');
  assert.equal(p.actions[0].method, 'FLAT_OFF');
  assert.ok(!p.actions[0].buy_rules); // flat is cart-level, no buy_rules
  assert.equal(p.cart_conditions.product_matchers[0].match_by, 'CollectionId');
});

test('scoped + subtotal minimum -> CART_QUANTITY with matcher.min_value (paisa)', () => {
  const d = {
    title: 'welcome', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'percentage', value: 5,
    codes: [{ code: 'WELCOME' }], code_count: 1,
    items: { type: 'specific_collections', collections: [{ id: 'gid://shopify/Collection/292960665777' }] },
    minimum_requirement: { type: 'subtotal', value: 2499 },
    customer_selection: { type: 'all' },
  };
  const p = prepareSingleCodePayload(mapDiscountToOpenStore(d, idMapping));
  assert.equal(p.cart_conditions.type, 'CART_QUANTITY');
  const matcher = p.cart_conditions.product_matchers[0];
  assert.equal(matcher.match_by, 'CollectionId');
  assert.equal(matcher.min_value, 249900); // subtotal min carried on the matcher, in paisa
});

test('variant-scoped uses match_by VariantId with raw Shopify ids (OS reuses them)', () => {
  const d = {
    title: 'v', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'fixed_amount', value: 100,
    codes: [{ code: 'VAR' }], code_count: 1,
    items: { type: 'specific_products', product_variants: [{ id: 'gid://shopify/ProductVariant/44184357666950' }] },
    customer_selection: { type: 'all' },
  };
  const p = prepareSingleCodePayload(mapDiscountToOpenStore(d, idMapping));
  const matcher = p.cart_conditions.product_matchers[0];
  assert.equal(matcher.match_by, 'VariantId');
  assert.deepEqual(matcher.ids, ['44184357666950']);
});

test('exhausted usage is flagged in _meta (caller drafts it); total_uses = remaining', () => {
  const d = {
    title: 'used', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'fixed_amount', value: 50,
    codes: [{ code: 'USED' }], code_count: 1,
    usage_limit: 10, usage_count: 10,
    items: { type: 'all' },
    customer_selection: { type: 'all' },
  };
  const m = mapDiscountToOpenStore(d, idMapping);
  assert.equal(m._meta.exhausted, true);
  assert.equal(m.usage_limit.total_uses, 0); // remaining 0 (can't express; flag handles drafting)

  const d2 = { ...d, usage_limit: 10, usage_count: 3 };
  const m2 = mapDiscountToOpenStore(d2, idMapping);
  assert.equal(m2._meta.exhausted, false);
  assert.equal(m2.usage_limit.total_uses, 7); // remaining
});

test('customer-specific targeting maps to OS UUIDs; all-collections-unmapped records unmappedIds', () => {
  const d = {
    title: 'vip', status: 'ACTIVE', normalized_type: 'code_basic',
    value_type: 'percentage', value: 10,
    codes: [{ code: 'VIP' }], code_count: 1,
    items: { type: 'specific_collections', collections: [{ id: 'gid://shopify/Collection/999' }] }, // 999 -> unmapped
    customer_selection: { type: 'specific_customers', customers: [{ id: 'gid://shopify/Customer/555' }] },
  };
  const m = mapDiscountToOpenStore(d, idMapping);
  assert.equal(m.targeting.applicable_for_all_users, false);
  assert.deepEqual(m.targeting.applicable_user_ids, ['CUST_555']);
  assert.deepEqual(m._meta.unmappedIds, ['999']); // collection not in OS -> caller drafts it
});

test('BXGY maps to type BXGY with buy_rules/get_rule/get_quantity', () => {
  const d = {
    title: 'b2g1', status: 'ACTIVE', normalized_type: 'automatic_bxgy',
    codes: [{ code: 'B2G1' }], code_count: 1,
    customer_selection: { type: 'all' },
    bxgy_configuration: {
      customer_buys: { value: { type: 'quantity', quantity: 2 }, items: { type: 'all' } },
      customer_gets: { value: { value_type: 'percentage', value: 100 }, items: { type: 'all' } },
    },
  };
  const p = prepareSingleCodePayload(mapDiscountToOpenStore(d, idMapping));
  assert.equal(p.type, 'BXGY');
  const a = p.actions[0];
  assert.equal(a.type, 'BXGY');
  assert.equal(a.method, 'FREE'); // 100% -> free
  assert.equal(a.get_quantity, 1);
  assert.equal(a.buy_rules[0].min_quantity, 2);
});
