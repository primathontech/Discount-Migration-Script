import { BULK_OPERATION_RUN_QUERY, BULK_OPERATION_STATUS_QUERY, BULK_OPERATION_CANCEL } from './queries.mjs';
import { sleep } from './utils.mjs';

/**
 * Run a bulk operation and wait for completion
 * @param {Object} client - ShopifyAdminClient instance
 * @param {string} query - GraphQL query to run in bulk
 * @param {Object} options - Options
 * @returns {Promise<string|null>} - URL to download JSONL file, or null if failed
 */
export async function runBulkOperation(client, query, { pollIntervalMs = 2000, onProgress } = {}) {
  // Cancel any existing bulk operation first
  const currentOp = await getCurrentBulkOperation(client);
  if (currentOp && ['CREATED', 'RUNNING'].includes(currentOp.status)) {
    console.log(`  Canceling existing bulk operation (${currentOp.id})...`);
    await cancelBulkOperation(client, currentOp.id);
    // Wait for cancellation
    await sleep(2000);
  }

  // Start the bulk operation
  const response = await client.graphql(BULK_OPERATION_RUN_QUERY, { query });
  const { bulkOperation, userErrors } = response.data.bulkOperationRunQuery;

  if (userErrors?.length > 0) {
    throw new Error(`Bulk operation failed to start: ${JSON.stringify(userErrors)}`);
  }

  if (!bulkOperation) {
    throw new Error('Bulk operation failed to start: no operation returned');
  }

  console.log(`  Bulk operation started (${bulkOperation.id})`);

  // Poll until complete
  while (true) {
    await sleep(pollIntervalMs);

    const status = await getCurrentBulkOperation(client);
    if (!status) {
      throw new Error('Bulk operation disappeared');
    }

    if (onProgress) {
      onProgress(status);
    }

    switch (status.status) {
      case 'COMPLETED':
        console.log(`  Bulk operation completed: ${status.objectCount} objects, ${formatBytes(status.fileSize)}`);
        return status.url;

      case 'FAILED':
        throw new Error(`Bulk operation failed: ${status.errorCode}`);

      case 'CANCELED':
        throw new Error('Bulk operation was canceled');

      case 'RUNNING':
      case 'CREATED':
        process.stdout.write(`  Processing: ${status.objectCount ?? 0} objects...\r`);
        break;

      default:
        console.log(`  Unknown status: ${status.status}`);
    }
  }
}

/**
 * Get current bulk operation status
 */
async function getCurrentBulkOperation(client) {
  const response = await client.graphql(BULK_OPERATION_STATUS_QUERY);
  return response.data.currentBulkOperation;
}

/**
 * Cancel a bulk operation
 */
async function cancelBulkOperation(client, id) {
  try {
    await client.graphql(BULK_OPERATION_CANCEL, { id });
  } catch (err) {
    // Ignore errors when canceling
  }
}

/**
 * Download and parse JSONL from bulk operation result
 * @param {string} url - URL to JSONL file
 * @returns {Promise<Object[]>} - Parsed objects
 */
export async function downloadBulkOperationResult(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download bulk operation result: ${response.status}`);
  }

  const text = await response.text();
  const lines = text.trim().split('\n').filter(Boolean);

  return lines.map(line => JSON.parse(line));
}

/**
 * Parse bulk operation JSONL into a structured format
 * Shopify returns parent-child relationships via __parentId
 *
 * JSONL structure for our query:
 * - Line 1: { "id": "gid://shopify/DiscountCodeNode/123", ... } (discount node)
 * - Line 2: { "id": "gid://shopify/DiscountRedeemCode/456", "__parentId": "gid://shopify/DiscountCodeNode/123", "code": "ABC", ... }
 *
 * Note: __parentId might point to intermediate objects, so we need to trace the chain
 */
export function parseBulkCodesResult(jsonlObjects) {
  const discountNodes = new Map(); // id -> object
  const parentChain = new Map(); // child id -> parent id
  const codeObjects = []; // all code objects

  // First pass: collect all objects and build parent chain
  for (const obj of jsonlObjects) {
    if (obj.__parentId) {
      parentChain.set(obj.id, obj.__parentId);
    }

    // Check if this is a discount node (has DiscountCodeNode or DiscountAutomaticNode in ID)
    if (obj.id && (obj.id.includes('DiscountCodeNode') || obj.id.includes('DiscountAutomaticNode'))) {
      discountNodes.set(obj.id, obj);
    }

    // Check if this is a code (has DiscountRedeemCode in ID or has 'code' field)
    if (obj.code && obj.id) {
      codeObjects.push(obj);
    }
  }

  // Second pass: trace each code back to its discount node
  const result = new Map();

  for (const codeObj of codeObjects) {
    // Walk up the parent chain to find the discount node
    let currentId = codeObj.__parentId || codeObj.id;
    let discountNodeId = null;
    let maxDepth = 10; // prevent infinite loops

    while (currentId && maxDepth > 0) {
      if (discountNodes.has(currentId)) {
        discountNodeId = currentId;
        break;
      }
      currentId = parentChain.get(currentId);
      maxDepth--;
    }

    if (discountNodeId) {
      if (!result.has(discountNodeId)) {
        result.set(discountNodeId, []);
      }
      result.get(discountNodeId).push({
        id: codeObj.id,
        code: codeObj.code,
        asyncUsageCount: codeObj.asyncUsageCount,
      });
    }
  }

  console.log(`  Parsed ${codeObjects.length} codes, mapped to ${result.size} discount nodes`);

  return result;
}

/**
 * Build a bulk query for extracting codes from a specific discount node
 * Note: Bulk Operations don't use pagination (first/after) - Shopify handles that automatically
 */
export function buildBulkCodesQuery(discountNodeIds) {
  // Extract numeric IDs for the query filter
  const idFilter = discountNodeIds.map(id => {
    const match = id.match(/(\d+)$/);
    return match ? match[1] : id;
  }).join(' OR id:');

  // In bulk operations, connections don't need 'first' parameter
  // Shopify automatically iterates through all items
  return `
    {
      discountNodes(query: "id:${idFilter}") {
        edges {
          node {
            id
            discount {
              ... on DiscountCodeBasic {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeBxgy {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeFreeShipping {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeApp {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `.trim();
}

/**
 * Build a bulk query for extracting ALL discount codes from the entire shop
 * Use this for a full extraction instead of per-discount queries
 *
 * Note: Bulk operations use a simplified query syntax without edges/node wrappers
 * Connections are automatically iterated by Shopify
 */
export function buildBulkAllCodesQuery(queryFilter = null) {
  // Bulk operations query syntax - no edges/node wrappers needed
  // Shopify automatically iterates through all items in connections
  const queryArg = queryFilter ? `(query: "${queryFilter}")` : '';
  return `
    {
      discountNodes${queryArg} {
        edges {
          node {
            id
            discount {
              ... on DiscountCodeBasic {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeBxgy {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeFreeShipping {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeApp {
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `.trim();
}

/**
 * Alternative: Query codes directly via codeDiscountNodes
 * This might work better for bulk extraction of codes
 */
export function buildBulkCodesDirectQuery() {
  return `
    {
      codeDiscountNodes {
        edges {
          node {
            id
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeBxgy {
                title
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeFreeShipping {
                title
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
              ... on DiscountCodeApp {
                title
                codes {
                  edges {
                    node {
                      id
                      code
                      asyncUsageCount
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `.trim();
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}
