const { Actor } = require('apify');
const { ApifyClient } = require('apify-client');
const { similarity, stripBusinessSuffixes } = require('./similarity');

/**
 * Get a (possibly nested) value from an object using dot notation.
 * e.g. getNestedValue({a:{b:1}}, 'a.b') -> 1
 */
function getNestedValue(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((acc, key) => {
        if (acc === null || acc === undefined) return undefined;
        return acc[key];
    }, obj);
}

/**
 * Normalize a value for comparison purposes.
 */
function normalizeValue(value, { caseInsensitive, trimWhitespace }) {
    if (value === null || value === undefined) return '';
    let v = value;
    if (typeof v !== 'string') {
        try {
            v = JSON.stringify(v);
        } catch (e) {
            v = String(v);
        }
    }
    if (trimWhitespace) v = v.trim();
    if (caseInsensitive) v = v.toLowerCase();
    return v;
}

/**
 * Build the dedup key string for an item based on the configured fields.
 */
function buildDedupKey(item, dedupFields, options) {
    return dedupFields
        .map((field) => normalizeValue(getNestedValue(item, field), options))
        .join('\u0001');
}

/**
 * Normalize a value specifically for fuzzy comparison: lowercase, trim,
 * optionally strip common business suffixes (Inc, Corp, LLC, etc).
 */
function normalizeForFuzzy(value, { caseInsensitive, trimWhitespace, stripSuffixes }) {
    let v = normalizeValue(value, { caseInsensitive, trimWhitespace });
    if (stripSuffixes) v = stripBusinessSuffixes(v);
    return v;
}

/**
 * Get the fuzzy comparison values (one per fuzzyField) for an item.
 */
function getFuzzyValues(item, fuzzyFields, options) {
    return fuzzyFields.map((field) => normalizeForFuzzy(getNestedValue(item, field), options));
}

/**
 * Check if two sets of fuzzy values are a duplicate match: every field pair
 * must meet the similarity threshold (AND logic - avoids false positives
 * from matching on just one loosely-related field).
 */
function isFuzzyMatch(valuesA, valuesB, threshold, algorithm) {
    for (let i = 0; i < valuesA.length; i++) {
        if (similarity(valuesA[i], valuesB[i], algorithm) < threshold) return false;
    }
    return true;
}

/**
 * Iterate every item in a dataset, handling pagination.
 *
 * Actor runs default to "LIMITED_PERMISSIONS" - they can only access their
 * own run's storages, not other datasets in the account (even ones you own).
 * If the caller supplies their personal Apify API token (apifyApiToken
 * input field), we use the ApifyClient directly instead, which authenticates
 * as the account owner and can read any dataset you have access to.
 */
async function forEachItemInDataset(idOrName, apifyApiToken, onItem) {
    if (apifyApiToken) {
        const client = new ApifyClient({ token: apifyApiToken });
        const datasetClient = client.dataset(idOrName);
        const limit = 1000;
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { items } = await datasetClient.listItems({ offset, limit });
            if (!items || items.length === 0) break;
            for (const item of items) {
                await onItem(item);
            }
            offset += items.length;
            if (items.length < limit) break;
        }
    } else {
        const dataset = await Actor.openDataset(idOrName);
        await dataset.forEach(onItem);
    }
}

Actor.main(async () => {
    const input = await Actor.getInput();
    if (!input) {
        throw new Error('No input provided. Please provide datasetIds at minimum.');
    }

    const {
        datasetIds = [],
        matchMode = 'exact', // 'exact' | 'fuzzy'
        dedupFields = [],
        fuzzyFields = [],
        similarityAlgorithm = 'levenshtein', // 'levenshtein' | 'jaroWinkler'
        similarityThreshold = 0.85,
        blockingPrefixLength = 3,
        stripBusinessSuffixesOption = false,
        keepOccurrence = 'first',
        caseInsensitive = true,
        trimWhitespace = true,
        outputDatasetName,
        maxItems,
        apifyApiToken,
    } = input;

    if (!Array.isArray(datasetIds) || datasetIds.length === 0) {
        throw new Error('"datasetIds" must be a non-empty array of dataset IDs or names.');
    }
    if (matchMode === 'fuzzy' && (!Array.isArray(fuzzyFields) || fuzzyFields.length === 0)) {
        throw new Error('"fuzzyFields" must be a non-empty array when matchMode is "fuzzy".');
    }
    if (similarityThreshold < 0 || similarityThreshold > 1) {
        throw new Error('"similarityThreshold" must be between 0 and 1.');
    }

    const normalizeOptions = { caseInsensitive, trimWhitespace };
    const fuzzyOptions = { caseInsensitive, trimWhitespace, stripSuffixes: stripBusinessSuffixesOption };
    const doDedup = matchMode === 'fuzzy'
        ? true
        : Array.isArray(dedupFields) && dedupFields.length > 0;

    // Resolve the output dataset: named dataset if provided, else the run's default dataset.
    const outputDataset = outputDatasetName
        ? await Actor.openDataset(outputDatasetName)
        : await Actor.openDataset();

    let totalRead = 0;
    let totalWritten = 0;
    let totalDuplicates = 0;
    let hitLimit = false;

    // 'first' mode: stream items out immediately, just remember which keys we've seen.
    const seenKeysForFirst = new Set();

    // 'last' mode: we must buffer, since a later duplicate overwrites an earlier one.
    // Map preserves insertion order; re-setting a key moves it to the end automatically
    // is NOT true in JS Maps (order stays at first insertion), so we delete+re-add to
    // keep "last occurrence wins, in last-seen position" semantics.
    const bufferForLast = new Map();

    // Fuzzy mode: group candidates into "blocks" by a prefix of the primary
    // fuzzy field, so we only run expensive similarity checks against items
    // that could plausibly match - not the entire dataset (O(n^2) avoided).
    // blockKey -> array of { fuzzyValues, item }
    const blocksForFuzzy = new Map();

    if (matchMode === 'fuzzy') {
        console.log(
            `Starting FUZZY merge of ${datasetIds.length} dataset(s). Fields: ${fuzzyFields.join(', ')}. `
            + `Algorithm: ${similarityAlgorithm}. Threshold: ${similarityThreshold}. `
            + `Blocking prefix length: ${blockingPrefixLength} (0 = no blocking, full O(n^2) comparison). Keep: ${keepOccurrence}.`,
        );
    } else {
        console.log(`Starting merge of ${datasetIds.length} dataset(s). Dedup fields: ${doDedup ? dedupFields.join(', ') : '(none - merge only)'}. Keep: ${keepOccurrence}.`);
    }

    for (const idOrName of datasetIds) {
        if (hitLimit) break;

        console.log(`Reading from dataset: ${idOrName}`);

        try {
            await forEachItemInDataset(idOrName, apifyApiToken, async (item) => {
            if (maxItems && totalRead >= maxItems) {
                hitLimit = true;
                return;
            }
            totalRead += 1;

            if (matchMode === 'fuzzy') {
                const fuzzyValues = getFuzzyValues(item, fuzzyFields, fuzzyOptions);
                const blockKey = blockingPrefixLength > 0
                    ? fuzzyValues[0].slice(0, blockingPrefixLength)
                    : '__all__';

                const bucket = blocksForFuzzy.get(blockKey) || [];
                const matchIndex = bucket.findIndex((candidate) => (
                    isFuzzyMatch(fuzzyValues, candidate.fuzzyValues, similarityThreshold, similarityAlgorithm)
                ));

                if (matchIndex === -1) {
                    // No match in this block - it's a new unique representative.
                    bucket.push({ fuzzyValues, item });
                    blocksForFuzzy.set(blockKey, bucket);
                    if (keepOccurrence === 'first') {
                        await outputDataset.pushData(item);
                        totalWritten += 1;
                    }
                    // for 'last' mode, representatives are flushed at the end
                } else {
                    totalDuplicates += 1;
                    if (keepOccurrence === 'last') {
                        // Replace the representative with this newer item.
                        bucket[matchIndex] = { fuzzyValues, item };
                    }
                    // for 'first' mode, the earlier representative is kept, nothing to push
                }
                return;
            }

            if (!doDedup) {
                await outputDataset.pushData(item);
                totalWritten += 1;
                return;
            }

            const key = buildDedupKey(item, dedupFields, normalizeOptions);

            if (keepOccurrence === 'first') {
                if (seenKeysForFirst.has(key)) {
                    totalDuplicates += 1;
                    return;
                }
                seenKeysForFirst.add(key);
                await outputDataset.pushData(item);
                totalWritten += 1;
            } else {
                // keepOccurrence === 'last'
                if (bufferForLast.has(key)) {
                    totalDuplicates += 1;
                    bufferForLast.delete(key); // remove old position
                }
                bufferForLast.set(key, item); // (re)insert at the end = latest position
            }
            });
        } catch (err) {
            console.warn(`Could not read dataset "${idOrName}": ${err.message}. Skipping it.`);
            continue;
        }
    }

    // Flush buffered "last occurrence" items now that all sources are read.
    if (matchMode === 'fuzzy' && keepOccurrence === 'last') {
        for (const bucket of blocksForFuzzy.values()) {
            for (const candidate of bucket) {
                await outputDataset.pushData(candidate.item);
                totalWritten += 1;
            }
        }
    } else if (matchMode !== 'fuzzy' && doDedup && keepOccurrence === 'last') {
        for (const item of bufferForLast.values()) {
            await outputDataset.pushData(item);
            totalWritten += 1;
        }
    }

    const summary = {
        datasetsProcessed: datasetIds.length,
        matchMode,
        totalItemsRead: totalRead,
        totalItemsWritten: totalWritten,
        duplicatesRemoved: totalDuplicates,
        dedupFields: matchMode === 'exact' && doDedup ? dedupFields : null,
        fuzzyFields: matchMode === 'fuzzy' ? fuzzyFields : null,
        similarityAlgorithm: matchMode === 'fuzzy' ? similarityAlgorithm : null,
        similarityThreshold: matchMode === 'fuzzy' ? similarityThreshold : null,
        blockingPrefixLength: matchMode === 'fuzzy' ? blockingPrefixLength : null,
        keepOccurrence: doDedup ? keepOccurrence : null,
        outputDataset: outputDatasetName || 'default',
        hitMaxItemsLimit: !!hitLimit,
    };

    console.log('Done.', summary);
    await Actor.setValue('OUTPUT', summary);
});
