/**
 * Lightweight Markdown renderer for AI chat messages and node definitions.
 *
 * Converts a subset of Markdown to sanitized HTML:
 *   - Fenced code blocks (```lang ... ```)
 *   - Inline code (`code`)
 *   - Headings (# through ####)
 *   - Bold (**text**) and italic (*text*)
 *   - Unordered lists (- item, * item)
 *   - Ordered lists (1. item)
 *   - Blockquotes (> text)
 *   - Links [text](url) — only http/https
 *   - Horizontal rules (---, ***)
 *   - Line breaks
 *   - LaTeX math: block $$...$$ and inline $...$  (via KaTeX when available)
 *
 * All output is XSS-safe: text content is escaped before insertion.
 *
 * @module ai/ai_markdown
 */


/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Render a LaTeX string to HTML via KaTeX (if loaded).
 * Falls back to escaped text in a <code> tag.
 * @param {string} latex - Raw LaTeX source
 * @param {boolean} displayMode - Block (true) or inline (false)
 * @returns {string} HTML string
 */
function renderLatex(latex, displayMode) {
    if (typeof katex !== 'undefined') {
        try {
            return katex.renderToString(latex, {
                displayMode,
                throwOnError: false,
                trust: false,
            });
        } catch { /* fall through */ }
    }
    const escaped = escapeHtml(latex);
    return displayMode
        ? `<pre class="ai-md__math-fallback">${escaped}</pre>`
        : `<code class="ai-md__math-fallback">${escaped}</code>`;
}

/**
 * Process inline markdown: bold, italic, inline code, inline math, links, citations.
 * @param {string} text - Already HTML-escaped text
 * @param {Object} [opts]
 * @param {Map<string,number>} [opts.references] - Citation key → number map
 * @returns {string}
 */
function renderInline(text, opts = {}) {
    // Inline code (must come first to protect code content from other transforms)
    text = text.replace(/`([^`]+?)`/g, '<code class="ai-md__inline-code">$1</code>');

    // Inline LaTeX $...$ (not $$)
    // Unescape &amp; &lt; &gt; &quot; back to raw for KaTeX, then render
    text = text.replace(/(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)/g, (_m, latex) => {
        const raw = latex.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        return renderLatex(raw, false);
    });

    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links [text](url) — only allow http/https
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a class="ai-md__link" href="$2" target="_blank" rel="noopener">$1</a>');

    // Citations [@key] or [@key, p. 42] → superscript footnote number
    if (opts.references) {
        text = text.replace(/\[@([\w][\w.-]*)(?:,\s*([^\]]+))?\]/g, (_m, key, extra) => {
            const num = opts.references.get(key);
            if (num == null) return _m;
            const tooltip = extra ? escapeHtml(extra.trim()) : '';
            return `<sup class="doc-cite" data-cite-key="${escapeHtml(key)}" title="${tooltip}">[${num}]</sup>`;
        });
    }

    return text;
}

/**
 * Render a Markdown string to sanitized HTML.
 * @param {string} markdown - Raw markdown text
 * @param {Object} [opts]
 * @param {Map<string,number>} [opts.references] - Citation key → number map for [@key] rendering
 * @returns {string} Safe HTML string
 */
export function renderMarkdown(markdown, opts = {}) {
    if (!markdown) return '';

    const lines = markdown.split('\n');
    const output = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // ── Block LaTeX $$...$$ ──
        if (line.trim().startsWith('$$')) {
            // Collect lines until closing $$
            const latexLines = [];
            const openLine = line.trim().slice(2); // text after opening $$
            if (openLine.endsWith('$$') && openLine.length > 2) {
                // Single-line: $$expression$$
                latexLines.push(openLine.slice(0, -2));
            } else {
                if (openLine) latexLines.push(openLine);
                i++;
                while (i < lines.length) {
                    const l = lines[i];
                    if (l.trim().endsWith('$$')) {
                        const before = l.trim().slice(0, -2);
                        if (before) latexLines.push(before);
                        break;
                    }
                    latexLines.push(l);
                    i++;
                }
            }
            i++;
            const latex = latexLines.join('\n');
            output.push(`<div class="ai-md__math-block">${renderLatex(latex, true)}</div>`);
            continue;
        }

        // ── Fenced code block ──
        const fenceMatch = line.match(/^```(\w*)$/);
        if (fenceMatch) {
            const lang = escapeHtml(fenceMatch[1]);
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].match(/^```$/)) {
                codeLines.push(escapeHtml(lines[i]));
                i++;
            }
            i++; // skip closing ```
            const langAttr = lang ? ` data-lang="${lang}"` : '';
            const langLabel = lang ? `<span class="ai-md__code-lang">${lang}</span>` : '';
            output.push(
                `<div class="ai-md__code-block"${langAttr}>${langLabel}<pre><code>${codeLines.join('\n')}</code></pre></div>`
            );
            continue;
        }

        // ── Horizontal rule ──
        if (/^(---|\*\*\*|___)$/.test(line.trim())) {
            output.push('<hr class="ai-md__hr">');
            i++;
            continue;
        }

        // ── Heading ──
        const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = renderInline(escapeHtml(headingMatch[2]), opts);
            output.push(`<h${level} class="ai-md__heading ai-md__h${level}">${text}</h${level}>`);
            i++;
            continue;
        }

        // ── Blockquote ──
        if (line.match(/^>\s?/)) {
            const quoteLines = [];
            while (i < lines.length && lines[i].match(/^>\s?/)) {
                quoteLines.push(lines[i].replace(/^>\s?/, ''));
                i++;
            }
            const quoteContent = quoteLines.map(l => renderInline(escapeHtml(l), opts)).join('<br>');
            output.push(`<blockquote class="ai-md__blockquote">${quoteContent}</blockquote>`);
            continue;
        }

        // ── Unordered list ──
        if (line.match(/^[\s]*[-*]\s+/)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^[\s]*[-*]\s+/)) {
                const itemText = lines[i].replace(/^[\s]*[-*]\s+/, '');
                items.push(`<li>${renderInline(escapeHtml(itemText), opts)}</li>`);
                i++;
            }
            output.push(`<ul class="ai-md__list">${items.join('')}</ul>`);
            continue;
        }

        // ── Ordered list ──
        if (line.match(/^[\s]*\d+\.\s+/)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^[\s]*\d+\.\s+/)) {
                const itemText = lines[i].replace(/^[\s]*\d+\.\s+/, '');
                items.push(`<li>${renderInline(escapeHtml(itemText), opts)}</li>`);
                i++;
            }
            output.push(`<ol class="ai-md__list ai-md__list--ordered">${items.join('')}</ol>`);
            continue;
        }

        // ── Empty line ──
        if (line.trim() === '') {
            i++;
            continue;
        }

        // ── Paragraph (default) ──
        // Collect consecutive non-empty, non-special lines
        const paraLines = [];
        while (i < lines.length
            && lines[i].trim() !== ''
            && !lines[i].trim().startsWith('$$')
            && !lines[i].match(/^```/)
            && !lines[i].match(/^#{1,4}\s/)
            && !lines[i].match(/^>\s?/)
            && !lines[i].match(/^[\s]*[-*]\s+/)
            && !lines[i].match(/^[\s]*\d+\.\s+/)
            && !lines[i].match(/^(---|\*\*\*|___)$/)) {
            paraLines.push(renderInline(escapeHtml(lines[i]), opts));
            i++;
        }
        if (paraLines.length > 0) {
            output.push(`<p class="ai-md__p">${paraLines.join('<br>')}</p>`);
        }
    }

    return output.join('');
}
