/**
 * HelpService - Centralized help content management
 *
 * Loads, caches, and provides access to markdown help content.
 * Help files are stored in /html/help/ as .md files.
 *
 * Features:
 * - Lazy loading of help content
 * - In-memory caching
 * - Markdown-to-HTML rendering
 * - Topic-based organization
 * - Search support (future)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Simple Markdown Parser
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simple markdown-to-HTML converter.
 * Supports: headers, bold, italic, code, links, lists, blockquotes, hr, images.
 *
 * For more complex rendering, consider loading marked.js from CDN.
 *
 * @param {string} markdown - Markdown source
 * @returns {string} HTML output
 */
function parseMarkdown(markdown) {
    if (!markdown) return '';

    let html = markdown.replace(/\r\n/g, '\n');

    // Escape HTML entities (but preserve our markdown)
    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const langClass = lang ? ` class="language-${lang}"` : '';
        return `\n<pre><code${langClass}>${code.trim()}</code></pre>\n`;
    });

    // Inline code (`...`)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Tables - must be processed before other block elements
    html = html.replace(/^(\|.+\|)\n(\|[-:\s|]+\|)\n((?:\|.+\|\n?)+)/gm, (match, headerRow, separatorRow, bodyRows) => {
        // Parse header
        const headers = headerRow.split('|').slice(1, -1).map(c => c.trim());

        // Parse alignment from separator row
        const alignments = separatorRow.split('|').slice(1, -1).map(c => {
            const cell = c.trim();
            if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
            if (cell.endsWith(':')) return 'right';
            return 'left';
        });

        // Parse body rows
        const rows = bodyRows.trim().split('\n').map(row =>
            row.split('|').slice(1, -1).map(c => c.trim())
        );

        // Build HTML table
        let tableHtml = '<table class="help-table">\n<thead>\n<tr>';
        headers.forEach((header, i) => {
            const align = alignments[i] || 'left';
            tableHtml += `<th style="text-align:${align}">${header}</th>`;
        });
        tableHtml += '</tr>\n</thead>\n<tbody>\n';

        rows.forEach(row => {
            tableHtml += '<tr>';
            row.forEach((cell, i) => {
                const align = alignments[i] || 'left';
                tableHtml += `<td style="text-align:${align}">${cell}</td>`;
            });
            tableHtml += '</tr>\n';
        });

        tableHtml += '</tbody>\n</table>\n';
        return tableHtml;
    });

    // Headers (# to ######)
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule
    html = html.replace(/^---+$/gm, '<hr>');
    html = html.replace(/^\*\*\*+$/gm, '<hr>');

    // Bold and italic
    html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Images ![alt](url)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="help-image">');

    // Blockquotes
    html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

    // Unordered lists - capture consecutive list items
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '{{LI}}$1{{/LI}}');
    html = html.replace(/({{LI}}.*?{{\/LI}}\n?)+/g, (match) => {
        const items = match.replace(/{{LI}}(.*?){{\/LI}}\n?/g, '<li>$1</li>');
        return `<ul>${items}</ul>\n`;
    });

    // Ordered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '{{OLI}}$1{{/OLI}}');
    html = html.replace(/({{OLI}}.*?{{\/OLI}}\n?)+/g, (match) => {
        const items = match.replace(/{{OLI}}(.*?){{\/OLI}}\n?/g, '<li>$1</li>');
        return `<ol>${items}</ol>\n`;
    });

    // Paragraphs (double newline)
    html = html.replace(/\n\n+/g, '</p><p>');
    html = `<p>${html}</p>`;

    // Clean up empty paragraphs and fix nesting
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>\s*(<h[1-6]>)/g, '$1');
    html = html.replace(/(<\/h[1-6]>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<ol>)/g, '$1');
    html = html.replace(/(<\/ol>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<hr>)/g, '$1');
    html = html.replace(/(<hr>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<table)/g, '$1');
    html = html.replace(/(<\/table>)\s*<\/p>/g, '$1');

    // Clean up stray newlines but NOT inside pre/code blocks
    // Replace single newlines with space (not <br>) for better paragraph flow
    html = html.replace(/<\/p>\n<p>/g, '</p><p>');
    html = html.replace(/([^>\n])\n([^<\n])/g, '$1 $2');

    return html;
}

// ═══════════════════════════════════════════════════════════════════════════
// Help Topics Registry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Registry of BugDesk help topics. Content is inline so the help modal
 * works without a separate /help/*.md tree on disk.
 */
const HELP_TOPICS = {
    'getting-started': {
        title: 'Getting Started',
        category: 'basics',
        keywords: ['introduction', 'tutorial', 'beginner', 'first steps', 'overview',
                   'queue', 'bug', 'file a bug', 'new bug'],
        markdown: `# Getting Started with BugDesk

BugDesk is a local, markdown-backed bug tracker. Every bug is a plain
\`BUG-NNNN.md\` file — a YAML-frontmatter block plus a Description and
Comments section — living in a directory on disk (defaults to
\`./bugs\`; see \`BUGDESK_BUGS\`). There's no separate database and no
GitHub Issues API round-trip: an AI coding agent can read and edit the
files directly, alongside a human triaging them through this UI, and
the whole history is git-tracked next to the code it describes.

## The queue

**Home** is the queue — a sortable, filterable table of bugs (Pri,
Bug, Type, Summary, Status, Updated, Assignee). Click a row to open
that bug as a tab. Right-click a row — or several selected rows — for
Open / Open in new tab / new window / split, Copy bug ID, and
"Filter by this cell" / "Save as filter…" built from whatever you
clicked. Which bugs the queue shows depends on which filter is
active — see the **Filters** topic.

## Filing a bug

**New Bug**, in the top bar, opens a mask: Title, Type, Severity,
Subsystem, Assignee, Labels, Links, and a Description. Fill it in and
click **Create Bug** — the bug ID is assigned automatically, there's
nothing to type there. **Search**, right next to it, opens the exact
same mask in search mode instead: enter partial criteria and matches
open as tabs.

## The four-stage lifecycle

Every bug moves through four stages:

\`\`\`
open ──▶ investigation ⇄ testing ──▶ closed
        (closed may reopen to investigation on regression)
\`\`\`

A bug's mask shows the current stage as a chevron strip, with
**Action** buttons offering only the transitions the lifecycle
actually allows from wherever the bug currently is. See the
**Lifecycle & Authorship** topic for who owns each stage and how
comments are attributed.
`,
    },

    'lifecycle-authorship': {
        title: 'Lifecycle & Authorship',
        category: 'basics',
        keywords: ['lifecycle', 'authorship', 'author', 'human', 'agent', 'assignee',
                   'stage', 'status', 'open', 'investigation', 'testing', 'closed',
                   'comment', 'reviewer', 'reassign', 'needs my reply'],
        markdown: `# Lifecycle & Authorship

## The four stages

| status | typical owner | meaning |
|---|---|---|
| Open | human | first entry — **one-way out**, nothing returns here |
| Investigation | agent | on the agent to investigate and fix |
| Testing | human | on the human to verify the fix |
| Closed | human | verified and done — may reopen to Investigation on regression |

A bug's mask shows the stage as a chevron strip plus **Action**
buttons for the only legal moves from that stage (from Testing, for
example: "Back to investigation" or "Close"). There's no way to jump
straight from Open to Closed, or back from Closed to Open — the
buttons only ever offer what the lifecycle allows.

\`assignee\` is **explicit** — set by whoever last touched the bug (the
mask's reassign control, or the stage transition itself), never
derived from status — so it's always clear whose court a bug is in.

## The two roles

BugDesk assumes exactly two roles: a **human** who files, triages, and
tests bugs through this UI, and an **agent** who investigates them.
Neither name is fixed:

- The server's defaults come from environment variables —
  \`BUGDESK_HUMAN\` (default \`reviewer\`) and \`BUGDESK_AGENT\` (default
  \`agent\`) — read once at boot and exposed via \`GET /api/config\`.
- You can override either **per-browser** from **Settings → General →
  Authorship**: "Your name" / "Agent name". Leave either blank to keep
  using the server's default. A change here takes effect the next
  time BugDesk reloads — Settings will tell you so when you save it.

Whatever names are configured show up everywhere: the default
assignee, comment attribution, the "On me" / "On \\<agent\\>" filters,
and the comment composer's placeholder text.

## Comments

Every comment is a \`### YYYY-MM-DD · <author>\` markdown block,
rendered newest first. That's the whole point of the format — you
always know who said what, without depending on GitHub's issue
authorship or a \`gh\` token. The composer posts as whichever name
you're currently configured as (Enter posts, Alt+Enter for a new
line, paste a screenshot to attach it).

## "Needs my reply"

A bug needs the human's attention when its **last comment was the
agent's** — the builtin "Needs my reply" filter in the left rail is
exactly that check (last comment author = the agent, and not closed),
so it's the fastest way to see what's waiting on you specifically.
`,
    },

    'filters': {
        title: 'Filters',
        category: 'basics',
        keywords: ['filter', 'rail', 'queue', 'builtin', 'custom filter',
                   'filter editor', 'needs my reply', 'active', 'expression'],
        markdown: `# Filters

The left rail is a **filter rail**: builtin filters on top, your own
custom ones below, each with a live count badge.

## Builtin filters

In rail order:

| Filter | Matches |
|---|---|
| Needs my reply | Last comment is the agent's, and the bug isn't closed |
| Active *(default)* | Not closed — the queue you land on |
| All Bugs | Everything |
| Open | status = Open |
| Investigation | status = Investigation |
| Testing | status = Testing |
| Closed | status = Closed |
| On me | assignee = you |
| On \\<agent\\> | assignee = the agent |

Builtins can't be edited or deleted directly. Right-click one (or
hover its row) for **Duplicate as custom filter** — opens the editor
pre-seeded with the same expression as an editable copy — or **Copy
definition** to grab its expression as plain text.

## The filter editor

**New filter**, at the bottom of the rail, opens the filter editor: a
name, an icon, and a Group/Clause expression tree (AND / OR / NOT,
nested groups) with a **live preview** of the bugs it currently
matches as you build it. Available fields: Bug, Priority, Severity,
Status, Type, Summary, Subsystem, Assignee, Labels, Created, Updated,
Comments, Last comment by, Last comment date — each with the
operators its type supports (is / is not / contains / one of /
between / in the last N days / …).

Your own filters get the full set of actions: **Open**, **Edit**,
**Duplicate**, **Delete**, and **Copy definition**.

## Building a filter from what you're looking at

Right-click any cell in the queue table for **"Filter by \\<field\\>
'\\<value\\>'"** — opens that one-clause filter immediately — or
**"Save as filter…"** — opens the editor pre-seeded with it. From an
open queue, the toolbar's **Save as filter** button seeds a new
filter from the queue's current filter *plus* every per-column filter
box that currently has text in it; if a column filter can't be
translated faithfully into an expression clause, the status line says
which one was left out rather than silently dropping it.
`,
    },

    'keyboard-shortcuts': {
        title: 'Keyboard shortcuts',
        category: 'basics',
        keywords: ['hotkeys', 'keys', 'shortcuts', 'f1', 'desktops', 'tabs', 'nav',
                   'split', 'tile', 'window', 'pane', 'alt'],
        markdown: `# Keyboard shortcuts

The workspace is a tiling window manager: every page (the queue, a
bug, Settings) lives in a **tile** you can split, tab, pop into a
window, and move between virtual desktops.

## Tiles & splits

| Action | Key |
|--------|-----|
| Split the focused tile horizontally (new empty pane) | **Alt + H** |
| Split the focused tile vertically (new empty pane) | **Alt + V** |
| Open the tile's content in a horizontal split | **Alt + Shift + H** |
| Open the tile's content in a vertical split | **Alt + Shift + V** |
| Open the tile's content in a new tab | **Alt + T** |
| Open the tile's content in a new window | **Alt + N** |
| Promote the tile to a window / send it back (moves it) | **Alt + F** |
| Close the focused tile | **Alt + W** |

These same actions sit on each tile's chrome buttons and its
right-click menu too.

## Focus & arrangement

| Action | Key |
|--------|-----|
| Move focus between tiles | **Alt + ← / → / ↑ / ↓** |
| Swap the focused tile with its neighbour | **Alt + Shift + ← / → / ↑ / ↓** |

## Tabs

| Action | Key |
|--------|-----|
| Next / previous tab in the focused tile | **Ctrl + Tab / Ctrl + Shift + Tab** |
| Previous / next Console (bottom-panel) tab | **Shift + ← / →** |

## Desktops

| Action | Key |
|--------|-----|
| Switch to desktop N | **Alt + 1 … 9** |
| Move the focused tile to desktop N | **Alt + Shift + 1 … 9** |
| Cycle through desktops | **Ctrl + ← / →** |

## Navigation & general

| Action | Key |
|--------|-----|
| Jump to Queues (the only top-nav page) | **F1** |
| Go back (walk up the breadcrumb) | **Backspace**, or the browser's Back (**Alt + ←**, mouse back button, swipe) |
| Open the command palette (fuzzy bug search + commands) | **Ctrl/⌘ + K** |
| Open this help | **?** |
| Close a modal / the palette | **Esc** |

Most editing happens inline — there is no global save shortcut
because every change autosaves (a bug's mask is the one exception:
its Save / Cancel buttons enable once you've actually changed a
field).
`,
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// HelpService Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Service for loading and managing help content.
 */
class HelpService {
    constructor() {
        this._cache = new Map();
        this._basePath = '/help/';
        this._loading = new Map(); // Track in-flight requests
    }

    /**
     * Get the registry of all help topics.
     * @returns {Object} Topic registry
     */
    getTopics() {
        return HELP_TOPICS;
    }

    /**
     * Get topics by category.
     * @param {string} category - Category name
     * @returns {Object[]} Array of topics in category
     */
    getTopicsByCategory(category) {
        return Object.entries(HELP_TOPICS)
            .filter(([_, topic]) => topic.category === category)
            .map(([id, topic]) => ({ id, ...topic }));
    }

    /**
     * Get all categories.
     * @returns {string[]} Array of category names
     */
    getCategories() {
        const categories = new Set();
        Object.values(HELP_TOPICS).forEach(topic => categories.add(topic.category));
        return Array.from(categories);
    }

    /**
     * Search topics by keyword.
     * @param {string} query - Search query
     * @returns {Object[]} Matching topics
     */
    searchTopics(query) {
        if (!query) return [];
        const lowerQuery = query.toLowerCase();

        return Object.entries(HELP_TOPICS)
            .filter(([id, topic]) => {
                const inTitle = topic.title.toLowerCase().includes(lowerQuery);
                const inKeywords = topic.keywords.some(kw => kw.includes(lowerQuery));
                const inId = id.includes(lowerQuery);
                return inTitle || inKeywords || inId;
            })
            .map(([id, topic]) => ({ id, ...topic }));
    }

    /**
     * Load help content for a topic.
     * @param {string} topicId - Topic ID
     * @returns {Promise<{title: string, html: string, markdown: string}>}
     */
    async loadTopic(topicId) {
        const topic = HELP_TOPICS[topicId];
        if (!topic) {
            throw new Error(`Unknown help topic: ${topicId}`);
        }

        // Check cache
        if (this._cache.has(topicId)) {
            return this._cache.get(topicId);
        }

        // Check if already loading
        if (this._loading.has(topicId)) {
            return this._loading.get(topicId);
        }

        // Load from file
        const loadPromise = this._fetchTopic(topic);
        this._loading.set(topicId, loadPromise);

        try {
            const result = await loadPromise;
            this._cache.set(topicId, result);
            return result;
        } finally {
            this._loading.delete(topicId);
        }
    }

    /**
     * Fetch topic content. Inline markdown (the `markdown` field on a
     * topic) is preferred; otherwise we fall back to a file under
     * `_basePath`. BugDesk ships inline content because the help is
     * compact enough to live in the bundle.
     * @private
     */
    async _fetchTopic(topic) {
        if (typeof topic.markdown === 'string') {
            return {
                title: topic.title,
                markdown: topic.markdown,
                html: parseMarkdown(topic.markdown),
            };
        }

        if (!topic.file) {
            return {
                title: topic.title,
                markdown: `# ${topic.title}\n\n*Documentation coming soon.*`,
                html: `<h1>${topic.title}</h1><p><em>Documentation coming soon.</em></p>`,
            };
        }

        const url = `${this._basePath}${topic.file}`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                return {
                    title: topic.title,
                    markdown: `# ${topic.title}\n\n*Documentation coming soon.*`,
                    html: `<h1>${topic.title}</h1><p><em>Documentation coming soon.</em></p>`,
                };
            }
            const markdown = await response.text();
            return { title: topic.title, markdown, html: parseMarkdown(markdown) };
        } catch (error) {
            console.warn(`[HelpService] Failed to load ${topic.file}:`, error);
            return {
                title: topic.title,
                markdown: `# ${topic.title}\n\n*Failed to load help content.*`,
                html: `<h1>${topic.title}</h1><p><em>Failed to load help content.</em></p>`,
            };
        }
    }

    /**
     * Render markdown to HTML.
     * @param {string} markdown - Markdown source
     * @returns {string} HTML
     */
    renderMarkdown(markdown) {
        return parseMarkdown(markdown);
    }

    /**
     * Clear the cache.
     */
    clearCache() {
        this._cache.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Singleton Export
// ═══════════════════════════════════════════════════════════════════════════

let _helpService = null;

/**
 * Get the singleton HelpService instance.
 * @returns {HelpService}
 */
export function getHelpService() {
    if (!_helpService) {
        _helpService = new HelpService();
    }
    return _helpService;
}

export { HelpService, HELP_TOPICS, parseMarkdown };
export default getHelpService;
