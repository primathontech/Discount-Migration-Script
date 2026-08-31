# Shopify → Ratio Discount Migration

A two-step tool that (1) extracts all discounts from a Shopify store and (2) recreates them in
OpenStore (OS) with correct values, then produces an Excel report of exactly what happened.

Anyone can run it by setting `.env` and running two commands — or use the **one-page UI** (no terminal needed).

---

## 0. Easiest: the web UI

```bash
npm run ui
```
Then open **http://127.0.0.1:4321**. From the page you can:
1. Enter & save credentials (writes them to `.env` on this machine).
2. Run **Stage 1** (extract) and **Stage 2** (migrate) with live logs.
3. **Download** the Excel report.

Stage 2 has an optional **"Only this code"** box (migrate a single discount by code/title), and the
Delete card takes **specific codes** — so you can delete one discount and re-create just that one
from the page, without touching the rest.

It runs the exact same code as the terminal commands below — use whichever you prefer.

---

## 1. Prerequisites

- **Node.js 20+** (uses built-in `fetch`, `zlib`; no external npm packages needed).
- A **Shopify custom app** on the source store with these Admin API scopes:
  - `read_discounts`  (required)
  - `read_customers`  (required — needed to read customer email/phone for customer-specific discounts)
- **OpenStore dashboard access** for the target merchant (to grab a login cookie).

---

## 2. Configure `.env`

Create/edit `.env` in the project root:

```bash
# --- Shopify (source) ---
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # Admin API access token
SHOPIFY_API_VERSION=2026-01

# --- OpenStore (target) ---
OPENSTORE_BASE_URL=https://gkx.gokwik.co                    # PROD
OPENSTORE_MERCHANT_ID=xxxxxxxxxxxxx                         # the OS merchant-mid
OPENSTORE_COOKIE=cto_bundle=...; token=...                  # full cookie from a logged-in dashboard session
```

**How to get the OS cookie:** log in to the OpenStore dashboard, open DevTools → Network → any
request → copy the entire `cookie` request header (must include `token=...`). The cookie expires
after some hours — if you see `401 Unauthorized`, refresh it and re-run (the migration resumes,
see “Resuming” below).

---

## 3. Step 1 — Extract from Shopify

```bash
npm run extract:stage1 -- --merchant=<slug>
```

- `--merchant=<slug>` — a short name; output goes to `migrations/<slug>/`.
- `--status=active` (default) extracts only **active** discounts. Use `--status=all` to include
  expired/scheduled too. (Active is what you normally migrate.)

**Output:** `migrations/<slug>/discounts_<timestamp>.json` (and a `.csv` copy).
The extractor auto-retries Shopify rate-limits, so large stores just take longer.

---

## 4. Step 2 — Migrate to OpenStore

```bash
npm run migrate:stage2 -- migrations/<slug>/discounts_<timestamp>.json
```

Useful flags:
| Flag | Purpose |
|---|---|
| `--concurrency=1` | keep at 1 (OS rate-limits); default 1 |
| `--skip-sets=true` | defer multi-code “sets” (they expand to one discount per code — can be huge) |
| `--skip-customer-specific=true` | defer customer-specific discounts to a later run |
| `--active-only` | migrate only active discounts from the file |
| `--code=DD150` | migrate only discounts whose code/title matches (for a single manual re-create) |
| `--resetLedger=true` | start fresh (ignore the resume ledger) |

**What Step 2 does automatically:**
- Creates discounts in the **Ratio dashboard's own V2 shape** (`type` / `actions` /
  `cart_conditions.product_matchers` / `targeting`) via `POST /v3/api/dashboard/v2/discount/create`
  — the endpoint the dashboard actually reads scope & minimums from, so "Applies to" and the
  minimum-purchase condition render correctly (the older `os-discount/create` did not).
- Money & minimum-purchase → **paisa** (× 100)
- **Collections** → translated to OS collection IDs (OS uses its own IDs)
- **Customer-specific** → looks up the customer by **exact email/phone**; if missing, **creates**
  them (phone is taken from contact info, else the customer’s address)
- **Usage limits** → carried over as *remaining* uses (limit − used)
- Multi-code **sets** → expanded into individual real codes
- Sensible **draft** rules (see below) so nothing broken is published
- **Ledger** (resumable) so interrupted runs continue safely

**Output (next to the input file):**
- `migration_report_<timestamp>.csv`
- `migration_report_<timestamp>.xlsx`  ← the report you share

### On discount sets — we don't recreate them as "sets"

OpenStore's set-creation endpoint only **generates random codes** — it can't import Shopify's
real codes into a native set (verified). So to **preserve the real codes**, our script **expands
each set into individual single discounts** (one per real code). That's faithful for small sets
(e.g. Judge.me), but for a **49,608-code gift-card set it explodes** — which is why `--skip-sets`
exists. There's no way to make OS hold the real codes as one set; **expand-or-skip are the only
faithful options.** Use `--skip-sets=true` (or the UI checkbox) to defer large code-sets.

---

## 5. The Excel report (2 tabs)

**Tab 1 — “Summary”**: grouped counts, e.g.
| Category | Count |
|---|---|
| Migrated successfully (published) | … |
| Draft - customer has no phone | … |
| Draft - no customer selected in Shopify | … |
| Draft - already used up in Shopify | … |
| Not migrated - unsupported discount type | … |
| TOTAL | … |

**Tab 2 — “All Discounts”**: one row per code — `code, title, customer, used, limit, collection,
result, reason`. Add a filter on the **`reason`** (or `result`) column to pull any group, e.g. all
“customer has no phone” discounts.

---

## 6. Why some land as DRAFT (expected, not errors)

The tool publishes clean discounts and keeps genuinely-problematic ones as **draft** (flagged in
the report), because OS can’t safely represent them:

- **Already used up** — a one-time code already redeemed. OS resets its usage counter to 0 and
  can’t store “already used”, so publishing would wrongly allow another redemption. → draft.
- **Customer has no phone** — OS requires a phone to create a customer; if the customer has no
  phone in contact info *or* address, they can’t be created. → draft. (Add a phone in Shopify/OS
  and re-run to publish.)
- **No customer selected in Shopify** — discount is “specific customers” but the list is empty
  (usually orphaned referral codes). Nothing to attach. → draft.

Genuinely un-migratable (rare): **app-managed discounts** (e.g. Shopify-Function “progress bar”
discounts) have no fixed value/type in Shopify, so there’s nothing standard to create → reported
as **Not migrated**.

---

## 7. Deleting discounts (optional cleanup tool)

Deletes OpenStore discounts with flags. **Dry-run by default** — it only reports counts until you
add `--confirm`. Uses the same `.env` (`OPENSTORE_*`). Deletes fast (100 per request).

Pick exactly one target:
| Flag | Deletes |
|---|---|
| `--status=draft` | all draft / unpublished discounts |
| `--status=published` | all published discounts |
| `--all` | every discount |
| `--codes=A,B,C` | just these codes |
| `--codes-file=path` | codes listed in a file (one per line) |

```bash
# how many drafts are there? (dry run)
npm run delete:discounts -- --status=draft

# actually delete all drafts
npm run delete:discounts -- --status=draft --confirm

# delete specific codes
npm run delete:discounts -- --codes=SAVE10,WELCOME --confirm
```

> ⚠️ `--all` removes everything for the merchant — always dry-run first, and only add `--confirm`
> when you're sure. Deletes are soft-deletes on OS.

---

## 8. Resuming / re-running

- The **ledger** (`migrations/<slug>/.migrated.jsonl`) records every created code. If the run is
  interrupted (cookie expiry, machine sleep, Ctrl-C), just **run the same Step 2 command again** —
  it skips what’s done and continues. Do **not** pass `--resetLedger` when resuming.
- Already-existing discounts return `409` and are skipped (not duplicated).
- To fully redo a merchant: delete its OS discounts first, then run Step 2 with `--resetLedger=true`.

---

## 9. Quick reference

```bash
# 1) extract
npm run extract:stage1 -- --merchant=acme --status=active

# 2) migrate (produces CSV + 2-tab XLSX)
npm run migrate:stage2 -- migrations/acme/discounts_20260101T000000000Z.json

# resume after a cookie refresh (same command, no --resetLedger)
npm run migrate:stage2 -- migrations/acme/discounts_20260101T000000000Z.json
```

The `.xlsx` next to the input file is the final deliverable: Tab 1 = summary, Tab 2 = filterable
per-code detail.
