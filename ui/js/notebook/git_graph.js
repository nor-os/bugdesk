/**
 * git_graph.js
 *
 * Compact SVG DAG renderer for the git commit graph.
 * Renders a vertical commit history with swimlane-based branch visualization.
 */

/** 8-color palette for swimlane coloring (VS Code style) */
const LANE_COLORS = [
    '#007acc',  // blue
    '#73c991',  // green
    '#e2b93d',  // amber
    '#cc6633',  // orange
    '#c586c0',  // purple
    '#f14c4c',  // red
    '#4ec9b0',  // teal
    '#569cd6',  // light blue
];

const LANE_WIDTH = 11;
const ROW_HEIGHT = 22;
const CIRCLE_R = 4;
const STROKE_W = 2;
const PAGE_SIZE = 50;

/**
 * @typedef {Object} Commit
 * @property {string} hash
 * @property {string} shortHash
 * @property {string} author
 * @property {string} email
 * @property {number} timestamp
 * @property {string} subject
 * @property {string} refs
 * @property {string[]} parentHashes
 */

/**
 * @typedef {Object} LaneInfo
 * @property {number} lane        - Lane index for this commit
 * @property {number[]} inputLanes  - Lanes of incoming edges (from children above)
 * @property {Array<{lane: number, parentHash: string}>} outputLanes - Outgoing edges to parents below
 */

export class GitGraph {

    get #api() { return window.pywebview?.api; }

    /** @type {HTMLElement} */    #container;
    /** @type {string} */        #projectPath;
    /** @type {Function} */      #onOpenDiff;
    /** @type {Commit[]} */      #commits = [];
    /** @type {LaneInfo[]} */    #laneInfos = [];
    /** @type {number} */        #maxLanes = 0;
    /** @type {boolean} */       #loading = false;
    /** @type {boolean} */       #allLoaded = false;
    /** @type {HTMLElement|null}*/ #contextMenuEl = null;
    /** @type {IntersectionObserver|null} */ #observer = null;

    mount({ container, projectPath, onOpenDiff }) {
        this.#container = container;
        this.#projectPath = projectPath;
        this.#onOpenDiff = onOpenDiff;
        this.#commits = [];
        this.#allLoaded = false;
        this.#container.innerHTML = '';
        this.#loadPage(0);
    }

    dispose() {
        this.#observer?.disconnect();
        this.#observer = null;
        this.#closeContextMenu();
        if (this.#container) this.#container.innerHTML = '';
    }

    refresh() {
        this.#commits = [];
        this.#allLoaded = false;
        if (this.#container) {
            this.#container.innerHTML = '';
            this.#loadPage(0);
        }
    }

    // ─── Data Loading ───────────────────────────────────────────────────

    async #loadPage(skip) {
        if (this.#loading || this.#allLoaded) return;
        this.#loading = true;

        const result = await this.#api?.git_log({
            projectPath: this.#projectPath,
            count: PAGE_SIZE,
            skip,
        });

        this.#loading = false;

        if (!result?.ok) return;

        const newCommits = result.commits || [];
        if (newCommits.length < PAGE_SIZE) {
            this.#allLoaded = true;
        }

        this.#commits.push(...newCommits);
        this.#computeLanes();
        this.#renderAll();
    }

    // ─── Swimlane Algorithm ─────────────────────────────────────────────

    #computeLanes() {
        const commits = this.#commits;
        const laneInfos = [];

        // activeLanes[i] = hash of commit expected in lane i (null = free)
        const activeLanes = [];

        const findLane = (hash) => activeLanes.indexOf(hash);
        const allocLane = () => {
            const free = activeLanes.indexOf(null);
            if (free !== -1) return free;
            activeLanes.push(null);
            return activeLanes.length - 1;
        };

        for (let ci = 0; ci < commits.length; ci++) {
            const commit = commits[ci];
            let lane = findLane(commit.hash);
            if (lane === -1) {
                lane = allocLane();
            }

            // This lane is now consumed
            activeLanes[lane] = null;

            // Compute input lanes (which lanes had edges pointing to this commit)
            // This is implicitly handled — the lane was set by a child commit
            const inputLanes = [];
            // Check all lanes for commits pointing here (multi-parent merge targets)
            for (let l = 0; l < activeLanes.length; l++) {
                if (activeLanes[l] === commit.hash) {
                    inputLanes.push(l);
                    activeLanes[l] = null;
                }
            }
            inputLanes.push(lane); // always include own lane

            // Assign parents to lanes
            const outputLanes = [];
            const parents = commit.parentHashes;
            for (let pi = 0; pi < parents.length; pi++) {
                const parentHash = parents[pi];
                let parentLane = findLane(parentHash);
                if (parentLane === -1) {
                    // First parent takes current lane, rest get new lanes
                    parentLane = pi === 0 ? lane : allocLane();
                }
                activeLanes[parentLane] = parentHash;
                outputLanes.push({ lane: parentLane, parentHash });
            }

            laneInfos.push({ lane, inputLanes: [...new Set(inputLanes)], outputLanes });
        }

        this.#laneInfos = laneInfos;
        this.#maxLanes = activeLanes.length || 1;
    }

    // ─── Rendering ──────────────────────────────────────────────────────

    #renderAll() {
        if (!this.#container) return;
        this.#container.innerHTML = '';

        const svgWidth = Math.max(this.#maxLanes * LANE_WIDTH, LANE_WIDTH * 2);

        for (let i = 0; i < this.#commits.length; i++) {
            const commit = this.#commits[i];
            const li = this.#laneInfos[i];
            const row = this.#createRow(commit, li, svgWidth);
            this.#container.appendChild(row);
        }

        // Sentinel for lazy loading
        if (!this.#allLoaded) {
            const sentinel = document.createElement('div');
            sentinel.style.height = '1px';
            this.#container.appendChild(sentinel);
            this.#observer?.disconnect();
            this.#observer = new IntersectionObserver((entries) => {
                if (entries[0]?.isIntersecting) {
                    this.#observer?.disconnect();
                    this.#loadPage(this.#commits.length);
                }
            }, { root: this.#container });
            this.#observer.observe(sentinel);
        }
    }

    #createRow(commit, laneInfo, svgWidth) {
        const row = document.createElement('div');
        row.className = 'git-graph__row';
        row.title = `${commit.shortHash} — ${commit.author}\n${new Date(commit.timestamp * 1000).toLocaleDateString()}\n\n${commit.subject}`;

        // SVG gutter
        const svg = this.#createSvg(laneInfo, svgWidth);
        row.appendChild(svg);

        // Info
        const info = document.createElement('div');
        info.className = 'git-graph__info';

        // Ref pills
        if (commit.refs) {
            const pills = this.#parseRefs(commit.refs);
            for (const pill of pills) {
                const span = document.createElement('span');
                span.className = `git-ref-pill git-ref-pill--${pill.type}`;
                span.textContent = pill.name;
                span.title = pill.name;
                info.appendChild(span);
            }
        }

        // Subject
        const subject = document.createElement('span');
        subject.className = 'git-graph__subject';
        subject.textContent = commit.subject;
        info.appendChild(subject);

        row.appendChild(info);

        // Context menu
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.#showContextMenu(commit, e.clientX, e.clientY);
        });

        return row;
    }

    #createSvg(laneInfo, width) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'git-graph__svg');
        svg.setAttribute('width', width);
        svg.setAttribute('height', ROW_HEIGHT);
        svg.setAttribute('viewBox', `0 0 ${width} ${ROW_HEIGHT}`);

        const cx = laneInfo.lane * LANE_WIDTH + LANE_WIDTH / 2;
        const cy = ROW_HEIGHT / 2;
        const color = LANE_COLORS[laneInfo.lane % LANE_COLORS.length];

        // Draw output lines (to parents below)
        for (const out of laneInfo.outputLanes) {
            const tx = out.lane * LANE_WIDTH + LANE_WIDTH / 2;
            const lineColor = LANE_COLORS[out.lane % LANE_COLORS.length];
            const path = document.createElementNS(ns, 'path');
            if (tx === cx) {
                path.setAttribute('d', `M${cx},${cy} L${cx},${ROW_HEIGHT}`);
            } else {
                path.setAttribute('d', `M${cx},${cy} C${cx},${ROW_HEIGHT * 0.8} ${tx},${ROW_HEIGHT * 0.6} ${tx},${ROW_HEIGHT}`);
            }
            path.setAttribute('stroke', lineColor);
            path.setAttribute('stroke-width', STROKE_W);
            path.setAttribute('fill', 'none');
            svg.appendChild(path);
        }

        // Draw input lines (from children above)
        for (const inLane of laneInfo.inputLanes) {
            const fx = inLane * LANE_WIDTH + LANE_WIDTH / 2;
            const lineColor = LANE_COLORS[inLane % LANE_COLORS.length];
            if (fx === cx) {
                // Straight line from top
                const path = document.createElementNS(ns, 'path');
                path.setAttribute('d', `M${cx},0 L${cx},${cy}`);
                path.setAttribute('stroke', lineColor);
                path.setAttribute('stroke-width', STROKE_W);
                path.setAttribute('fill', 'none');
                svg.appendChild(path);
            } else {
                // Curve from different lane
                const path = document.createElementNS(ns, 'path');
                path.setAttribute('d', `M${fx},0 C${fx},${ROW_HEIGHT * 0.4} ${cx},${ROW_HEIGHT * 0.2} ${cx},${cy}`);
                path.setAttribute('stroke', lineColor);
                path.setAttribute('stroke-width', STROKE_W);
                path.setAttribute('fill', 'none');
                svg.appendChild(path);
            }
        }

        // Draw commit circle
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', CIRCLE_R);
        circle.setAttribute('fill', '#1e1e1e');
        circle.setAttribute('stroke', color);
        circle.setAttribute('stroke-width', STROKE_W);
        svg.appendChild(circle);

        return svg;
    }

    // ─── Ref Parsing ────────────────────────────────────────────────────

    #parseRefs(refStr) {
        if (!refStr) return [];
        const pills = [];
        const parts = refStr.split(',').map(s => s.trim());
        for (const part of parts) {
            if (part.startsWith('HEAD -> ')) {
                pills.push({ name: part.replace('HEAD -> ', ''), type: 'head' });
            } else if (part.startsWith('tag: ')) {
                pills.push({ name: part.replace('tag: ', ''), type: 'tag' });
            } else if (part === 'HEAD') {
                // skip bare HEAD
            } else if (part.includes('/')) {
                // Remote ref — skip to avoid clutter in 200px
            } else {
                pills.push({ name: part, type: 'branch' });
            }
        }
        return pills;
    }

    // ─── Context Menu ───────────────────────────────────────────────────

    #showContextMenu(commit, x, y) {
        this.#closeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'git-context-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        const items = [
            { label: 'Cherry-pick',         icon: 'content_copy',  action: 'cherry-pick' },
            { label: 'Checkout (detached)', icon: 'logout',        action: 'checkout' },
            { type: 'separator' },
            { label: 'Create Branch…',      icon: 'commit',        action: 'create-branch' },
            { label: 'Create Tag…',         icon: 'sell',          action: 'create-tag' },
            { type: 'separator' },
            { label: 'Copy Commit Hash',    icon: 'content_copy',  action: 'copy-hash' },
            { label: 'View Changes',        icon: 'difference',    action: 'view-changes' },
        ];

        for (const item of items) {
            if (item.type === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'git-context-menu__separator';
                menu.appendChild(sep);
                continue;
            }
            const btn = document.createElement('button');
            btn.className = 'git-context-menu__item';
            btn.innerHTML = `<span class="material-symbols-outlined">${item.icon}</span>${item.label}`;
            btn.addEventListener('click', () => {
                this.#closeContextMenu();
                this.#handleContextAction(item.action, commit);
            });
            menu.appendChild(btn);
        }

        document.body.appendChild(menu);
        this.#contextMenuEl = menu;

        // Clamp to viewport
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

        // Close on outside click / Escape
        const close = (e) => {
            if (!menu.contains(e.target)) {
                this.#closeContextMenu();
                document.removeEventListener('mousedown', close);
                document.removeEventListener('keydown', escClose);
            }
        };
        const escClose = (e) => {
            if (e.key === 'Escape') {
                this.#closeContextMenu();
                document.removeEventListener('mousedown', close);
                document.removeEventListener('keydown', escClose);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', close);
            document.addEventListener('keydown', escClose);
        }, 0);
    }

    #closeContextMenu() {
        if (this.#contextMenuEl) {
            this.#contextMenuEl.remove();
            this.#contextMenuEl = null;
        }
    }

    async #handleContextAction(action, commit) {
        switch (action) {
            case 'cherry-pick':
                await this.#api?.git_cherry_pick({ projectPath: this.#projectPath, hash: commit.hash });
                this.refresh();
                break;
            case 'checkout':
                await this.#api?.git_checkout({ projectPath: this.#projectPath, ref: commit.hash });
                break;
            case 'create-branch': {
                const name = prompt('Branch name:');
                if (name) {
                    await this.#api?.git_create_branch({ projectPath: this.#projectPath, name, from: commit.hash });
                    this.refresh();
                }
                break;
            }
            case 'create-tag': {
                const name = prompt('Tag name:');
                if (name) {
                    await this.#api?.git_tag_create({ projectPath: this.#projectPath, name, hash: commit.hash });
                    this.refresh();
                }
                break;
            }
            case 'copy-hash':
                navigator.clipboard?.writeText(commit.hash);
                break;
            case 'view-changes': {
                const result = await this.#api?.git_diff_commit({ projectPath: this.#projectPath, hash: commit.hash });
                if (result?.ok && result.files?.length > 0) {
                    // Open first changed file's diff
                    this.#onOpenDiff?.(result.files[0].path, result.files[0].status, commit.hash);
                }
                break;
            }
        }
    }
}
