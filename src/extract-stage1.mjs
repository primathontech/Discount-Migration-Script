import { DISCOUNT_METAFIELDS_QUERY, LIST_DISCOUNTS_QUERY, PAGINATE_CODES_QUERY, SHOP_INFO_QUERY } from './queries.mjs';
import { runBulkOperation, downloadBulkOperationResult, parseBulkCodesResult, buildBulkAllCodesQuery } from './bulk-operations.mjs';

export async function extractStage1({ client, config }) {
  console.log('Fetching shop info...');
  const shopInfo = await extractShopInfo(client);
  console.log(`Shop: ${shopInfo.name}`);

  const filterLabel = config.discountQuery ? ` (filter: ${config.discountQuery})` : '';
  console.log(`Fetching discount nodes${filterLabel}...`);
  const rawDiscountNodes = await extractDiscountNodes({ client, config });
  console.log(`Found ${rawDiscountNodes.length} discounts`);

  // Count code discounts that need more codes fetched
  const codeDiscounts = rawDiscountNodes.filter(n => isCodeDiscount(n.discount?.__typename));
  const needsMoreCodes = codeDiscounts.filter(n => n.discount.codes?.pageInfo?.hasNextPage);

  console.log(`Code discounts: ${codeDiscounts.length} total, ${needsMoreCodes.length} have >100 codes`);

  // Hybrid approach: bulk ops gets first 100, then paginate for the rest
  if (needsMoreCodes.length > 0) {
    console.log('\nRunning Bulk Operations API to extract discount codes (up to 100 per discount)...');

    try {
      const bulkQuery = buildBulkAllCodesQuery(config.discountQuery);
      const url = await runBulkOperation(client, bulkQuery);

      if (url) {
        console.log('Downloading and parsing bulk results...');
        const jsonlObjects = await downloadBulkOperationResult(url);
        const codesMap = parseBulkCodesResult(jsonlObjects);

        // Update code discounts with bulk-extracted codes (up to 100 each)
        let totalBulkCodes = 0;
        for (const rawDiscountNode of codeDiscounts) {
          const codes = codesMap.get(rawDiscountNode.id) ?? [];
          if (codes.length > 0) {
            totalBulkCodes += codes.length;
            rawDiscountNode.discount.codes = {
              nodes: codes,
              pageInfo: rawDiscountNode.discount.codes?.pageInfo ?? { hasNextPage: false, endCursor: null },
              _extractedVia: 'bulk_operation',
            };
          }
        }
        console.log(`Bulk extracted ${totalBulkCodes} codes across ${codeDiscounts.length} discounts`);
      }
    } catch (err) {
      console.error(`Bulk operation failed: ${err.message}`);
    }

    // Now paginate for discounts that have more than 100 codes
    console.log(`\nPaginating ${needsMoreCodes.length} discounts with >100 codes...`);
    console.log('(This may take a while for large code sets)\n');

    for (let i = 0; i < needsMoreCodes.length; i++) {
      const rawDiscountNode = needsMoreCodes[i];
      const title = rawDiscountNode.discount?.title ?? 'Untitled';
      const initialCount = rawDiscountNode.discount.codes?.nodes?.length ?? 0;

      process.stdout.write(`[${i + 1}/${needsMoreCodes.length}] "${title}" (${initialCount} from bulk, fetching more)...`);

      rawDiscountNode.discount.codes = await extractAllCodes({
        client,
        discountNodeId: rawDiscountNode.id,
        initialConnection: rawDiscountNode.discount.codes,
        config,
      });

      console.log(` ${rawDiscountNode.discount.codes.nodes.length} total`);
    }
  }

  // Process app discounts (metafields)
  const appDiscounts = rawDiscountNodes.filter(n => isAppDiscount(n.discount?.__typename));
  if (appDiscounts.length > 0) {
    console.log(`\nFetching metafields for ${appDiscounts.length} app discounts...`);
    for (let i = 0; i < appDiscounts.length; i++) {
      const rawDiscountNode = appDiscounts[i];
      const title = rawDiscountNode.discount?.title ?? 'Untitled';

      process.stdout.write(`[${i + 1}/${appDiscounts.length}] "${title}"...`);
      rawDiscountNode.metafields = await extractAllMetafields({
        client,
        discountNodeId: rawDiscountNode.id,
        config,
      });
      console.log(` ${rawDiscountNode.metafields.length} metafields`);
    }
  }

  console.log('\nExtraction complete.');
  return {
    shopInfo,
    rawDiscountNodes,
  };
}

async function extractShopInfo(client) {
  const response = await client.graphql(SHOP_INFO_QUERY);
  return response.data.shop;
}

async function extractDiscountNodes({ client, config }) {
  const nodes = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    process.stdout.write(`  Fetching page ${page} (${nodes.length} discounts so far)...\r`);

    const response = await client.graphql(LIST_DISCOUNTS_QUERY, {
      cursor,
      pageSize: config.discountPageSize,
      query: config.discountQuery ?? null,
    });

    const connection = response.data.discountNodes;
    for (const edge of connection.edges) {
      nodes.push(edge.node);
    }

    if (!connection.pageInfo.hasNextPage) {
      console.log(`  Fetched ${page} pages, ${nodes.length} discounts total`);
      break;
    }

    cursor = connection.pageInfo.endCursor;
  }

  return nodes;
}

async function extractAllCodes({ client, discountNodeId, initialConnection, config }) {
  const nodes = [...(initialConnection?.nodes ?? [])];
  let hasNextPage = Boolean(initialConnection?.pageInfo?.hasNextPage);
  let cursor = initialConnection?.pageInfo?.endCursor ?? null;
  let pageCount = 0;

  while (hasNextPage) {
    pageCount++;
    if (pageCount % 100 === 0) {
      process.stdout.write(`\n      ${nodes.length} codes fetched...`);
    }

    const response = await client.graphql(PAGINATE_CODES_QUERY, {
      id: discountNodeId,
      cursor,
      pageSize: config.codePageSize,
    });

    const codeDiscount = response.data.node?.codeDiscount;
    const connection = codeDiscount?.codes;
    if (!connection) {
      break;
    }

    nodes.push(...connection.nodes);
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor ?? null;
  }

  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: cursor,
    },
  };
}

async function extractAllMetafields({ client, discountNodeId, config }) {
  const nodes = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await client.graphql(DISCOUNT_METAFIELDS_QUERY, {
      id: discountNodeId,
      cursor,
      pageSize: config.metafieldPageSize,
    });

    const connection = response.data.node?.metafields;
    if (!connection) {
      break;
    }

    nodes.push(...connection.nodes);
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor ?? null;
  }

  return nodes;
}

function isCodeDiscount(typename) {
  return typeof typename === 'string' && typename.startsWith('DiscountCode');
}

function isAppDiscount(typename) {
  return typeof typename === 'string' && typename.endsWith('App');
}
