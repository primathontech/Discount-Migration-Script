import { sleep } from './utils.mjs';

export class OpenStoreClient {
  constructor({
    merchantId,
    cookie,
    cookies,
    baseUrl = 'https://gkx.gokwik.co',
    maxRetries = 6,
    baseBackoffMs = 5000,
    maxBackoffMs = 60000,
  }) {
    this.merchantId = merchantId;
    this.baseUrl = baseUrl;
    this.maxRetries = maxRetries;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;

    // Normalize to an array. Accept `cookies` (array) or `cookie` (single string).
    const list = Array.isArray(cookies) ? cookies : (cookie ? [cookie] : []);
    this.cookies = list.filter(Boolean);
    if (this.cookies.length === 0) {
      throw new Error('OpenStoreClient: at least one cookie is required');
    }
    this._cookieIndex = 0;
    this._successesSinceLastThrottle = 0;
    this._lastThrottleAt = Date.now();
  }

  cookieCount() {
    return this.cookies.length;
  }

  // Round-robin so calls AND retries spread across cookies. Each retry on 429
  // gets a different cookie, so a throttled cookie can cool down while others work.
  _nextCookie() {
    const cookie = this.cookies[this._cookieIndex % this.cookies.length];
    this._cookieIndex += 1;
    return { cookie, index: (this._cookieIndex - 1) % this.cookies.length };
  }

  _buildHeaders(cookie) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'merchant-mid': this.merchantId,
      'gk-merchant-id': this.merchantId,
      'origin': 'https://dashboard.gokwik.co',
      'referer': 'https://dashboard.gokwik.co/',
      'Cookie': cookie,
    };
  }

  async _request(url, init, label) {
    let attempt = 0;
    while (true) {
      const { cookie, index } = this._nextCookie();
      const requestInit = {
        ...init,
        headers: this._buildHeaders(cookie),
      };

      const response = await fetch(url, requestInit);
      const body = await response.json().catch(() => ({}));

      if (response.ok) {
        this._successesSinceLastThrottle += 1;
        return body;
      }

      const retriable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retriable && attempt < this.maxRetries) {
        const retryAfterHeader = response.headers.get('retry-after');
        let waitMs;
        if (retryAfterHeader) {
          const asInt = parseInt(retryAfterHeader, 10);
          waitMs = Number.isFinite(asInt) ? asInt * 1000 : this._backoff(attempt);
        } else {
          waitMs = this._backoff(attempt);
        }
        attempt++;
        const cookieTag = this.cookies.length > 1 ? ` cookie#${index + 1}` : '';
        const successCount = this._successesSinceLastThrottle;
        // Only treat this as a "new cycle" if there were actual successes in
        // between. Otherwise the timing info would reset on every retry.
        let timeInfo = '';
        if (successCount > 0) {
          const now = Date.now();
          const elapsedSec = (now - this._lastThrottleAt) / 1000;
          const ratePerMin = elapsedSec > 0 ? (successCount / elapsedSec) * 60 : 0;
          timeInfo = ` | ${elapsedSec.toFixed(1)}s | ${ratePerMin.toFixed(0)}/min`;
          this._lastThrottleAt = now;
        }
        this._successesSinceLastThrottle = 0;
        const useColor = process.stdout.isTTY;
        const yellow = useColor ? '\x1b[33m' : '';
        const bold = useColor ? '\x1b[1m' : '';
        const reset = useColor ? '\x1b[0m' : '';
        const sep = '═'.repeat(15);
        const msg = `[${bold}${successCount} since last 429${timeInfo}${reset}${yellow}] [429${cookieTag} cool-off ${Math.round(waitMs / 1000)}s, retry ${attempt}/${this.maxRetries}]`;
        process.stdout.write(`\n${yellow}${sep} ${msg} ${sep}${reset}\n`);
        // Multi-cookie: skip the full wait — next attempt uses a different cookie
        // which may have its own budget available right now.
        const actualWait = this.cookies.length > 1 ? Math.min(waitMs, 1000) : waitMs;
        await sleep(actualWait);
        continue;
      }

      throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body)}`);
    }
  }

  _backoff(attempt) {
    const exp = Math.min(this.baseBackoffMs * Math.pow(2, attempt), this.maxBackoffMs);
    const jitter = exp * (0.8 + Math.random() * 0.4);
    return Math.round(jitter);
  }

  // Inject merchant_id everywhere the dashboard V2 payload expects it (top level +
  // targeting.applicable_merchant_ids), matching the dashboard's own create/update calls.
  _withMerchant(payload) {
    const out = { ...payload, merchant_id: this.merchantId };
    if (out.targeting && typeof out.targeting === 'object') {
      out.targeting = { ...out.targeting, applicable_merchant_ids: [this.merchantId] };
    }
    return out;
  }

  async createDiscount(discountPayload) {
    // Dashboard V2 endpoint — the one the PROD dashboard READS scope/conditions from (confirmed
    // via captured cURL). The legacy os-discount/create stored a shape the dashboard's
    // "Applies to" / minimum UI ignores, which showed collection/product scope as "All products".
    const url = `${this.baseUrl}/v3/api/dashboard/v2/discount/create`;
    return this._request(
      url,
      { method: 'POST', body: JSON.stringify(this._withMerchant(discountPayload)) },
      'OpenStore create discount',
    );
  }

  async updateDiscount(discountId, discountPayload) {
    const url = `${this.baseUrl}/v3/api/dashboard/v2/discount/update/${discountId}`;
    return this._request(
      url,
      { method: 'PUT', body: JSON.stringify(this._withMerchant(discountPayload)) },
      'OpenStore update discount',
    );
  }

  // Bulk set status for up to ~100 discounts in one call (status: published | draft | deleted).
  async bulkUpdateStatus(discountIds, status) {
    const url = `${this.baseUrl}/v3/api/api/v1/admin/os-discount/bulk-update-status`;
    return this._request(
      url,
      { method: 'POST', body: JSON.stringify({ merchant_id: this.merchantId, discount_ids: discountIds, status }) },
      `OpenStore bulk-${status}`,
    );
  }

  async publishDiscounts(discountIds) {
    return this.bulkUpdateStatus(discountIds, 'published');
  }

  // Soft-delete up to ~100 discounts in one call.
  async bulkDeleteDiscounts(discountIds) {
    return this.bulkUpdateStatus(discountIds, 'deleted');
  }

  // Fetch one page of the merchant's discounts. Pass status to filter (e.g. 'draft', 'published')
  // or search to match a code/title.
  async fetchDiscountsPage({ status, search, page = 1, limit = 100 } = {}) {
    const url = `${this.baseUrl}/v3/api/api/v1/admin/os-discount/fetch`;
    const body = { merchant_id: this.merchantId, page, limit };
    if (status) body.status = status;
    if (search) body.search = search;
    const res = await this._request(url, { method: 'POST', body: JSON.stringify(body) }, 'OpenStore fetch');
    return Array.isArray(res.data) ? res.data : (res.data?.data || []);
  }

  /**
   * Look up an OS customer by email (falls back to phone / name). Returns the OS
   * customer record (whose `id` is a UUID, NOT the Shopify numeric id) or null.
   * Customer endpoints live at /v3/api/v1/admin/... (single "api"), unlike discounts.
   */
  async findCustomer({ email, phone }) {
    // Match ONLY on an exact identifier (email, else phone). We must never guess: a loose
    // OR/name search + returning rows[0] could attach the WRONG customer to a discount.
    const url = `${this.baseUrl}/v3/api/v1/admin/customers/filter`;
    const search = async (field, value) => {
      const body = await this._request(
        url,
        { method: 'POST', body: JSON.stringify({ conditions: [{ field, operator: 'contains', value }], conditionLogic: 'AND', page: 1, limit: 20, sortBy: 'email', sortOrder: 'asc' }) },
        'OpenStore customer filter',
      );
      return body.customers || body.data?.data || body.data || [];
    };
    if (email) {
      const rows = await search('email', email);
      const exact = (rows || []).find((c) => (c.email || '').toLowerCase() === email.toLowerCase());
      if (exact) return exact;
    }
    if (phone) {
      const rows = await search('phone', phone);
      const exact = (rows || []).find((c) => (c.phone || '') === phone);
      if (exact) return exact;
    }
    return null; // no exact identifier match -> unresolved (discount stays draft)
  }

  /**
   * Create an OS customer. Returns the created record (with its UUID `id`).
   * phone is required by the form; pass what we have from Shopify.
   */
  async createCustomer({ firstName, lastName, email, phone }) {
    const url = `${this.baseUrl}/v3/api/v1/admin/customers`;
    // phone is the only required field; only include email/name when actually present
    // (OS rejects an empty-string email with "email must be an email").
    const payload = {
      phone: phone || '',
      tags: [], company: '', language: 'en',
      hasEmailSubscription: false, hasSmsSubscription: false,
      notes: '', totalOrders: 0, totalSpent: 0, averageOrderValue: 0,
      taxSetting: 'DONT_COLLECT_TAX',
    };
    if (email && email.trim()) payload.email = email.trim();
    // firstName & lastName are required by OS; fall back so they are never empty.
    payload.firstName = (firstName && firstName.trim()) || (email ? email.split('@')[0] : '') || 'Customer';
    payload.lastName = (lastName && lastName.trim()) || '.';
    const body = await this._request(url, { method: 'POST', body: JSON.stringify(payload) }, 'OpenStore customer create');
    return body.data || body.customer || body;
  }

  /**
   * Fetch the merchant's OS collections and build a Shopify->OS collection id map.
   * OS does NOT reuse Shopify collection ids (unlike products/variants): each OS
   * collection has its own `id` and stores the Shopify id under `external_id`.
   * Returns { shopifyCollectionId(string): osCollectionId(string) }.
   */
  async fetchCollectionMap() {
    const map = {};
    let page = 1;
    while (true) {
      const url = `${this.baseUrl}/v3/api/api/v1/admin/collections?storeId=${this.merchantId}&page=${page}&limit=100`;
      const body = await this._request(url, { method: 'GET' }, 'OpenStore collections');
      const rows = body.collections || body.data?.data || body.data || [];
      for (const c of rows) {
        if (c.external_id != null && c.id != null) {
          map[String(c.external_id)] = String(c.id);
        }
      }
      if (rows.length < 100) break;
      page += 1;
      if (page > 50) break;
    }
    return map;
  }
}
