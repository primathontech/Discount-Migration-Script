import { sleep } from './utils.mjs';

export class ShopifyAdminClient {
  constructor({ shop, token, apiVersion }) {
    this.shop = shop;
    this.token = token;
    this.apiVersion = apiVersion;
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  }

  async graphql(query, variables = {}, { retries = 10 } = {}) {
    let attempt = 0;

    while (true) {
      attempt += 1;

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.token,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      const body = await response.json().catch(() => ({}));

      if ((response.status === 429 || response.status >= 500) && attempt <= retries) {
        const retryAfterHeader = response.headers.get('retry-after');
        const waitMs = retryAfterHeader
          ? Number.parseInt(retryAfterHeader, 10) * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 8000);

        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Shopify request failed (${response.status}): ${JSON.stringify(body)}`,
        );
      }

      // Shopify returns HTTP 200 with a THROTTLED GraphQL error when the cost bucket runs dry.
      if (isThrottledError(body) && attempt <= retries) {
        const waitMs = computeThrottleWaitMs(body);
        process.stdout.write(
          `\n  [Shopify throttled — waiting ${Math.round(waitMs / 1000)}s, retry ${attempt}/${retries}]\n`,
        );
        await sleep(waitMs);
        continue;
      }

      if (body.errors?.length) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
      }

      const userErrors = collectUserErrors(body);
      if (userErrors.length) {
        throw new Error(`Shopify user errors: ${JSON.stringify(userErrors)}`);
      }

      return body;
    }
  }
}

function isThrottledError(body) {
  return Array.isArray(body?.errors)
    && body.errors.some((err) => err?.extensions?.code === 'THROTTLED');
}

function computeThrottleWaitMs(body) {
  const cost = body?.extensions?.cost;
  const requested = Number(cost?.requestedQueryCost) || 0;
  const available = Number(cost?.throttleStatus?.currentlyAvailable) || 0;
  const restoreRate = Number(cost?.throttleStatus?.restoreRate) || 50;

  const deficit = Math.max(0, requested - available);
  const secondsToRefill = deficit / restoreRate;
  return Math.max(2000, Math.ceil(secondsToRefill * 1000));
}

function collectUserErrors(value, path = []) {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const current = [];
  if (Array.isArray(value.userErrors) && value.userErrors.length > 0) {
    current.push({ path: path.join('.'), userErrors: value.userErrors });
  }

  for (const [key, nested] of Object.entries(value)) {
    current.push(...collectUserErrors(nested, [...path, key]));
  }

  return current;
}
