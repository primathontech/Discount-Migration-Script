import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * ID Mapping for Shopify → OpenStore
 *
 * CSV Format:
 * type,shopify_id,openstore_id
 * collection,gid://shopify/Collection/123,os_collection_id
 * product,gid://shopify/Product/456,os_product_id
 * variant,gid://shopify/ProductVariant/789,os_variant_id
 */

export class IdMapping {
  constructor(mappingData = {}) {
    this.collections = mappingData.collections || {};
    this.products = mappingData.products || {};
    this.variants = mappingData.variants || {};
    // Shopify customer id -> OS customer UUID (OS does NOT reuse Shopify customer ids).
    this.customers = mappingData.customers || {};
  }

  getCustomer(shopifyId) {
    return this.customers[shopifyId] || this.customers[extractNumericId(shopifyId)] || null;
  }

  getCollection(shopifyId) {
    return this.collections[shopifyId] || this.collections[extractNumericId(shopifyId)] || null;
  }

  getProduct(shopifyId) {
    return this.products[shopifyId] || this.products[extractNumericId(shopifyId)] || null;
  }

  getVariant(shopifyId) {
    return this.variants[shopifyId] || this.variants[extractNumericId(shopifyId)] || null;
  }

  hasCollection(shopifyId) {
    return this.getCollection(shopifyId) !== null;
  }

  hasProduct(shopifyId) {
    return this.getProduct(shopifyId) !== null;
  }

  hasVariant(shopifyId) {
    return this.getVariant(shopifyId) !== null;
  }

  /**
   * Map an array of Shopify collection IDs to OpenStore IDs
   * Returns { mapped: [...], unmapped: [...] }
   */
  mapCollections(shopifyIds) {
    const mapped = [];
    const unmapped = [];

    for (const id of shopifyIds) {
      const osId = this.getCollection(id);
      if (osId) {
        mapped.push(osId);
      } else {
        unmapped.push(id);
      }
    }

    return { mapped, unmapped };
  }

  /**
   * Map an array of Shopify product IDs to OpenStore IDs
   */
  mapProducts(shopifyIds) {
    const mapped = [];
    const unmapped = [];

    for (const id of shopifyIds) {
      const osId = this.getProduct(id);
      if (osId) {
        mapped.push(osId);
      } else {
        unmapped.push(id);
      }
    }

    return { mapped, unmapped };
  }

  /**
   * Map an array of Shopify variant IDs to OpenStore IDs
   */
  mapVariants(shopifyIds) {
    const mapped = [];
    const unmapped = [];

    for (const id of shopifyIds) {
      const osId = this.getVariant(id);
      if (osId) {
        mapped.push(osId);
      } else {
        unmapped.push(id);
      }
    }

    return { mapped, unmapped };
  }

  getSummary() {
    return {
      collections: Object.keys(this.collections).length,
      products: Object.keys(this.products).length,
      variants: Object.keys(this.variants).length,
    };
  }
}

export async function loadIdMapping(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');

    // Detect format by extension or content
    if (filePath.endsWith('.csv') || content.trim().startsWith('type,')) {
      return parseCSVMapping(content);
    }

    // JSON format
    const data = JSON.parse(content);
    return new IdMapping(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`Warning: ID mapping file not found: ${filePath}`);
      console.warn('Discounts with specific products/collections will be skipped.');
      return new IdMapping();
    }
    throw error;
  }
}

function parseCSVMapping(content) {
  const lines = content.trim().split(/\r?\n/);
  const mappingData = {
    collections: {},
    products: {},
    variants: {},
  };

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = parseCSVLine(line);
    if (parts.length < 3) continue;

    const [type, shopifyId, openstoreId] = parts;

    if (!shopifyId || !openstoreId) continue;

    const normalizedType = type.toLowerCase().trim();
    const cleanShopifyId = shopifyId.trim();
    const cleanOpenstoreId = openstoreId.trim();

    if (normalizedType === 'collection') {
      mappingData.collections[cleanShopifyId] = cleanOpenstoreId;
    } else if (normalizedType === 'product') {
      mappingData.products[cleanShopifyId] = cleanOpenstoreId;
    } else if (normalizedType === 'variant') {
      mappingData.variants[cleanShopifyId] = cleanOpenstoreId;
    }
  }

  return new IdMapping(mappingData);
}

function parseCSVLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  return parts;
}

function extractNumericId(gid) {
  if (!gid) return null;
  const match = String(gid).match(/(\d+)$/);
  return match ? match[1] : gid;
}

/**
 * Generate a CSV template mapping file from extracted discounts
 * Returns CSV string with columns: type, shopify_id, openstore_id, title (for reference)
 */
export function generateMappingTemplate(discounts) {
  const collections = new Map(); // id -> title
  const products = new Map();
  const variants = new Map();

  for (const discount of discounts) {
    extractIdsFromItems(discount.items, collections, products, variants);

    if (discount.bxgy_configuration) {
      extractIdsFromItems(discount.bxgy_configuration.customer_buys?.items, collections, products, variants);
      extractIdsFromItems(discount.bxgy_configuration.customer_gets?.items, collections, products, variants);
    }
  }

  // Build CSV
  const rows = ['type,shopify_id,openstore_id,title'];

  for (const [id, title] of collections) {
    rows.push(`collection,${escapeCSV(id)},,${escapeCSV(title)}`);
  }

  for (const [id, title] of products) {
    rows.push(`product,${escapeCSV(id)},,${escapeCSV(title)}`);
  }

  for (const [id, title] of variants) {
    rows.push(`variant,${escapeCSV(id)},,${escapeCSV(title)}`);
  }

  return rows.join('\n') + '\n';
}

function escapeCSV(value) {
  if (!value) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function extractIdsFromItems(items, collections, products, variants) {
  if (!items) return;

  if (items.type === 'specific_collections' && items.collections) {
    for (const c of items.collections) {
      if (!collections.has(c.id)) {
        collections.set(c.id, c.title || c.handle || '');
      }
    }
  }

  if (items.type === 'specific_products') {
    if (items.products) {
      for (const p of items.products) {
        if (!products.has(p.id)) {
          products.set(p.id, p.title || p.handle || '');
        }
      }
    }
    if (items.product_variants) {
      for (const v of items.product_variants) {
        if (!variants.has(v.id)) {
          variants.set(v.id, v.title || v.sku || '');
        }
      }
    }
  }
}
