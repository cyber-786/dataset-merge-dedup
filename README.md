# Dataset Merge & Deduplicator

Merge and deduplicate items across one or more Apify datasets by any field combination —
**including fuzzy/near-duplicate matching**, not just exact matches.
No scraping, no proxies, no anti-bot handling needed — this actor only reads/writes data
through the official Apify API, so there is nothing to break.

## Why this one is different

Most dataset-dedup actors on Apify Store only do **exact** matching: `"Microsoft Corp"`
and `"Microsoft Corporation"` are treated as two different companies, and a typo like
`"Aple Inc"` slips through completely. This actor adds a **fuzzy matching mode** using
Levenshtein distance or Jaro-Winkler similarity, with business-suffix stripping built in
(Inc, Corp, LLC, Ltd, GmbH, etc. are normalized away before comparing). That's the actual
gap in the market — generic fuzzy dedup is currently locked behind pricier, niche-specific
tools; this brings it to any dataset for a few cents per 1K items.

## What it does

- Reads items from any number of source datasets (by ID or name).
- **Exact mode**: deduplicate on one or more fields (composite keys), including nested
  fields via dot notation (e.g. `contact.email`, `address.city`). Fast, streams results
  immediately.
- **Fuzzy mode**: deduplicate near-duplicates using similarity scoring instead of exact
  equality — catches typos, abbreviations, and naming variants.
- Choose to keep the **first** or **last** occurrence of a duplicate.
- Case-insensitive matching and whitespace trimming (both modes).
- Writes clean results to the run's default dataset, or a named dataset of your choice.
- Works on datasets of any size — pagination is handled automatically.

## Input

| Field | Type | Description |
|---|---|---|
| `datasetIds` | array of strings | Required. Dataset IDs or names to merge. |
| `matchMode` | `"exact"` \| `"fuzzy"` | Default `"exact"`. |
| `dedupFields` | array of strings | Exact mode only. Fields to dedup on. Leave empty to just merge without deduping. |
| `fuzzyFields` | array of strings | Fuzzy mode only. Fields to compare with similarity scoring. All must pass the threshold to count as a match. |
| `similarityAlgorithm` | `"levenshtein"` \| `"jaroWinkler"` | Fuzzy mode only. Default `"levenshtein"`. Jaro-Winkler is better for names/companies. |
| `similarityThreshold` | number 0-1 | Fuzzy mode only. Default `0.85`. Lower = catches more duplicates but risks false matches. |
| `blockingPrefixLength` | integer | Fuzzy mode only. Default `3`. Performance safeguard — limits comparisons to items sharing this many starting characters. Set `0` to compare everything (accurate but slow on large data). |
| `stripBusinessSuffixesOption` | boolean | Fuzzy mode only. Default `false`. Strips Inc/Corp/LLC/Ltd/etc before comparing. |
| `keepOccurrence` | `"first"` \| `"last"` | Which duplicate to keep. Default `"first"`. |
| `caseInsensitive` | boolean | Default `true`. |
| `trimWhitespace` | boolean | Default `true`. |
| `outputDatasetName` | string | Optional. Write to a named dataset instead of the default one. |
| `maxItems` | integer | Optional safety cap on total items read. |

## Example input — exact mode

```json
{
  "datasetIds": ["abc123", "def456"],
  "matchMode": "exact",
  "dedupFields": ["email", "contact.phone"],
  "keepOccurrence": "last"
}
```

## Example input — fuzzy mode (company/lead dedup)

```json
{
  "datasetIds": ["abc123"],
  "matchMode": "fuzzy",
  "fuzzyFields": ["companyName"],
  "similarityAlgorithm": "jaroWinkler",
  "similarityThreshold": 0.88,
  "stripBusinessSuffixesOption": true,
  "keepOccurrence": "first"
}
```
This would correctly merge `"Microsoft Corp"`, `"Microsoft Corporation"`, and `"Micrsoft Inc"`
(typo) into a single record.

## Performance note on fuzzy mode

Naive fuzzy matching compares every item against every other item — O(n²), which becomes
unusably slow past a few thousand rows. This actor uses **blocking**: items are grouped by
the first N characters of the normalized fuzzy field (`blockingPrefixLength`), and only
compared within their own group. This keeps runs fast on large datasets, at the small
trade-off that two near-duplicates whose *very first characters* differ (e.g. a typo in
the first letter) may land in different blocks and not be compared. Set
`blockingPrefixLength` lower (or `0`) if that matters more to you than speed.

## Local development

```bash
npm install
npm start
```

Set input via `apify run` with an `INPUT.json` in the `storage/key_value_stores/default/` folder, or use the Apify CLI (`apify run -p`) after `apify login`.

## Deploying to Apify

1. Push this repo to GitHub.
2. In Apify Console: Actors → Create new → "Link Git repository" → paste your repo URL.
3. Apify will build the Docker image automatically using the included `Dockerfile`.
4. Once built, test a run with a sample `datasetIds` input.

## Setting up monetization (Pay per event)

This actor ships with no pricing baked in — you enable pricing entirely in Apify Console
so you can change it any time without a redeploy:

1. Go to your Actor → **Monetization** tab.
2. Choose **Pay per event** and define an event (e.g. `dataset-item` = items written).
3. Apify meters usage automatically based on dataset writes — no code changes needed.

If you later want in-code metered charging instead (per Apify's `Actor.charge()` API),
that can be added on top of the `outputDataset.pushData()` calls in `main.js`.

## Notes on the "keep last occurrence" mode

To correctly keep the *last* occurrence, this actor buffers unique items in memory until
all source datasets have been read (a Map keyed by the dedup key). For extremely large
merges (tens of millions of items) this uses more memory than "keep first" mode, which
streams results out immediately. If you expect huge volumes, prefer `"first"` or split
the job with `maxItems`.
