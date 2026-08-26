import path from 'node:path';
import { loadDotEnv, parseArgs, parseInteger, requireValue, slugifyMerchant } from './utils.mjs';

export async function loadConfig({ cwd, argv }) {
  await loadDotEnv(cwd);
  const args = parseArgs(argv);

  const shop = requireValue(
    'SHOPIFY_STORE_DOMAIN',
    args.shop ?? process.env.SHOPIFY_STORE_DOMAIN,
  );
  const token = requireValue(
    'SHOPIFY_ADMIN_TOKEN',
    args.token ?? process.env.SHOPIFY_ADMIN_TOKEN,
  );

  const merchantSlug = slugifyMerchant(
    args.merchant ?? process.env.MERCHANT_SLUG ?? shop,
  );

  // Status filter: defaults to active-only. Pass --status=all (or DISCOUNT_STATUS=all)
  // to extract every discount regardless of status.
  const statusRaw = (args.status ?? process.env.DISCOUNT_STATUS ?? 'active')
    .toString()
    .trim()
    .toLowerCase();
  const discountQuery = statusRaw === 'all' ? null : `status:${statusRaw}`;

  return {
    cwd,
    shop,
    token,
    merchantSlug,
    apiVersion: args.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? '2026-01',
    recentlyExpiredDays: parseInteger(
      args.recentlyExpiredDays ?? process.env.RECENTLY_EXPIRED_DAYS,
      30,
    ),
    discountPageSize: parseInteger(
      args.discountPageSize ?? process.env.DISCOUNT_PAGE_SIZE,
      50,
    ),
    codePageSize: parseInteger(args.codePageSize ?? process.env.CODE_PAGE_SIZE, 100),
    metafieldPageSize: parseInteger(
      args.metafieldPageSize ?? process.env.METAFIELD_PAGE_SIZE,
      100,
    ),
    discountStatus: statusRaw,
    discountQuery,
    outputDir: path.join(cwd, 'migrations', merchantSlug),
  };
}
