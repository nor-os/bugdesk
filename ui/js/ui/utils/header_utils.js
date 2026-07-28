/**
 * Header Utilities
 *
 * Shared helpers for classifying and formatting data series column headers.
 * Used by both the data page and the data series plot window.
 */

/**
 * Determine the kind of a header based on prefixes or naming patterns.
 * @param {string} header - Column header name
 * @returns {string} - 'time', 'stock', 'flow', or 'indicator'
 */
export const getHeaderKind = (header) => {
    if (!header || typeof header !== 'string') return 'indicator';
    const lower = header.toLowerCase();

    // Check for explicit prefixes first
    if (lower.startsWith('stock:')) return 'stock';
    if (lower.startsWith('flow:')) return 'flow';
    if (lower.startsWith('indicator:')) return 'indicator';
    if (lower.startsWith('constant:') || lower.startsWith('const:')) return 'indicator';
    if (lower.startsWith('parameter:') || lower.startsWith('param:')) return 'indicator';

    // Time column detection
    if (lower === 't' || lower === 'time' || lower === 'step' || lower === 'period') return 'time';

    // Stock patterns (accounting/balance sheet terms)
    if (lower.includes('::') && lower.includes('[')) return 'stock'; // Sector::AccountType[Account]
    if (/\b(balance|stock|inventory|reserves?|deposit|asset|liability|equity|capital|wealth)\b/i.test(lower)) return 'stock';

    // Flow patterns
    if (/\b(flow|rate|velocity|speed|flux|d\/dt)\b/i.test(lower)) return 'flow';

    return 'indicator';
};

/**
 * Get Material icon name for a header kind.
 * @param {string} kind - Header kind
 * @returns {string} - Material icon name
 */
export const getIconForKind = (kind) => {
    switch (kind) {
        case 'stock': return 'inventory_2';
        case 'flow': return 'waterfall_chart';
        case 'time': return 'schedule';
        case 'indicator':
        default: return 'insights';
    }
};

/**
 * Strip explicit type prefixes from header names.
 * @param {string} header - Header name potentially with prefix
 * @returns {string} - Header name without prefix
 */
export const stripHeaderPrefix = (header) => {
    if (!header || typeof header !== 'string') return header;
    const prefixMatch = header.match(/^(stock|flow|indicator|constant|parameter|const|param):/i);
    if (prefixMatch) {
        return header.substring(prefixMatch[0].length);
    }
    return header;
};
