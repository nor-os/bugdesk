/**
 * markdown.js — the markdown BugDesk reads back.
 *
 * Bug descriptions and comments are stored as markdown in the .md files, so
 * this is a renderer, not an editor concern — `md_editor.js` produces the
 * source, this turns it into HTML for the mask and the comment stream.
 *
 * Supported, because these are what a game bug report actually uses:
 *   headings, paragraphs, hard line breaks, horizontal rules
 *   fenced code (with a language hint) and inline code
 *   bullet / numbered / task lists, blockquotes
 *   GFM tables, with per-column alignment
 *   images (screenshots pasted into a comment) and links
 *   bold, italic, strikethrough
 *
 * SAFETY. The input is escaped ONCE, up front, before any rule runs — so
 * every rule below only ever wraps our own tags around text that can no
 * longer contain markup. Code spans are additionally lifted out and put back
 * afterwards so their contents cannot be re-parsed as markdown. URLs go
 * through `safeUrl`, which permits only http(s), mailto, and same-origin
 * paths: a `javascript:` href in a bug title is exactly the kind of thing a
 * tracker must not execute.
 */

import { esc } from './data.js';

/* ── inline ─────────────────────────────────────────────────────── */

/** Allow http(s)/mailto/relative only. Everything else — javascript:,
 *  data:, vbscript:, file: — collapses to '#', so the link renders but does
 *  nothing. Called with ALREADY-ESCAPED text, hence the &amp; tolerance. */
function safeUrl(raw) {
    const u = String(raw || '').trim().replace(/&amp;/g, '&');
    if (!u) return '#';
    if (/^(https?:|mailto:)/i.test(u)) return u;
    // Same-origin: absolute path, or a plain relative name with no scheme.
    if (/^[/#?]/.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '#';
}

/**
 * A URL as something a person can read.
 *
 * A record is full of pasted links — a PR, a build, a doc, a vendor's ticket —
 * and pasted links are long. One of them can be wider than the whole tile, and
 * a wrapped 200-character line of query parameters buries the sentence it was
 * evidence for. So the LINK TEXT is shortened and the full URL goes in the
 * title, where hovering still gives you the real thing.
 *
 * Shortened by dropping what carries no meaning to a reader, in order: the
 * scheme, a `www.`, a trailing slash, then the middle of the path — the host and
 * the LAST segment are what identify a link ("github.com/…/pull/318"), so those
 * are what survive. The query and fragment become a bare `?` and `#`: that a
 * link is parameterised is worth seeing, the parameters are not.
 *
 * Deliberately NOT a fetched page title. That would mean the browser reaching
 * out to every host mentioned in every record — blocked by CORS most of the
 * time, slow the rest, and a quiet promise that reading a bug report tells
 * somebody's server you read it.
 */
export function shortenUrl(raw, max = 52) {
    const full = String(raw || '').replace(/&amp;/g, '&');
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(full) ? full : `https://${full}`); }
    catch { return raw; }

    const host = url.hostname.replace(/^www\./, '');
    const segs = url.pathname.split('/').filter(Boolean);

    let path = segs.join('/');
    if (`${host}/${path}`.length > max && segs.length > 2) {
        // Keep the first and last segment: the first says what KIND of thing it
        // is ("pull", "issues", "documents"), the last says which one.
        path = `${segs[0]}/…/${segs[segs.length - 1]}`;
    }
    let out = path ? `${host}/${path}` : host;

    // ONE ellipsis, ever. It means "there is more here than I am showing", and
    // whether the more is a truncated path or a query string does not change
    // what the reader does about it — they hover, or they click. Two of them in
    // one label ("a/…/b.html?…") is noise pretending to be precision.
    if (out.length > max) out = `${out.slice(0, max - 1)}…`;
    else if (path === segs.join('/') && (url.search || url.hash)) out += '…';
    return out;
}

/* Bare URLs in prose. Bounded by whitespace or an opening bracket so a link
 * inside `(see https://…)` is caught, and stopped before HTML — the input is
 * already escaped, so `<`, `>` and `"` only appear as entities and a raw one
 * would mean the tag scaffolding this rule must not reach into. */
const RE_BARE_URL = /(^|[\s(])(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;

/* Punctuation that ends a SENTENCE rather than a URL. A trailing ')' is only
 * dropped when it closes a bracket the URL did not open — "(see https://x.com)"
 * ends the parenthesis, but a Wikipedia link legitimately ends in one. */
function trimUrlTail(u) {
    let url = u;
    for (;;) {
        const last = url[url.length - 1];
        if ('.,;:!?'.includes(last)) { url = url.slice(0, -1); continue; }
        if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
            url = url.slice(0, -1);
            continue;
        }
        if (url.endsWith('&quot;') || url.endsWith('&#39;')) {
            url = url.slice(0, url.lastIndexOf('&'));
            continue;
        }
        return url;
    }
}

/** Inline rules, applied to one already-escaped run of text. */
function inline(text) {
    // NUL-delimited placeholders: the input is escaped HTML, so it can never
    // contain a NUL of its own and the restore pass cannot misfire on real text.
    // Code spans first, replaced by placeholders so the rules below cannot
    // reach inside them (`**not bold**` in code must stay literal).
    const spans = [];
    let s = text.replace(/`([^`\n]+)`/g, (_m, code) => {
        spans.push(code);
        return `\u0000${spans.length - 1}\u0000`;
    });

    // Anything that PRODUCES a tag is parked as a placeholder too: the autolink
    // rule below scans for bare URLs, and without this it would find the href it
    // had just written and link the inside of its own <a>.
    const nodes = [];
    const park = (html) => {
        nodes.push(html);
        return `\u0001${nodes.length - 1}\u0001`;
    };

    s = s
        // Images before links — the syntax differs only by the leading '!'.
        // The optional title arrives as &quot;…&quot; — the whole document was
        // escaped before any rule ran, quotes included.
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
            (_m, alt, src, title) => park(
                `<img class="td-md__img" src="${safeUrl(src)}" alt="${alt}"` +
                `${title ? ` title="${title}"` : ''} loading="lazy">`))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
            (_m, label, href) => park(
                `<a href="${safeUrl(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`))
        // Bare URLs, AFTER the explicit forms have been parked: a link somebody
        // gave a label to keeps its label.
        .replace(RE_BARE_URL, (_m, lead, raw) => {
            const url = trimUrlTail(raw);
            const href = safeUrl(url.startsWith('www.') ? `https://${url}` : url);
            if (href === '#') return `${lead}${raw}`;
            return lead + park(
                `<a href="${href}" target="_blank" rel="noopener noreferrer"`
                + ` title="${url}" class="td-md__url">${shortenUrl(url)}</a>`)
                + raw.slice(url.length);
        })
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        // Single '*' only when not part of a '**' pair already consumed above.
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');

    return s
        .replace(/\u0001(\d+)\u0001/g, (_m, i) => nodes[Number(i)])
        .replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${spans[Number(i)]}</code>`);
}

/* ── block structure ────────────────────────────────────────────── */

const RE_FENCE   = /^\s*```(\S*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RE_HR      = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
// `&gt;`, not `>`: block detection runs AFTER the single escape pass, so the
// blockquote marker the user typed is already an entity by the time we look.
const RE_QUOTE   = /^\s{0,3}&gt;\s?(.*)$/;
const RE_BULLET  = /^(\s*)[-*+]\s+(.*)$/;
const RE_ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const RE_TASK    = /^\[([ xX])\]\s+(.*)$/;
const RE_TROW    = /^\s*\|(.+)\|\s*$/;
const RE_TSPLIT  = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Split a `| a | b |` row into its cells. */
const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
    .split('|').map((c) => c.trim());

/** Column alignments from a `|:--|--:|:-:|` separator row. */
function alignments(line) {
    return cells(line).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
}

const alignAttr = (a) => (a ? ` style="text-align:${a}"` : '');

/** Render markdown to HTML. Safe to hand straight to innerHTML. */
export function renderMarkdown(src) {
    if (!src) return '';
    // ONE escape pass for the whole document — see the safety note above.
    const lines = esc(String(src)).split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        // Fenced code — consumed verbatim, no inline rules inside.
        const fence = RE_FENCE.exec(line);
        if (fence) {
            const lang = fence[1];
            const body = [];
            i++;
            while (i < lines.length && !RE_FENCE.test(lines[i])) body.push(lines[i++]);
            i++; // closing fence (or EOF — an unterminated block still renders)
            out.push(`<pre class="td-code"${lang ? ` data-lang="${lang}"` : ''}>`
                + `<code>${body.join('\n')}</code></pre>`);
            continue;
        }

        if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

        const heading = RE_HEADING.exec(line);
        if (heading) {
            const level = heading[1].length;
            out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
            i++;
            continue;
        }

        // Table: a pipe row followed by an alignment row.
        if (RE_TROW.test(line) && i + 1 < lines.length && RE_TSPLIT.test(lines[i + 1])) {
            const head = cells(line);
            const align = alignments(lines[i + 1]);
            i += 2;
            const body = [];
            while (i < lines.length && RE_TROW.test(lines[i])) body.push(cells(lines[i++]));
            out.push(
                '<div class="td-md__tablewrap"><table class="td-md__table"><thead><tr>'
                + head.map((c, n) => `<th${alignAttr(align[n])}>${inline(c)}</th>`).join('')
                + '</tr></thead><tbody>'
                + body.map((row) => '<tr>'
                    + head.map((_h, n) => `<td${alignAttr(align[n])}>${inline(row[n] ?? '')}</td>`).join('')
                    + '</tr>').join('')
                + '</tbody></table></div>');
            continue;
        }

        // Blockquote — collect the run, strip the markers, render recursively
        // so a quote can hold lists and code like anything else.
        if (RE_QUOTE.test(line)) {
            const body = [];
            while (i < lines.length && RE_QUOTE.test(lines[i])) {
                body.push(RE_QUOTE.exec(lines[i])[1]);
                i++;
            }
            out.push(`<blockquote>${_renderEscaped(body.join('\n'))}</blockquote>`);
            continue;
        }

        // Lists. One nesting level is honoured (indent ≥ 2), which is as deep
        // as bug reports go; deeper indents flatten into the nested list.
        if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
            const isOrdered = (l) => RE_ORDERED.test(l) && !RE_BULLET.test(l);
            const ordered = isOrdered(line);
            const items = [];
            while (i < lines.length) {
                const m = RE_BULLET.exec(lines[i]) || RE_ORDERED.exec(lines[i]);
                if (!m) break;
                const depth = m[1].length >= 2 ? 1 : 0;
                // A bulleted run followed by a numbered one is TWO lists.
                // Only the outer level ends the run — an indented item of the
                // other type is a nested list, which _renderList handles.
                if (depth === 0 && isOrdered(lines[i]) !== ordered) break;
                items.push({ depth, text: m[2], ordered: isOrdered(lines[i]) });
                i++;
            }
            out.push(_renderList(items, ordered));
            continue;
        }

        // Paragraph: consecutive non-blank lines that start no other block.
        const para = [];
        while (i < lines.length && lines[i].trim()
               && !RE_FENCE.test(lines[i]) && !RE_HR.test(lines[i])
               && !RE_HEADING.test(lines[i]) && !RE_QUOTE.test(lines[i])
               && !RE_BULLET.test(lines[i]) && !RE_ORDERED.test(lines[i])
               && !RE_TROW.test(lines[i])) {
            para.push(lines[i++]);
        }
        // A pipe row with no alignment row underneath is not a table — let it
        // fall through as text rather than swallowing the line.
        if (!para.length) { para.push(lines[i++]); }
        out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }

    return out.join('\n');
}

/** One list level, with task-list checkboxes.
 *
 *  A nested run is emitted INSIDE the <li> that precedes it, not as its
 *  sibling — `<ul>` as a direct child of `<ul>` is invalid, and browsers
 *  reparent it in ways that break the indent the user typed. */
function _renderList(items, ordered) {
    const tag = ordered ? 'ol' : 'ul';
    const parts = [];
    for (let n = 0; n < items.length; n++) {
        if (items[n].depth === 1) {
            const nested = [];
            const nestedOrdered = items[n].ordered;
            while (n < items.length && items[n].depth === 1) nested.push(items[n++]);
            n--;
            const sub = _renderList(nested.map((x) => ({ ...x, depth: 0 })), nestedOrdered);
            if (parts.length) {
                // Splice into the open <li> above by reopening it.
                parts[parts.length - 1] = parts[parts.length - 1].replace(/<\/li>$/, `${sub}</li>`);
            } else {
                // Indented item with no parent above it — keep it rather than
                // dropping the content.
                parts.push(`<li>${sub}</li>`);
            }
            continue;
        }
        const task = RE_TASK.exec(items[n].text);
        parts.push(task
            ? `<li class="td-md__task"><input type="checkbox" disabled${
                task[1].toLowerCase() === 'x' ? ' checked' : ''}> ${inline(task[2])}</li>`
            : `<li>${inline(items[n].text)}</li>`);
    }
    return `<${tag}>${parts.join('')}</${tag}>`;
}

/** Blockquote bodies re-enter the renderer, but their text has ALREADY been
 *  escaped by the outer pass — escaping twice would print `&amp;lt;`. This
 *  round-trips it so the single-escape invariant holds. */
function _renderEscaped(escaped) {
    return renderMarkdown(escaped.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
}
