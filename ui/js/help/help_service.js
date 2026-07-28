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
 * Registry of EcoAgent help topics. Content is inline so the help modal
 * works without a separate /help/*.md tree on disk.
 */
const HELP_TOPICS = {
    'getting-started': {
        title: 'Getting Started',
        category: 'basics',
        keywords: ['introduction', 'tutorial', 'beginner', 'first steps', 'overview'],
        markdown: `# Getting Started with EcoAgent

EcoAgent is a heterogeneous-agent macroeconomic simulator. Each agent
runs its own decision logic, holds an imperfect model of the world,
and adapts that model from observed outcomes. Markets are first-class
objects with swappable rules.

## The four modes

The left rail switches between the four authoring modes:

- **SFC** — sectors. Define the chart of accounts.
- **Markets** — market instances and their clearing rules
  (Continuous Double Auction, Search-and-matching, etc.).
- **Agents** — archetypes (with their parameters, brains, and loops)
  and scenarios (parameter-override presets).
- **Analytics** — built-in and user dashboards over a run.

Each mode swaps the left sidebar; the central workspace shows tabs
that survive mode switches.

## Hover-preview

You can **hover** a mode button on the left rail to preview that mode's
sidebar without leaving the current mode. Sidebar items stay clickable
during a preview — click to commit the switch.

## Bottom panel

A global panel sits below the workspace on every mode:

- **Population** — sampled / live instances of an archetype.
- **Run Console** — errors and notices raised while the world runs.
- **Bus** — message-bus topics agents publish on.
- **Store** — the shared key/value store agents coordinate through.
`,
    },

    'projects': {
        title: 'Projects',
        category: 'basics',
        keywords: ['project', 'create', 'open', 'save', 'directory', 'folder', 'recent'],
        markdown: `# Projects

A project is a directory on disk holding everything for one model:
sectors, archetypes, markets, scenarios, dashboards, and the
Python source for each archetype's loops.

Open, create, and close projects from **File → New project / Open
project / Close project**. Recently-opened projects appear in the
File menu's Recent section.

The current project's name is shown in the top bar; clicking it
opens the File menu.

There is **no manual save** — every edit (rename, parameter change,
code edit, scenario override) autosaves to the project directory.
Use git on the project folder for versioning.
`,
    },

    'sfc-mode': {
        title: 'SFC mode',
        category: 'sfc',
        keywords: ['sfc', 'stock-flow', 'sector', 'flow', 'godley',
                   'balance sheet', 'accounting', 'currency', 'asset kind'],
        markdown: `# SFC mode

The **SFC** (stock-flow-consistent) mode owns the model's chart of
accounts.

## Sectors

Each row in the sidebar's **Sectors** section is one sector
(industrial-firms, banks, government, households, foreign-us, …).
Open a sector to see:

- The **balance sheet** at the current viewing tick (Assets ·
  Liabilities · Equity).
- The **chart of accounts** for every archetype assigned to this
  sector — account labels, asset kinds, initial values.
- A **slice by asset kind** view: cross-sector consistency, time
  series, and the transaction matrix scoped to one kind.

A sector belongs to exactly one **country**. The country owns the
sector's currency and (optionally) the central bank that issues it.
This \`Sector → Country → Currency\` chain is how every currency
question gets answered — there is no project-wide "default" or
"domestic" currency anymore.

## Countries

A **country** is a jurisdiction grouping: an id, label, currency
(FK to a declared currency), and an optional central-bank archetype.
Multiple countries can share a currency (currency-union case —
Germany and France both → EUR). The SFC sidebar lists countries
hierarchically with their sectors nested. Create / rename / delete
via the sidebar's \`+\` button or per-row context menus.

## Currencies

Currencies are pure value units — declared once at the project
level, assigned to one or more countries. Surfaced wherever they're
*used*: a country's currency picker (sidebar country edit), an FX
market's base/quote pair (Market tab), and the sector-tab header
(country dropdown that resolves to a currency).

Each currency is an id (e.g. \`EUR\`, \`USD\`), a label, an optional
display symbol, and an optional legacy issuer sector. No currency
is privileged — currency context always resolves via the agent's
sector's country. Add / edit / delete currencies via the
**Manage currencies…** entry on any currency dropdown.

The FX market resolves a pair's legs by matching currency ids
against asset-kind tags.

## Asset kinds

Asset kinds (cash, deposits, loans, goods, capital, …) categorise
the accounts on every balance sheet. Each kind is either
**financial** (money-like; clears against a counterparty) or
**real** (produced or natural; conservation per kind isn't
enforced). A financial kind may carry a **currency** tag — that's
how FX settlement decides which account holds the receiving side
of each leg.
`,
    },

    'agents-mode': {
        title: 'Agents mode',
        category: 'agents',
        keywords: ['agent', 'variant', 'archetype', 'brain', 'observe', 'execute', 'adjust', 'population'],
        markdown: `# Agents mode

The **Agents** mode owns agent definitions and their variants, plus
scenarios (parameter-override presets).

## Archetype loops

Every archetype has five editor tabs that map onto the agent runtime:

- **Settings** — label, sector assignment, population, parameters.
- **Brain** — \`__init_brain__\`: state that survives across ticks
  (scalars, deques, regression models). Read-write here; the runtime
  freezes the brain after construction.
- **Observe** — \`observe(self, ctx)\`: read prices and signals from
  the bus, accumulate samples.
- **Execute** — \`execute(self, ctx)\`: submit orders, book postings.
- **Adjust** — \`adjust(self, ctx)\`: update the brain's world-view
  in response to observed outcomes. The only place brain writes are
  allowed after \`__init_brain__\`.

## Scenarios

A scenario overrides parameter defaults at world-build time without
editing archetypes. The active scenario is set via the topbar
scenario widget; opening a scenario tab edits the overrides without
activating it.
`,
    },

    'agent-instances': {
        title: 'Instances (populations)',
        category: 'agents',
        keywords: ['instance', 'population', 'pin', 'override', 'shuffle',
                   'exclude', 'reroll', 'materialize', 'seed', 'distribution'],
        markdown: `# Instances

A variant's **population** is a set of instances sampled from its
parameter distributions. The **Instances** sub-tab is a grid over that
sampled population — one row per instance, one column per parameter.

## Draw vs. pins

- The **draw** is the sampled value. It is a pure function of the
  variant's spec and its **seed** — the same seed reproduces the same
  population. Changing a parameter's distribution re-samples the draw.
- A **pin** overrides one instance's parameter with a value you type
  (double-click a cell). Pins are **durable** (saved to the variant's
  file) and **survive a shuffle** — only the un-pinned cells re-roll.

## Toolbar

- **Re-sample** — re-materialize the population from the distributions.
- **Shuffle** — re-roll every un-pinned slot from a *new* seed.
- **seed** — the committed draw seed; type one to reproduce a population.
- **re-instantiate each run** — re-draw this variant with fresh entropy
  before every run (pins still hold). Off = a fixed, reproducible draw.

## Per-instance & bulk

Select rows (checkboxes) to **Exclude** ("delete these next run", stable
across shuffles), **Reroll** (re-draw just those slots), or **Watch**.
A row's ⋮ menu opens its **dashboard** (live params / balances / brain)
or adds a **watch** expression to the bottom-panel Watch tab. The μ / σ
row summarises each parameter's spread; **export** dumps the population
to CSV.
`,
    },

    'markets-mode': {
        title: 'Markets mode',
        category: 'markets',
        keywords: ['market', 'cda', 'auction', 'bond', 'interbank',
                   'order book', 'clearing', 'fx', 'currency', 'merit order'],
        markdown: `# Markets mode

Markets are first-class objects with swappable clearing rules.
Currently implemented:

- **Continuous Double Auction (CDA)** — bids and asks, immediate
  matching at the resting price.
- **Search and Matching** — labour-market style search frictions.
- **Bond Auction** — primary issuance, sealed-bid clearing.
- **Bond Secondary** — CDA over already-issued bonds.
- **Interbank** — credit lines between banks.
- **Merit-order** — uniform-price energy dispatch: sellers ranked
  cheapest-first, every cleared seller paid the marginal-generator
  price. Rules: \`price_cap\` (optional ceiling on the clearing
  price).
- **FX** — spot exchange-rate market over a declared currency pair.
  Rules: \`base_currency\` / \`quote_currency\`. Clearing price is
  units of quote per unit of base. Settlement transfers base-units
  from seller to buyer, and rate × base-units in the quote currency
  the other way — using the financial asset kind tagged with each
  currency.

A **market archetype** is a template (e.g. \`goods\`); instances under
the archetype are dotted ids (\`goods.sector_a\`, \`goods.sector_b\`).
The sidebar groups instances under their archetype — expand/collapse
state persists.

The market tab has two sub-tabs:

- **Live** — order book and recent trades (during a run).
- **Settings** — clearing-kind selector + per-kind rules (FX pair,
  merit-order cap, etc.) merged in one place.

## Currencies, countries, and currency zones

EcoAgent models monetary jurisdictions as **countries**. Each
country has a currency and (optionally) a central bank. Multiple
countries can share a currency (currency-union case).

- A **currency** is an id + label + symbol — a pure value unit.
  No currency is privileged. Manage currencies via the
  **Manage currencies…** entry on any currency dropdown.
- A **country** is a jurisdiction: id, label, currency (FK), and
  optional central-bank archetype. Multiple countries may share
  a currency. Manage in the SFC sidebar.
- A **sector** belongs to exactly one country. The sector's
  currency context derives from \`sector → country → currency\`
  on every read; there is no per-sector currency tag anymore.
- A **financial asset kind** (cash, deposits, bonds, reserves, …)
  may be tagged with a currency. That tag means "accounts holding
  this kind are balances in that currency."
- The **FX market** for a pair resolves each leg to the *single*
  financial kind tagged with the matching currency. Declaring two
  kinds for the same currency is an error — settlement can't pick
  one.

Cascading renames: renaming a currency rewrites every asset kind,
country, and bank-archetype reference. Deleting a currency is
refused while any asset kind or country still uses it. Deleting a
country is refused while any sector still belongs to it. Deleting
a sector is refused if any currency declares it as the legacy
issuer.
`,
    },

    'analytics-mode': {
        title: 'Analytics mode',
        category: 'analytics',
        keywords: ['analytics', 'dashboard', 'chart', 'plot', 'tile', 'monitoring'],
        markdown: `# Analytics mode

Build and view dashboards over a run.

## Built-in dashboards

Presets shipped with EcoAgent — corridor diagrams, sector
aggregates, market-depth views. Click one to open it as a tab.

## My dashboards

- **Live workspace** — a scratch dashboard that doesn't persist
  between sessions. Good for one-off exploration.
- **Saved dashboards** — created with the **+** button. Each is
  stored in the project directory and round-trips as an analytics
  tab.

Inside a dashboard, drop tiles for a (source, property) pair —
ledger account histories, archetype aggregates, market spreads.
Tiles auto-refresh from the run buffer; the time scrubber across
SFC tabs and dashboards is synchronised.
`,
    },

    'bottom-panel': {
        title: 'Bottom panel',
        category: 'observability',
        keywords: ['bottom panel', 'population', 'run console', 'bus', 'store', 'inspector', 'log'],
        markdown: `# Bottom panel

A four-tab observability strip below the workspace, available on
every mode.

## Population

Pick an archetype on the right; the table on the left shows sampled
(pre-run) or live (during-run) instances with their parameters and
account balances.

- Click a **row** to open the per-agent dashboard.
- Click the **eye icon** to jump straight to the same dashboard with
  the Brain section in view.
- A live banner appears during a run showing how many of the total
  population are sampled.

## Run Console

Errors and notices raised by agent or market code during a run, with
filename / tick / message and (when present) a Python traceback.

## Bus

Live snapshot of message-bus topics — what payload each agent is
currently broadcasting. Click a topic to open its **Bus Inspector**
window: full event stream, extra filters, and a tick-by-tick
time-travel scrubber.

## Store

The shared key/value store. A live database, no history — what's
visible is what's there right now.
`,
    },

    'keyboard-shortcuts': {
        title: 'Keyboard shortcuts',
        category: 'basics',
        keywords: ['hotkeys', 'keys', 'shortcuts', 'f1', 'desktops', 'tabs', 'nav',
                   'split', 'tile', 'window', 'pane', 'alt'],
        markdown: `# Keyboard shortcuts

The workspace is a tiling window manager: every page lives in a **tile**
you can split, tab, pop into a window, and move between virtual desktops.

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

These same actions sit on each tile's chrome buttons and right-click
menu, and on the Signature / Code / Flows pane headers in the agent
**Code** tab.

## Focus & arrangement

| Action | Key |
|--------|-----|
| Move focus between tiles | **Alt + ← / → / ↑ / ↓** |
| Swap the focused tile with its neighbour | **Alt + Shift + ← / → / ↑ / ↓** |

## Tabs

| Action | Key |
|--------|-----|
| Next / previous tab in the focused tile | **Ctrl + Tab / Ctrl + Shift + Tab** |
| Previous / next bottom-panel tab | **Shift + ← / →** |

## Desktops

| Action | Key |
|--------|-----|
| Switch to desktop N | **Alt + 1 … 9** |
| Move the focused tile to desktop N | **Alt + Shift + 1 … 9** |
| Cycle through desktops | **Ctrl + ← / →** |

## Navigation & general

| Action | Key |
|--------|-----|
| Jump to top-nav page | **F1–F8** (Home, SFC, Assets, Markets, Agents, Scenarios, Analytics, KPIs) |
| Go back (walk up the breadcrumb) | **Backspace**, or the browser's Back (**Alt + ←**, mouse back button, swipe) |
| Open the command palette | **Ctrl/⌘ + K** |
| Open this help | **?** |
| Close a modal / the palette | **Esc** |

Most editing happens inline — there is no global save shortcut
because every change autosaves.
`,
    },

    'agent-loops': {
        title: 'Agent loops (with examples)',
        category: 'agents',
        keywords: ['agent', 'loop', 'brain', 'observe', 'execute', 'adjust',
                   'init_brain', 'ctx', 'self', 'bus', 'store', 'example'],
        markdown: `# Agent loops

Each archetype declares four Python *bodies* — one per loop in the
agent runtime. The runtime runs them in this order, **every tick**,
on every instance:

\`\`\`
              ┌─── (once at world build) ───┐
              │       __init_brain__         │
              └──────────────────────────────┘
                              │
        ╭─────────────────────┼─────────────────────╮
        │  observe   →   execute   →   adjust      │  ← one tick
        ╰─────────────────────┴─────────────────────╯
        ▲                                            │
        └────────────────── next tick ───────────────┘
\`\`\`

| Loop              | What it does                                            | Brain writes? |
|-------------------|---------------------------------------------------------|---------------|
| \`__init_brain__\` | One-shot. Populate the brain (scalars, deques, models). | yes           |
| \`observe\`        | Read prices / bus topics, accumulate samples.            | no            |
| \`execute\`        | Submit orders, transfer money.                            | no            |
| \`adjust\`         | Update the brain's world-view based on outcomes.         | yes           |

You write only the **body** of each — no \`def …:\` header. The
editor wraps your code in the right signature internally.

## What's available in scope

| Symbol                       | Where        | Meaning                                                   |
|------------------------------|--------------|-----------------------------------------------------------|
| \`self.<param>\`              | every loop   | This instance's sampled value for that parameter.         |
| \`self.brain.<key>\`          | every loop   | Inter-tick state. Writable only in init / adjust.         |
| \`self.account('Cash')\`      | every loop   | This instance's account handle (balance, debits/credits). |
| \`ctx.bus.publish(topic, x)\` | execute      | Broadcast \`x\` on \`topic\` for any subscriber.          |
| \`ctx.bus.subscribe(topic)\`  | observe      | Read the latest message on \`topic\`.                     |
| \`ctx.store[key]\`            | every loop   | Shared key/value store, read-write.                       |
| \`ctx.markets['m-id']\`       | execute      | Submit / cancel orders on a market.                       |
| \`ctx.tick\`                  | every loop   | Integer tick counter.                                     |

\`ctx\` is **not** passed to \`__init_brain__\` — at construction the
agent has no world yet.

## End-to-end example: a price-tracking buyer

An agent that watches the energy price, keeps a running average, and
buys when the price is below its average minus a spread.

### \`__init_brain__\`

\`\`\`python
# Smoothed price estimate; grows from samples taken in observe.
self.brain.smoothed_price = None
self.brain.alpha = 0.1   # EWMA weight on new observations
\`\`\`

### \`observe\`

\`\`\`python
quote = ctx.bus.subscribe('market.energy.last_price')
if quote is not None:
    # First sample: seed; afterwards smooth in place.
    if self.brain.smoothed_price is None:
        self.brain.smoothed_price = quote
\`\`\`

(Smoothing the running estimate happens in \`adjust\`, not here —
\`observe\` only collects.)

### \`execute\`

\`\`\`python
price = ctx.markets['energy'].last_price
target = self.brain.smoothed_price
cash   = self.account('Cash').balance
if (target is not None
        and price is not None
        and price < target - self.spread
        and cash > 0):
    qty = min(self.max_buy, cash // price)
    if qty > 0:
        ctx.markets['energy'].submit_bid(qty=qty, price=price)
\`\`\`

### \`adjust\`

\`\`\`python
quote = ctx.bus.subscribe('market.energy.last_price')
if quote is not None and self.brain.smoothed_price is not None:
    a = self.brain.alpha
    self.brain.smoothed_price = a * quote + (1 - a) * self.brain.smoothed_price
\`\`\`

\`spread\` and \`max_buy\` are parameters declared on the Settings tab.
\`alpha\` could be either — declaring it as a param makes it
scenario-overridable; keeping it in the brain hides it from the
override surface.

## Patterns

**State that must survive ticks** → \`self.brain\`. Anything else is
local to the loop body and disappears at the end of that call.

**Reading bus messages from execute** is allowed but discouraged —
the convention is "observe reads, execute acts". If you find yourself
fetching the same topic in two loops, sample it in \`observe\` into
the brain and read the brain copy in \`execute\`.

**Don't mutate the brain in observe or execute.** The runtime freezes
the brain dict outside of init/adjust. You'll get a \`FrozenError\`.
This isn't ergonomic restriction — it's what gives the run a clean
distinction between sensing, acting, and learning.

## Debugging

- The **Brain inspector** (eye icon on a Population row, or click the
  row) shows live brain values per instance with per-key sparklines.
- The **Run Console** captures \`print()\`, exceptions, and validator
  errors with tick + source.
- \`self.account('X').balance\` works in all loops — if you need to
  know "did my last posting actually land?", read the balance again
  next tick.
`,
    },

    'distributions': {
        title: 'Distributions',
        category: 'basics',
        keywords: ['distribution', 'random', 'sampling', 'monte carlo',
                   'uniform', 'normal', 'lognormal', 'triangular', 'beta', 'discrete'],
        markdown: `# Distributions

Several places in EcoAgent let you replace a scalar with a
**distribution**: every instance of an archetype draws its own value
when the world is built, so you get heterogeneity for free.

You see the distribution editor in two places:

1. **Archetype → Settings → Parameters** — the *Distribution* column.
   Click the chip (e.g. \`U(0, 10)\` or \`Constant\`) to open the
   editor. Affects only numeric param types (\`float\` / \`int\`).
2. **Sector → Chart of accounts → \`Distribution\` button** on an
   account template — the initial balance is sampled per instance.

A **scenario override** that targets a distributed param replaces the
*default* used as the centre of the distribution, but the
distribution's shape stays the same.

## The seven kinds

| Kind        | Fields                       | Read it as                                    |
|-------------|------------------------------|-----------------------------------------------|
| Constant    | (none)                       | No randomness — use the param's Default.      |
| Uniform     | \`min\`, \`max\`               | Equally likely between min and max.           |
| Normal      | \`mean\`, \`stddev\`           | Bell curve. Can produce negative values.      |
| Log-normal  | \`mu\`, \`sigma\`              | \`exp(Normal(μ, σ))\`. Always positive.       |
| Triangular  | \`min\`, \`mode\`, \`max\`     | Peaks at \`mode\`, falls to 0 at the ends.    |
| Beta        | \`alpha\`, \`beta\`            | Always in \`[0, 1]\`. Shape via α, β.        |
| Discrete    | \`values\` (comma-separated)  | Picked uniformly from the listed values.      |

The editor remembers your previous fields when you change kind — so
flipping Normal → Log-normal doesn't wipe \`mean\` if \`mu\` is empty.

## Choosing a kind

- **One value, no spread** → Constant. (Same as leaving the
  Distribution chip alone.)
- **"Anywhere in this range, no preference"** → Uniform.
- **"Roughly this value, occasionally further"** → Normal (when the
  variable can be negative) or Log-normal (when it must stay
  positive, like prices, capacities, or risk aversions).
- **"This typical value, bounded above and below"** → Triangular —
  the easiest to reason about: pick min / typical / max.
- **"A fraction or probability"** → Beta. \`α = β = 1\` is uniform on
  \`[0, 1]\`; raising both concentrates around 0.5; raising one above
  the other shifts the mass.
- **"One of these specific values"** → Discrete.

## Worked example: heterogeneous risk aversion

You want the *Household* archetype's \`risk_aversion\` parameter to
spread across a population of 1000 instances, mostly clustered around
0.4 but with a long right tail (a few very risk-averse households).

Pick **Log-normal** with \`μ = log(0.4)\` ≈ \`-0.92\` and
\`σ = 0.3\`. The median is 0.4; about 95% of draws are between ~0.22
and ~0.72; the upper 1% can reach > 1.0.

If instead you wanted a hard cap — *"between 0.1 and 1.0, peak at
0.4"* — use **Triangular** with min=0.1, mode=0.4, max=1.0. Easier
to communicate, gives up the long tail.

## What sampling does NOT do

- Distributions are sampled **once per instance, at world build**.
  They do not redraw every tick. A param is a fixed feature of the
  instance for the whole run.
- Distributions are independent across params — they do not produce
  correlated samples. If two params should correlate, draw one and
  derive the other in \`__init_brain__\`.
- Distributions are independent across archetypes too. There's no
  joint sampling across the population — each instance is drawn on
  its own.

For run-to-run uncertainty (Monte Carlo over seeds), see the Monte
Carlo runner in the Analytics mode — distributions plus a varying
seed give you ensembles.
`,
    },

    'ai-assistant': {
        title: 'AI assistant',
        category: 'ai',
        keywords: ['ai', 'chat', 'assistant', 'claude', 'llm', 'tools'],
        markdown: `# AI assistant

The AI assistant is the collapsible **AI Assistant** box in the right
rail. Click the header to expand it. The assistant is project-aware:
it can read your sectors, archetypes, markets, scenarios, and
dashboards, and it can make changes — adding entities, editing
parameters, rewriting agent loop bodies, even running the world to
test behaviour.

This is the **default** way to use AI in EcoAgent. No external setup.

## Modes

- **Ask** — the assistant explains, plans, suggests. No changes are
  applied without your approval.
- **Edit** — proposed operations are applied to the project as they
  arrive (autosaved like everything else). You can still review and
  un-apply individual operations from the chat history.

## Providers

The model picker (top of the chat panel) supports:

- **Cloud** — Anthropic (Claude), OpenAI, xAI (Grok), Google (Gemini),
  OpenRouter, or any custom OpenAI-compatible endpoint. You provide
  the API key in the Configure Cloud Provider modal; the key is
  stored locally.
- **Local** — Ollama, LM Studio, or a self-hosted llama.cpp server.
  EcoAgent can start a local LLM for you (Manage Server modal).

## What the assistant can do

The assistant has tools covering reads (\`get_project\`,
\`get_sector\`, \`get_archetype\`, \`list_currencies\`,
…) and writes (\`add_sector\`, \`add_currency\` / \`update_currency\`,
\`add_asset_kind\` (with currency tag), \`add_market\` (incl. FX with
\`base_currency\` / \`quote_currency\` rules), \`update_archetype_param\`,
\`set_archetype_loop_body\`, \`upsert_scenario\`,
\`run_world\`, …). It always inspects the project before changing
it.

## Things to try

- *"Add a banks sector with a single bank archetype that has deposits
  on its balance sheet."*
- *"Why is the Households sector's A − L − E non-zero?"*
- *"Run the world for 100 ticks and tell me when something breaks."*
`,
    },

    'ai-external-mcp': {
        title: 'External MCP access (advanced)',
        category: 'ai',
        keywords: ['mcp', 'claude desktop', 'claude code', 'ipc', 'external', 'integration'],
        markdown: `# External MCP access — *optional, advanced*

> **You don't need this for normal use.** The AI assistant in the
> right rail already does everything described here. Read on only if
> you want to drive EcoAgent from **outside** the app — for example,
> from Claude Desktop or Claude Code alongside your other tools.

## Architecture

Two processes:

1. **EcoAgent**, started with \`--ipc-port 24601\` — exposes a small
   HTTP server (the *IPC bridge*) that mirrors the same project
   accessors and operation dispatcher the in-app assistant uses.
2. **MCP server**, run as a separate Python process, with
   \`--ipc-port 24601\` pointing at the same number.

Your external client (Claude Desktop, Claude Code, anything that
speaks MCP) connects to the MCP server, which forwards reads and
writes to the EcoAgent instance via the IPC bridge.

\`\`\`text
┌───────────────┐    MCP    ┌──────────────┐    HTTP    ┌──────────┐
│ Claude        │ ◀──────▶ │ MCP server   │ ◀────────▶ │ EcoAgent │
│ Desktop / CLI │           │ (stdio/http) │  IPC       │ (--ipc-) │
└───────────────┘           └──────────────┘            └──────────┘
\`\`\`

## Start the two processes

\`\`\`bash
# 1) EcoAgent with the IPC port enabled
python app.py --ipc-port 24601

# 2) MCP server, in another shell
python -m ecoagent.ai.mcp_server --transport stdio --ipc-port 24601
\`\`\`

The MCP server speaks **stdio** by default (what Claude Desktop wants)
or **http** / **sse** with \`--transport http --port 3001\`.

## Wire to Claude Desktop

Add the server to Claude Desktop's MCP configuration
(*claude_desktop_config.json*):

\`\`\`json
{
  "mcpServers": {
    "ecoagent": {
      "command": "python",
      "args": ["-m", "ecoagent.ai.mcp_server",
               "--transport", "stdio",
               "--ipc-port", "24601"]
    }
  }
}
\`\`\`

After restarting Claude Desktop, your EcoAgent project is visible
alongside its other tools.

## What's exposed

The same 19 tools the in-app assistant uses, plus:

- \`refresh_project\` — pull the latest snapshot from the running
  EcoAgent (use after you make manual edits in the app).
- \`apply_changes\` — push accumulated proposed operations back to the
  running EcoAgent.

## Caveats

- The MCP server requires the **MCP Python SDK**:
  \`pip install 'mcp[cli]'\`.
- Without \`--ipc-port\` on the EcoAgent side, the MCP server works in
  **standalone** mode — useful for offline experimentation, but it
  can't see or modify a real project.
- The IPC port is HTTP on \`127.0.0.1\` only; treat it like a local
  RPC endpoint, not a public API.
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
     * `_basePath`. EcoAgent ships inline content because the help is
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
