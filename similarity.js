/**
 * Pure-JS string similarity helpers. No external dependencies, so there's
 * nothing to break and no third-party API to depend on.
 */

// Common business entity suffixes that cause false "different company" results.
// e.g. "Microsoft Corp" vs "Microsoft Corporation" vs "Microsoft" should match.
const BUSINESS_SUFFIX_REGEX = new RegExp(
    '\\b(incorporated|inc|corporation|corp|company|co|llc|ltd|limited|plc|gmbh|srl|s\\.?a\\.?|bv|pty|llp)\\b\\.?',
    'gi',
);

function stripBusinessSuffixes(str) {
    return str
        .replace(BUSINESS_SUFFIX_REGEX, '')
        .replace(/[.,]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Classic Levenshtein edit distance (dynamic programming, O(n*m)).
 */
function levenshteinDistance(a, b) {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;

    let prevRow = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prevRow[j] = j;

    for (let i = 1; i <= la; i++) {
        const currRow = new Array(lb + 1);
        currRow[0] = i;
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currRow[j] = Math.min(
                prevRow[j] + 1, // deletion
                currRow[j - 1] + 1, // insertion
                prevRow[j - 1] + cost, // substitution
            );
        }
        prevRow = currRow;
    }
    return prevRow[lb];
}

/**
 * Levenshtein similarity normalized to a 0..1 scale (1 = identical).
 */
function levenshteinSimilarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Jaro similarity (0..1).
 */
function jaroSimilarity(s1, s2) {
    if (s1 === s2) return 1;
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0;

    const matchDistance = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
    const s1Matches = new Array(len1).fill(false);
    const s2Matches = new Array(len2).fill(false);

    let matches = 0;
    for (let i = 0; i < len1; i++) {
        const start = Math.max(0, i - matchDistance);
        const end = Math.min(i + matchDistance + 1, len2);
        for (let j = start; j < end; j++) {
            if (s2Matches[j]) continue;
            if (s1[i] !== s2[j]) continue;
            s1Matches[i] = true;
            s2Matches[j] = true;
            matches++;
            break;
        }
    }

    if (matches === 0) return 0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
    }
    transpositions /= 2;

    return (
        (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3
    );
}

/**
 * Jaro-Winkler similarity (0..1). Gives extra weight to matching prefixes,
 * which works well for names and company names.
 */
function jaroWinklerSimilarity(s1, s2, prefixScale = 0.1) {
    const jaro = jaroSimilarity(s1, s2);
    let prefixLen = 0;
    const maxPrefix = 4;
    for (let i = 0; i < Math.min(maxPrefix, s1.length, s2.length); i++) {
        if (s1[i] === s2[i]) prefixLen++;
        else break;
    }
    return jaro + prefixLen * prefixScale * (1 - jaro);
}

/**
 * Compute similarity using the chosen algorithm.
 */
function similarity(a, b, algorithm) {
    if (algorithm === 'jaroWinkler') return jaroWinklerSimilarity(a, b);
    return levenshteinSimilarity(a, b); // default
}

module.exports = {
    levenshteinDistance,
    levenshteinSimilarity,
    jaroSimilarity,
    jaroWinklerSimilarity,
    similarity,
    stripBusinessSuffixes,
};
