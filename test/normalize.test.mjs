import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCsvRows, normalizeExtraction } from '../src/normalize.mjs';

test('normalizeExtraction keeps active/scheduled, drops expired, flags app discounts', () => {
  const extraction = normalizeExtraction({
    shopInfo: {
      name: 'Demo Shop',
      myshopifyDomain: 'demo.myshopify.com',
      currencyCode: 'USD',
      ianaTimezone: 'America/New_York',
    },
    rawDiscountNodes: [
      {
        id: 'gid://shopify/DiscountCodeNode/1',
        discount: {
          __typename: 'DiscountCodeBasic',
          title: 'WELCOME10',
          status: 'ACTIVE',
          startsAt: '2026-03-01T00:00:00Z',
          endsAt: null,
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
          usageLimit: 100,
          asyncUsageCount: 12,
          appliesOncePerCustomer: true,
          combinesWith: {
            productDiscounts: false,
            orderDiscounts: false,
            shippingDiscounts: true,
          },
          context: {
            __typename: 'DiscountBuyerSelectionAll',
            all: 'ALL',
          },
          minimumRequirement: {
            __typename: 'DiscountMinimumSubtotal',
            greaterThanOrEqualToSubtotal: {
              amount: '50.00',
              currencyCode: 'USD',
            },
          },
          customerGets: {
            value: {
              __typename: 'DiscountPercentage',
              percentage: 0.1,
            },
            items: {
              __typename: 'AllDiscountItems',
              allItems: true,
            },
          },
          codes: {
            nodes: [
              {
                id: 'gid://shopify/DiscountRedeemCode/1',
                code: 'WELCOME10',
                asyncUsageCount: 12,
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      },
      {
        id: 'gid://shopify/DiscountAutomaticNode/2',
        discount: {
          __typename: 'DiscountAutomaticApp',
          title: 'Bundle Volume',
          status: 'ACTIVE',
          startsAt: '2026-02-01T00:00:00Z',
          endsAt: null,
          createdAt: '2026-02-01T00:00:00Z',
          updatedAt: '2026-02-01T00:00:00Z',
          asyncUsageCount: 3,
          combinesWith: {
            productDiscounts: true,
            orderDiscounts: false,
            shippingDiscounts: false,
          },
          context: {
            __typename: 'DiscountBuyerSelectionAll',
            all: 'ALL',
          },
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: false,
          recurringCycleLimit: 0,
          appDiscountType: {
            appKey: 'bundle-app',
            functionId: 'function-123',
            title: 'Bundle App',
            description: 'Bundle logic',
            discountClasses: ['PRODUCT'],
          },
        },
        metafields: [
          {
            namespace: 'app',
            key: 'function-configuration',
            type: 'json',
            value: '{"tiers":[{"quantity":3,"percentage":10}]}',
          },
        ],
      },
      {
        id: 'gid://shopify/DiscountAutomaticNode/3',
        discount: {
          __typename: 'DiscountAutomaticBasic',
          title: 'Too Old',
          status: 'EXPIRED',
          startsAt: '2025-01-01T00:00:00Z',
          endsAt: '2025-01-10T00:00:00Z',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          asyncUsageCount: 0,
          combinesWith: {
            productDiscounts: false,
            orderDiscounts: false,
            shippingDiscounts: false,
          },
          context: {
            __typename: 'DiscountBuyerSelectionAll',
            all: 'ALL',
          },
          minimumRequirement: null,
          customerGets: {
            value: {
              __typename: 'DiscountAmount',
              appliesOnEachItem: false,
              amount: {
                amount: '5.00',
                currencyCode: 'USD',
              },
            },
            items: {
              __typename: 'AllDiscountItems',
              allItems: true,
            },
          },
        },
      },
    ],
    config: {
      merchantSlug: 'demo-shop',
      recentlyExpiredDays: 30,
    },
    extractedAt: '2026-03-17T12:00:00Z',
  });

  assert.equal(extraction.discounts.length, 2); // the two ACTIVE ones; the EXPIRED "Too Old" is dropped
  assert.equal(extraction.summary.by_type.code_basic, 1);
  assert.equal(extraction.summary.by_type.automatic_app, 1);
  assert.equal(extraction.summary.by_status.active, 2);
  assert.equal(extraction.discounts[0].value, 10);
  assert.equal(extraction.discounts[1].migration_status, 'needs_review');
  assert.deepEqual(extraction.discounts[1].app_config.function_configuration, {
    tiers: [{ quantity: 3, percentage: 10 }],
  });
});

test('buildCsvRows flattens discounts for review', () => {
  const rows = buildCsvRows({
    discounts: [
      {
        shopify_id: 'gid://shopify/DiscountCodeNode/1',
        title: 'WELCOME10',
        normalized_type: 'code_basic',
        status: 'ACTIVE',
        value_type: 'percentage',
        value: 10,
        activation_method: 'code',
        codes: [{ code: 'WELCOME10' }],
        starts_at: '2026-03-01T00:00:00Z',
        ends_at: null,
        usage_limit: 100,
        usage_count: 12,
        items: { type: 'all' },
        migration_status: 'ready',
        migration_notes: null,
      },
    ],
  });

  assert.equal(rows[0].code, 'WELCOME10');
  assert.equal(rows[0].value, '10%');
  assert.equal(rows[0].scope, 'All products');
});
