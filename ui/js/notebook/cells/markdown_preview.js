/**
 * Shared markdown → HTML conversion for cell previews.
 * Handles headings, bold, italic, inline code, paragraphs, tables, lists,
 * blockquotes, horizontal rules, and LaTeX (via KaTeX if available).
 */

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderLatex(latex, displayMode) {
    if (window.katex) {
        try {
            return window.katex.renderToString(latex, {
                displayMode, throwOnError: false, strict: false
            });
        } catch { /* fall through */ }
    }
    return `<code>${escapeHtml(latex)}</code>`;
}

/** Process inline markdown: bold, italic, inline code, inline math. */
function renderInline(text) {
    // Inline code first (protect from other transforms)
    text = text.replace(/`([^`]+?)`/g, '<code>$1</code>');

    // Inline math $...$ (not $$, skip escaped \$)
    text = text.replace(/(?<!\$)(?<!\\)\$(?!\$)([^\s$][^$]*?)\$(?!\$)/g, (_, latex) => {
        const raw = latex.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        return renderLatex(raw, false);
    });

    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

    return text;
}

/** Parse a pipe-delimited table row into cell texts. */
function parseTableRow(line) {
    // Strip leading/trailing pipes and split
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(c => c.trim());
}

/** Check if a line is a table separator (e.g. |---|---| or ||||). */
function isSeparatorRow(line) {
    const t = line.trim();
    // Standard: pipes with dashes and optional alignment colons
    if (/^\|?[\s:]*-{1,}[\s:]*(\|[\s:]*-{1,}[\s:]*)*\|?$/.test(t)) return true;
    // Pipe-only: at least 3 pipes (2+ columns), nothing but pipes and spaces
    if (/^\|(\s*\|){2,}$/.test(t)) return true;
    return false;
}

/** HTML block-level tags that pass through without escaping. */
const HTML_BLOCK_TAGS = /^<(table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|div|details|summary|figure|figcaption|dl|dt|dd|section|aside|nav|header|footer)\b/i;

/** Check if a line opens an HTML block. */
function isHtmlBlockOpen(line) {
    return HTML_BLOCK_TAGS.test(line.trim());
}

/** Find the matching close tag for an HTML block opening line. */
function findHtmlBlockEnd(lines, start) {
    const trimmed = lines[start].trim();
    const m = trimmed.match(/^<(\w+)/);
    if (!m) return start;
    const tag = m[1].toLowerCase();

    // Self-closing or single-line block
    const singleLineClose = new RegExp(`</${tag}\\s*>`, 'i');
    if (singleLineClose.test(trimmed)) return start;

    // Look for closing tag
    for (let j = start + 1; j < lines.length; j++) {
        if (singleLineClose.test(lines[j])) return j;
    }
    // No closing tag found — consume to next blank line or EOF
    for (let j = start + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') return j - 1;
    }
    return lines.length - 1;
}

/** Parse alignment from separator cells (e.g. :---, :---:, ---:). */
function parseAlignments(line) {
    return parseTableRow(line).map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
    });
}

/**
 * Convert markdown source to safe HTML.
 * @param {string} md — markdown source
 * @param {{
 *   resolveDirective?: (tag: string, id: string) => string|null,
 *   resolveCitation?:  (citeKey: string) => { num: number, cellId: string|null }|null,
 * }} [options]
 *   Optional resolver for `{{tag:id}}` directives (e.g., `{{params:cellId}}`,
 *   `{{fig:cellId}}`, `{{tbl:cellId}}`, `{{ref:cellId}}`).
 *   Return an HTML string to embed, or null to leave as-is.
 *
 *   Optional resolver for `[@citeKey]` citations.
 *   Return `{ num, cellId }` to render as a clickable `[N]` link, or null to leave as-is.
 */
export function markdownToHtml(md, options) {
    if (!md) return '';

    // Extract {{tag:id}} directives before any escaping
    const directivePlaceholders = [];
    let processed = md;

    if (options?.resolveDirective) {
        processed = processed.replace(/\{\{(\w+):([^}]+)\}\}/g, (full, tag, id) => {
            const resolved = options.resolveDirective(tag, id.trim());
            if (resolved != null) {
                directivePlaceholders.push(resolved);
                return `\x00DIR${directivePlaceholders.length - 1}\x00`;
            }
            return full;
        });
    }

    // Extract [@citeKey] citations before escaping
    const citePlaceholders = [];
    if (options?.resolveCitation) {
        processed = processed.replace(/\[@([^\]]+)\]/g, (full, key) => {
            const resolved = options.resolveCitation(key.trim());
            if (resolved != null) {
                const cellAttr = resolved.cellId ? ` data-scroll-to="${resolved.cellId}"` : '';
                citePlaceholders.push(
                    `<a class="md-cite-link" href="#"${cellAttr} title="${escapeHtml(key.trim())}">[${resolved.num}]</a>`
                );
                return `\x00CITE${citePlaceholders.length - 1}\x00`;
            }
            return full;
        });
    }

    // Extract LaTeX BEFORE escaping so KaTeX sees raw operators
    const mathPlaceholders = [];

    // Protect escaped dollar signs \$ → placeholder (literal dollar, not math delimiter)
    const escapedDollarPlaceholder = '\x00ESC_DOLLAR\x00';
    processed = processed.replace(/\\\$/g, escapedDollarPlaceholder);

    // Display math: $$...$$
    processed = processed.replace(/\$\$([^$]+)\$\$/g, (_, tex) => {
        mathPlaceholders.push(renderLatex(tex.trim(), true));
        return `\x00MATH${mathPlaceholders.length - 1}\x00`;
    });

    // Inline math: $..$ (single char like $G$ or multi-char like $T_r$)
    processed = processed.replace(/\$([^\s$][^$]*?)\$/g, (_, tex) => {
        mathPlaceholders.push(renderLatex(tex.trim(), false));
        return `\x00MATH${mathPlaceholders.length - 1}\x00`;
    });

    const lines = processed.split('\n');
    const output = [];
    let headingCounter = 0;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // ── Horizontal rule ──
        if (/^(---|\*\*\*|___)$/.test(line.trim())) {
            output.push('<hr>');
            i++;
            continue;
        }

        // ── Heading ──
        const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = renderInline(escapeHtml(headingMatch[2]));
            const idx = headingCounter++;
            output.push(`<h${level} data-heading-index="${idx}">${text}</h${level}>`);
            i++;
            continue;
        }

        // ── Table ──
        // A table starts with a pipe-delimited row followed by a separator row
        if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
            const headerCells = parseTableRow(line);
            const alignments = parseAlignments(lines[i + 1]);
            i += 2;

            // Build header
            const ths = headerCells.map((cell, ci) => {
                const align = alignments[ci] || 'left';
                const style = align !== 'left' ? ` style="text-align:${align}"` : '';
                return `<th${style}>${renderInline(escapeHtml(cell))}</th>`;
            }).join('');

            // Collect body rows
            const bodyRows = [];
            while (i < lines.length && lines[i].includes('|') && !isSeparatorRow(lines[i])) {
                const cells = parseTableRow(lines[i]);
                const tds = cells.map((cell, ci) => {
                    const align = alignments[ci] || 'left';
                    const style = align !== 'left' ? ` style="text-align:${align}"` : '';
                    return `<td${style}>${renderInline(escapeHtml(cell))}</td>`;
                }).join('');
                bodyRows.push(`<tr>${tds}</tr>`);
                i++;
            }

            output.push(
                `<table><thead><tr>${ths}</tr></thead><tbody>${bodyRows.join('')}</tbody></table>`
            );
            continue;
        }

        // ── Blockquote ──
        if (line.match(/^>\s?/)) {
            const quoteLines = [];
            while (i < lines.length && lines[i].match(/^>\s?/)) {
                quoteLines.push(lines[i].replace(/^>\s?/, ''));
                i++;
            }
            output.push(`<blockquote>${quoteLines.map(l => renderInline(escapeHtml(l))).join('<br>')}</blockquote>`);
            continue;
        }

        // ── Unordered list ──
        if (line.match(/^[\s]*[-*]\s+/)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^[\s]*[-*]\s+/)) {
                const itemText = lines[i].replace(/^[\s]*[-*]\s+/, '');
                items.push(`<li>${renderInline(escapeHtml(itemText))}</li>`);
                i++;
            }
            output.push(`<ul>${items.join('')}</ul>`);
            continue;
        }

        // ── Ordered list ──
        if (line.match(/^[\s]*\d+\.\s+/)) {
            const items = [];
            while (i < lines.length && (lines[i].match(/^[\s]*\d+\.\s+/) || lines[i].trim() === '')) {
                if (lines[i].trim() === '') { i++; continue; }
                const numMatch = lines[i].match(/^[\s]*(\d+)\.\s+/);
                const itemText = lines[i].replace(/^[\s]*\d+\.\s+/, '');
                items.push(`<li value="${numMatch[1]}">${renderInline(escapeHtml(itemText))}</li>`);
                i++;
            }
            output.push(`<ol>${items.join('')}</ol>`);
            continue;
        }

        // ── HTML block (table, div, details, etc.) ──
        if (isHtmlBlockOpen(line)) {
            const endIdx = findHtmlBlockEnd(lines, i);
            const htmlLines = [];
            for (let j = i; j <= endIdx; j++) {
                htmlLines.push(lines[j]);
            }
            output.push(htmlLines.join('\n'));
            i = endIdx + 1;
            continue;
        }

        // ── Fenced code block ──
        const fenceMatch = line.match(/^```(\w*)$/);
        if (fenceMatch) {
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].match(/^```$/)) {
                codeLines.push(escapeHtml(lines[i]));
                i++;
            }
            i++; // skip closing ```
            output.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
            continue;
        }

        // ── Empty line ──
        if (line.trim() === '') {
            i++;
            continue;
        }

        // ── Paragraph (default) ──
        const paraLines = [];
        while (i < lines.length
            && lines[i].trim() !== ''
            && !lines[i].trim().startsWith('$$')
            && !lines[i].match(/^```/)
            && !lines[i].match(/^#{1,3}\s/)
            && !lines[i].match(/^>\s?/)
            && !lines[i].match(/^[\s]*[-*]\s+/)
            && !lines[i].match(/^[\s]*\d+\.\s+/)
            && !(lines[i].includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]))
            && !lines[i].match(/^(---|\*\*\*|___)$/)
            && !isHtmlBlockOpen(lines[i])) {
            paraLines.push(renderInline(escapeHtml(lines[i])));
            i++;
        }
        if (paraLines.length > 0) {
            output.push(`<p>${paraLines.join('<br>')}</p>`);
        }
    }

    // Restore placeholders
    let html = output.join('');
    html = html.replace(/\x00MATH(\d+)\x00/g, (_, idx) => mathPlaceholders[Number(idx)]);
    html = html.replace(/\x00DIR(\d+)\x00/g, (_, idx) => directivePlaceholders[Number(idx)]);
    html = html.replace(/\x00CITE(\d+)\x00/g, (_, idx) => citePlaceholders[Number(idx)]);

    // Restore escaped dollar signs as literal $
    html = html.replace(/\x00ESC_DOLLAR\x00/g, '$');

    return html;
}
