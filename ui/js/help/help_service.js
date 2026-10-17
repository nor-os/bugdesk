/**
 * HelpService - Centralized help content management
 *
 * Loads, caches, and provides access to markdown help content. BugDesk's
 * topics are inline, in HELP_TOPICS below.
 *
 * Features:
 * - Lazy loading of help content
 * - In-memory caching
 * - Markdown-to-HTML rendering
 * - Topic-based organization
 * - Keyword search
 *
 * FlexDesk's HelpModal draws it: see installHelp at the bottom.
 */

import { setHelpProvider } from '@flexdesk/widgets';

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
 * The help categories, in sidebar order. FlexDesk's HelpModal reads them as
 * `{key: {label, icon}}` (see installHelp below).
 */
export const HELP_CATEGORIES = {
    basics: { label: 'Getting started', icon: 'school' },
    records: { label: 'Working with records', icon: 'edit_note' },
    reference: { label: 'Reference', icon: 'menu_book' },
};

/**
 * Registry of BugDesk help topics. Content is inline so the help modal
 * works without a separate /help/*.md tree on disk.
 *
 * Written against the app as it is, not as it was planned: when a page, a
 * key or a Settings section moves, this is one of the places that has to
 * follow (the keyboard topic especially: FlexDesk's keymap in
 * ui/vendor/flexdesk/wm.js, the DataTable's list keys, md_editor.js).
 */
const HELP_TOPICS = {
    'getting-started': {
        title: 'Getting started',
        category: 'basics',
        keywords: ['introduction', 'tutorial', 'beginner', 'first steps', 'overview',
                   'project', 'projects.toml', 'top bar', 'chip', 'page', 'rail', 'panel',
                   'new item', 'search', 'file a bug', 'new bug', 'markdown', 'git'],
        markdown: `# Getting started

BugDesk keeps bugs and feature work as plain markdown files in your
repository: one file per record, a YAML front matter block followed by
a Description, a History and a Comments section. There is no database.
An AI coding agent reads and edits the same files you triage here, and
git keeps the history next to the code the records describe.

Each project has two stores:

| Store | Records | Lives in |
|---|---|---|
| Bugs | \`BUG-NNNN.md\` (types Bug, Regression, Chore) | \`bugs/\` |
| Backlog | \`EPIC-\`, \`STORY-\`, \`TASK-NNNN.md\` (and \`PROJ-\` above epics) | \`backlog/\` |

A project may have only one of the two; the page for the other is then
not offered at all.

## Projects

The projects BugDesk serves are listed in \`projects.toml\` (see
\`BUGDESK_PROJECTS\`); each one opens at \`/p/<name>/\`. The **project
field** in the middle of the top bar shows the one you are in. Click it,
or press **Ctrl/⌘ + P**, to switch: type to narrow the list, **Enter**
to go there, add a project from the last row, remove one with
**Shift + Del**.

## The top bar

The chips in the top bar are the pages of the project, in this order:

| Page | What it is | Key |
|---|---|---|
| **Bugs** | the bug queue, a sortable, filterable table | **F1** |
| **Backlog** | the epic → story → task tree | **F2** |
| **Dashboards** | charts and counts over your records | **F3** |
| **Tracker** | the tracker shared by every project, if one is set up | **F4** |

A missing page moves the later ones up a key. **New Item** opens one
form for any record: its Type decides the store (Bug, Regression or
Chore go to the bugs; Epic, Story or Task to the backlog). The Bugs
page's own **New** button opens the full bug form. **Ctrl/⌘ + K** opens
the command palette: full-text search across both stores (and the
tracker) plus every command.

Settings, Help, "About", your name and the team list are in the menu at
the top left.

## Rails and panels

The **left rail** follows the page in front: the filters on Bugs, the
views and work packages on Backlog, the dashboards on Dashboards. The
**right panel** is the team: who is on what. The **bottom panel** has
two tabs, **Alerts** (what your alert rules flagged) and **Changes**
(what is not committed or pushed yet). The buttons at the top right
show and hide each panel; they are remembered per desktop.

Every page lives in a **tile** you can split, tab, float as a window
or move to another desktop. See **Keyboard shortcuts**.
`,
    },

    'bugs-lifecycle': {
        title: 'Bugs and their lifecycle',
        category: 'basics',
        keywords: ['lifecycle', 'stage', 'status', 'open', 'investigation', 'testing',
                   'closed', 'reopen', 'move', 'transition', 'message', 'action',
                   'workflow', 'custom status', 'duplicate', 'queue', 'resolution', 'wontfix',
                   'link', 'flow'],
        markdown: `# Bugs and their lifecycle

## The four stages

| Status | Usually on | Meaning |
|---|---|---|
| Open | you | filed, and nobody should be on it yet |
| Investigation | the agent | being investigated and fixed |
| Testing | you | fixed; waiting for you to verify |
| Closed | you | verified and done |

\`\`\`
open ──▶ investigation ⇄ testing ──▶ closed
  ▲            (every stage can go back to open;
  └─────────    closed reopens to open)
\`\`\`

A bug's page shows its stage as a chevron strip, with **Action**
buttons for the moves the lifecycle allows from where it is now (from
Testing, for example: "Back to investigation", "Close" or "Back to
open"). **Close** is offered from every stage, so a non-issue or a
wontfix needn't be walked through testing. The same moves are at the
top of a row's right-click menu in the queue and in search results.

## A move comes with its message

Every move except **Start investigation** asks for a message: why it
is closed, what to test, what still fails. The message is saved as a
comment in the same write as the status change, tagged with the move
("Testing → Closed"). If you commented on the bug in the last five
minutes, that comment becomes the message and no dialog opens. A move
saves the bug at once, together with any edits still pending in its
form.

## How it ended: the resolution

**Close** also asks how the bug ended, in the same dialog as the
message: Fixed (the default), Won't fix, Cannot reproduce, Not a bug,
Works as designed or Duplicate. It is saved as the bug's
**Resolution**, shown on its page (where it can be changed) and
offered in the filter editor. A move into a finished status of your own
asks too; **Reopen** clears it. Backlog items are asked when they are
dropped (Won't fix first), not when they are done. A type that hides
Resolution in **Settings › Record types** is not asked.

## Mark as duplicate

**Mark as duplicate and close** picks the bug or item this one
duplicates, links it \`duplicates\`, sets the resolution to Duplicate,
says so in a comment, closes this bug and leaves a comment on the
other record, all in one save. On a backlog item it is **Mark as
duplicate and drop**. Cancelling the picker changes nothing.

## Making it your own

The four stages are the default. In **Settings › Record types** a
project can add statuses of its own (each one active, waiting or
finished), and they show up as "Move to …" moves and as filters. In
**Settings › Workflow** each type's moves can be changed, and a move
can run a flow: ask questions (text, a choice, or a record picked
from either store), set or clear fields (the assignee and the
resolution too), add a comment, add a link, branch. Custom actions,
such as "Blocked", sit beside the moves. Mark as duplicate is one of
every type's actions there, built from those steps, so a project can
rename it, change what it does or remove it. A removed one stays
removed.

## The queue

The **Bugs** page lists the bugs the selected filter matches: Pri,
Bug, Type, Summary, Status, Updated and Assignee, plus any custom field
you pick from the header's right-click menu. Click a row to open it;
right-click one (or several selected rows) for its moves, Open in a new
tab / window / split, Copy bug ID, "Filter by this cell", "Save as
filter…" and **Delete…**. See **Filters** for what the rail offers.
`,
    },

    'backlog': {
        title: 'The backlog',
        category: 'basics',
        keywords: ['backlog', 'epic', 'story', 'task', 'project', 'tree', 'refined',
                   'refinement', 'draft', 'review', 'done', 'dropped', 'points',
                   'acceptance criteria', 'phase', 'work package'],
        markdown: `# The backlog

The backlog is the planned work: **epics**, the **stories** that make
them up, and the **tasks** under a story (and, above epics, optional
**projects**). The Backlog page draws them as a tree; fold a branch
with its arrow. Its rail has the builtin views, your own filters, and
the work packages.

## Statuses

Each type climbs its own ladder:

| Type | Ladder |
|---|---|
| Project | draft → in progress → done |
| Epic | draft → refined → in progress → done |
| Story | draft → refined → in progress → review → done |
| Task | draft → in progress → done |

The moves are **Mark refined**, **Start work**, **Send to review**,
**Mark done**, a "Back to …" for the step before, and **Reopen** from
done. **Drop** is offered from anywhere; a dropped item has only
**Restore to draft**.

**Mark refined** stays disabled while something is missing (acceptance
criteria, an estimate, …); its tooltip and the item's Refinement
section say what. A story's **acceptance criteria** are a checklist you
tick as you go; a task works to its story's criteria.

## Bugs and items

A bug that turns out to be feature work, or a story that is really a
defect, can be **converted** to the other store. The new record keeps
the title, description, reporter, comments and history, plus a comment
listing every value the other store has no field for; the original is
closed (or dropped) and linked to it.
`,
    },

    'tracker': {
        title: 'Tracker and TicketDesk',
        category: 'basics',
        keywords: ['tracker', 'ticketdesk', 'ticket', 'due', 'target date', 'overdue',
                   'late', 'plate', 'assigned', 'reporter', '--tracker'],
        markdown: `# Tracker and TicketDesk

Started with \`--tracker\`, the server is **TicketDesk**: the same app
for tickets, with a name and icon of its own. A ticket has a reporter,
an assignee and a target date (\`due\`, inherited from what it sits
under), and is grouped under projects, epics and stories like the
backlog.

The **Tracker** page leads with what needs chasing: work that is late,
work nobody is on, work with no target date, and each person's plate.
Its builtin views start with **Overdue** and **Due this week**, then In
progress, Nobody on it, No target date, Assigned by me and On me.

When a BugDesk has a tracker configured (\`[tracker]\` in
\`projects.toml\`), it appears as a **Tracker** chip in every project.
The tracker belongs to no project, so the project field reads *n/a*
while it is in front.
`,
    },

    'dashboards': {
        title: 'Dashboards',
        category: 'basics',
        keywords: ['dashboard', 'chart', 'kpi', 'tile', 'bar', 'pie', 'donut',
                   'histogram', 'burndown', 'sum', 'average', 'count', 'personal', 'shared'],
        markdown: `# Dashboards

A dashboard is a grid of chart and KPI tiles over your records. Add,
remove, move and resize tiles, and configure each one:

- **Source**: bugs, backlog items or tracker tickets, one or more types,
  narrowed by a filter (a saved filter is copied into the tile).
- **Count per value** of any field (labels and custom fields included)
  as a bar, pie or donut, optionally split by a second field.
- **Sum** or **average** per value, or a **histogram**, over a number
  field such as points.
- **Created and finished per week** over a date range, or a
  **burndown**.
- **KPI**: a single count, sum or average.

Click a bar or a slice to open the records behind it. Tiles redraw when
records change, here or on disk.

**Shared** dashboards are saved in the project's committed
\`.bugdesk/project.json\`, so a change shows in the Changes panel and
reaches everyone who pulls. **Personal** dashboards are listed under
them and stay with your profile, out of git.
`,
    },

    'records': {
        title: 'Editing records',
        category: 'records',
        keywords: ['mask', 'form', 'field', 'save', 'autosave', 'auto-save', 'cancel',
                   'custom field', 'comment', 'composer', 'markdown', 'history',
                   'link', 'reference', 'autolink', 'delete', 'trash', 'snooze',
                   'mass action', 'select', 'drag', 'drop', 'changes', 'commit', 'push',
                   'live', 'conflict', 'git', 'git init', 'remote', 'backup', 'warning'],
        markdown: `# Editing records

## The form

A record's page is a form: title, type, severity, subsystem, assignee,
labels, links and description for a bug, plus any custom fields the
project defines in **Settings › Record types** (which can also hide the
built-in ones a type doesn't need).

With auto-save off (the default), **Save** and **Cancel** enable once
you have changed a field. Turn on **Auto-save** in **Settings ›
Behaviour** and edits are saved a few seconds after you stop typing;
the form then says Unsaved, Saving… or Saved at hh:mm, and **Save now**
saves at once.

When the file changes on disk (the agent edited it, you pulled), the
page updates by itself. If you have unsaved edits it asks before
overwriting them.

## Comments and history

The **Comments** tab lists comments newest first; each is headed with
its time and author. The composer posts as you: **Enter** posts,
**Shift + Enter** or **Alt + Enter** starts a new line. Its toolbar (and
**Ctrl/⌘ + B / I / K**) does bold, italic and links; paste or drop a
screenshot to attach it. Edit your comment with the pencil in its
header: who wrote it and when stays as it was.

The **History** tab lists every change of status, assignee and reporter,
newest first.

## References and links

Type \`#42\` (a bug) or \`#STORY-7\` (a backlog item) in a description
or a comment and, once you type a space or punctuation after it, it
becomes a link to that record; **Esc** straight after undoes it. The
**Links** field records how records relate (blocks, blocked by,
requires, caused by, duplicates, implements, relates to), across both
stores; the other record shows the inverse.

## Many at once

**Select**, in a list's bar, switches it to ticking rows instead of
opening them (**Space** ticks the highlighted row). A bar then offers
what every ticked record can do: change the assignee, change the status,
or a custom action. A move that needs a message asks once.

**Drag** a row onto any tile to show that record there.
**Ctrl/⌘ + click** a row to open it without leaving the list.

## Deleting

**Delete…** (on the record's page and its right-click menu) is for a
record that should never have been filed. It asks first, and the file
is moved to a trash folder beside the store rather than erased. A bug
that was real is better closed, so the decision stays on record.

## Git

The **Changes** panel lists records not committed yet, with their diffs
(as fields or as text), and lets you commit, push or discard. In
**Settings › Git** a project can commit after every save and push after
every commit.

## Not in git, or no remote

Records are only shared, and only backed up, once they are committed and
pushed. So when BugDesk opens it warns about a store that cannot be:

| Warning | Offers |
|---|---|
| *… is not in a git repository* — the tracker, unless you gave it one | **Initialize git**: \`git init\` in the folder the store sits in |
| *… has no git remote* — commits never leave this computer | **Add remote…**: a URL, added as \`origin\` |

A branch that has a remote but no upstream is not warned about; the
Changes panel says "No remote branch". BugDesk never initializes a
repository or adds a remote unless you press the button — the Changes
panel and Settings › Git offer the same two.

× closes a warning until BugDesk opens again. **Don't warn again** hides
it for that store, for you, until the condition changes: once the store
is fine, or has the other problem, the warning can come back.
`,
    },

    'filters': {
        title: 'Filters',
        category: 'records',
        keywords: ['filter', 'rail', 'queue', 'builtin', 'custom filter', 'view',
                   'filter editor', 'needs my reply', 'active', 'snoozed', 'expression',
                   'save as filter'],
        markdown: `# Filters

The left rail lists the **Filters** (builtin) and **My filters** (your
own), each with a live count.

## Builtin filters on Bugs

| Filter | Matches |
|---|---|
| Needs my reply | the last comment is the agent's, and the bug isn't finished |
| Active *(default)* | not finished and not snoozed |
| All Bugs | everything |
| Open / Investigation / Testing | that status (and one filter per custom status) |
| Snoozed | bugs snoozed until a later date |
| Closed | closed |
| On me | assigned to you |
| On \\<agent\\> | assigned to the agent |

**Snoozed** needs a "Snooze until" field on the bug type; until a
project has one, the filter says how to add it.

## Builtin views on Backlog

Backlog *(default)*, Snoozed, Everything, Needs refinement, Ready to
start, In progress, In review, Epics, On me, On \\<agent\\>, Done.

Builtins can't be changed. Right-click one for **Duplicate as custom
filter** (an editable copy) or **Copy definition**.

## The filter editor

**New filter**, at the bottom of the rail, opens the editor: a name, an
icon, and an expression of conditions in AND / OR groups (each group
can be negated), with a **live preview** of what it matches. Every
field can be used, custom fields included, each with the comparisons
its type supports: is, contains, starts with, one of, all of, is empty,
before / after, in the last N days, greater than, and so on. A filter
that names a field the project has since removed is marked ⚠.

Your own filters can be opened, edited, duplicated, deleted and copied.

## A filter from what you are looking at

Right-click a cell for **"Filter by \\<field\\> '\\<value\\>'"** (opens
it right away) or **"Save as filter…"** (opens the editor with it). The
list's **Save as filter** button seeds a filter from the current filter
plus every column filter box with text in it; with rows selected, it
saves those rows instead. Filters are also what alert rules and
dashboard tiles are built from.
`,
    },

    'people': {
        title: 'You, the agent and the team',
        category: 'records',
        keywords: ['authorship', 'author', 'name', 'human', 'agent', 'assignee',
                   'reporter', 'profile', 'team', 'collaborators', 'user', 'switch user',
                   'BUGDESK_HUMAN', 'BUGDESK_AGENT'],
        markdown: `# You, the agent and the team

BugDesk is built for a person who files, triages and tests, and an
**agent** who investigates and fixes. Every comment says who wrote it,
so the record shows who said what without depending on anyone's
GitHub account.

## Your name

The first time you open BugDesk it asks for your name. That name is
your **profile**: it signs your comments, is the "me" in On me and
Needs my reply, and keeps your own filters, dashboards and settings.
Change it with the user chip at the bottom left, the menu's **Change
your name…**, or **Settings › Profile**. Entering another name switches
to that person's profile.

The agent's name defaults to *\\<your name\\>_agent*, so two people's
agents never sign the same way; set another one in Settings › Profile.

A \`[user] name\` in \`projects.toml\` fixes the name for every project.
Without a profile, the server starts from \`BUGDESK_HUMAN\` and
\`BUGDESK_AGENT\`.

## Assignee and reporter

The **assignee** is explicit: whoever last set it, never derived from
the status, so it is always clear whose court a record is in. The
built-in moves leave it alone (a configured flow can set it). The
**reporter** is who filed the record; the agent hands finished work
back to them.

## The team

**Settings › Team** (or the menu's **Team…**) is the project's
roster, shared in \`.bugdesk/project.json\`: the people work can be
assigned to. The right panel shows who is on what.
`,
    },

    'keyboard-shortcuts': {
        title: 'Keyboard shortcuts',
        category: 'reference',
        keywords: ['hotkeys', 'keys', 'shortcuts', 'f1', 'f2', 'desktops', 'tabs', 'nav',
                   'split', 'tile', 'window', 'pane', 'alt', 'list', 'row', 'enter', 'open',
                   'column', 'select', 'copy', 'palette', 'bold', 'italic'],
        markdown: `# Keyboard shortcuts

The workspace is a tiling window manager: every page lives in a
**tile** you can split, tab, float as a window and move between virtual
desktops. On a Mac, ⌘ works wherever Ctrl is listed with ⌘.

## Pages and navigation

| Action | Key |
|---|---|
| Go to the Nth page in the top bar (Bugs, Backlog, Dashboards, Tracker) | **F1 … F4** |
| Command palette: search every record, run a command | **Ctrl/⌘ + K** |
| Switch project | **Ctrl/⌘ + P** |
| Go back | **Backspace**, or the mouse's back button |
| Open this help / close it | **?** |
| Close the palette, a dialog or the front floating window | **Esc** |

## Tiles and splits

| Action | Key |
|---|---|
| Split the tile horizontally / vertically (new empty pane) | **Alt + H** / **Alt + V** |
| Open the tile's page in a horizontal / vertical split | **Alt + Shift + H** / **Alt + Shift + V** |
| Open the tile's page in a new tab | **Alt + T** |
| Open the tile's page in a new window | **Alt + N** |
| Float the tile as a window, or dock it back | **Alt + F** |
| Close the tile | **Alt + W** |
| Move focus to the tile on that side | **Alt + ← / → / ↑ / ↓** |
| Move the tile that way | **Alt + Shift + ← / → / ↑ / ↓** |
| Next / previous tab in the tile | **Ctrl + Tab** / **Ctrl + Shift + Tab** |
| Next / previous panel tab (Alerts, Changes) | **Shift + → / ←** |

## Desktops

| Action | Key |
|---|---|
| Switch to desktop N | **Alt + 1 … 9** |
| Move the tile to desktop N | **Alt + Shift + 1 … 9** |
| Previous / next desktop | **Ctrl + ← / →** |

## Lists: the bug queue, the backlog, search results

Click a row to focus the list. The open keys then act on the
**highlighted row** rather than on the tile. The list remembers its
highlight, selection, sort, filters and column widths when you come
back to it.

| Action | Key |
|---|---|
| Move the highlight | **↑ / ↓**, **Home / End** |
| Extend the selection | **Shift + ↑ / ↓ / Home / End** |
| Select every row shown | **Ctrl/⌘ + A** |
| Copy the selected rows (tab-separated / CSV) | **Ctrl/⌘ + C** / **Ctrl/⌘ + Shift + C** |
| Open the row in a new tab | **Enter**, or a click |
| Open it without leaving the list (background tab or floating window, see Settings › Behaviour) | **Ctrl/⌘ + Enter**, or **Ctrl/⌘ + click** |
| Open it in a new tab / a floating window | **Alt + T** / **Alt + N** |
| Open it in a tile beside / below this one | **Alt + Shift + H** / **Alt + Shift + V** |
| Tick or untick the row (while **Select** is on) | **Space** |
| Clear the selection; again to stop selecting | **Esc** |
| Size a column to its content | double-click its right edge |

## Writing: descriptions and comments

| Action | Key |
|---|---|
| Bold / italic / link | **Ctrl/⌘ + B** / **I** / **K** |
| Post a comment (or save a comment you are editing) | **Enter** |
| New line in a comment | **Shift + Enter** or **Alt + Enter** |
| Undo the link a reference just became | **Esc**, straight after |
| Stop editing a comment | **Esc** |
| Add a tag; remove the last one | **Enter** or **,**; **Backspace** in the empty box |

## Workflow editor (Settings › Workflow)

| Action | Key |
|---|---|
| Move through the steps; fold / unfold | **↑ / ↓ / ← / →** |
| Rename / duplicate / delete the step | **F2** / **Ctrl/⌘ + D** / **Delete** |
| Copy, cut, paste the step | **Ctrl/⌘ + C / X / V** |
| Undo / redo | **Ctrl/⌘ + Z** / **Ctrl/⌘ + Y** |
| The step's menu | **Shift + F10** |
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
                const inKeywords = topic.keywords.some(kw => kw.toLowerCase().includes(lowerQuery));
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

/**
 * Hand BugDesk's topics to FlexDesk's HelpModal. The modal itself, and the `?`
 * key that toggles it, are FlexDesk's (@flexdesk/widgets); BugDesk only
 * supplies what it shows. There used to be a BugDesk copy of the modal with a
 * `?` listener of its own, and with both installed one key opened two.
 *
 * Called at boot, once the config is in, so the title names the right product.
 */
export function installHelp(name) {
    setHelpProvider(getHelpService(), HELP_CATEGORIES, {
        title: `${name} Help`,
        welcome: 'Pick a topic from the sidebar, or search above. Press ? anywhere to open this again.',
    });
}

export { HelpService, HELP_TOPICS, parseMarkdown };
export default getHelpService;
