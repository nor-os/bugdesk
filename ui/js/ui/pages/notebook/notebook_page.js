/**
 * NotebookPage — top-level page for the notebook IDE.
 *
 * Layout (single pane):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  [toolbar: run/pause/stop | scenario picker | settings] │
 *   ├────────────┬────────────────────────────────────────────┤
 *   │ FileNav    │  [tab bar: open files]                     │
 *   │  - Files   │  ┌─────────────────────────────────────┐   │
 *   │  - Outline │  │  NotebookEditor (active file)       │   │
 *   │            │  └─────────────────────────────────────┘   │
 *   └────────────┴────────────────────────────────────────────┘
 *
 * Layout (split):
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  [toolbar]                                               │
 *   ├────────────┬──────────────────┬──┬──────────────────────┤
 *   │ FileNav    │ [Tab1] [Tab2]   │▐▐│ [Tab3]               │
 *   │            │ Editor (pane 1) │▐▐│ Editor (pane 2)      │
 *   └────────────┴──────────────────┴──┴──────────────────────┘
 *
 * Thin orchestrator — delegates to:
 *   - ProjectModel                      — file I/O
 *   - FileNavigator                     — left nav
 *   - EditorPane (×1-2)                 — tab bar + editor per pane
 *   - SplitPaneContainer                — divider + flex layout
 *   - NotebookSimulationController      — compile → run → result routing
 *   - NotebookSymbolIndex               — outline symbol extraction
 */

import { PageBase } from '../../base/page_base.js';
import { getSetting, setSetting } from '../../../core/settings.js';
import { ProjectModel } from '../../../data/project_model.js';
import { FileNavigator } from '../../../notebook/file_navigator.js';
import { EditorPane } from '../../../notebook/editor_pane.js';
import { SplitPaneContainer } from '../../../notebook/split_pane_container.js';
import { NotebookEditor } from '../../../notebook/notebook_editor.js';
import { NotebookSymbolIndex } from '../../../notebook/notebook_symbol_index.js';
import { registerEcoLang, refreshEcoLangDiagnostics } from '../../../notebook/ecolang_monaco.js';
import { initMonaco, monacoReady } from '../../../notebook/monaco_loader.js';
import { getEditorFactory } from '../../../notebook/monaco_editor_factory.js';
import { NotebookSimulationController } from './notebook_simulation_controller.js';
import { showDeleteConfirmDialog, showChoiceDialog } from '../../components/confirm_dialog.js';
import { TestFileEditor } from '../../../notebook/test_file_editor.js';
import { ScenarioFileEditor } from '../../../notebook/scenario_file_editor.js';
import { ModuleFileEditor } from '../../../notebook/module_file_editor.js';
import { createDetailHeader } from '../../components/detail_header.js';
import { NotebookValidation } from '../../../notebook/notebook_validation.js';
import { NotebookValidationIndicator } from '../../../notebook/notebook_validation_indicator.js';
import { SlideOutPanel } from '../../components/slide_out_panel.js';

/**
 * Per-pane editor state. Each EditorPane can have at most one editor mounted.
 * @typedef {{
 *   editor: NotebookEditor|null,
 *   plainEditorHandle: object|null,
 *   testEditor: TestFileEditor|null,
 *   scenarioEditor: ScenarioFileEditor|null,
 *   moduleEditor: ModuleFileEditor|null,
 * }} PaneEditorState
 */

export class NotebookPage extends PageBase {
    /** @type {ProjectModel} */
    #project = null;

    /** @type {FileNavigator} */
    #fileNav = null;

    // ─── Split pane system ───────────────────────────────────────────────────

    /** @type {SplitPaneContainer} */
    #splitContainer = null;

    /** @type {EditorPane} Left pane (always exists) */
    #leftPane = null;

    /** @type {EditorPane|null} Right pane (exists when split) */
    #rightPane = null;

    /** @type {string} 'left' or 'right' — which pane is focused */
    #focusedPaneId = 'left';

    /** @type {Map<string, PaneEditorState>} paneId → editor state */
    #paneEditors = new Map();

    // ─── Shared state ────────────────────────────────────────────────────────

    /** @type {HTMLElement} */
    #toolbarEl = null;

    /** @type {HTMLElement|null} Shell-provided sidebar container for FileNavigator. */
    #fileNavContainer = null;

    /** @type {HTMLElement} wrapper that holds SplitPaneContainer */
    #splitWrapper = null;

    /** @type {NotebookSimulationController} */
    #simController = null;

    /** @type {Array<{etlKey:string, label:string, category:string}>|null} Cached overlay sources. */
    #overlaySources = null;

    /** @type {NotebookSymbolIndex} */
    #symbolIndex = null;

    /** Expose symbol index for analysis tools (steady state, bifurcation, impulse response). */
    get symbolIndex() { return this.#symbolIndex; }

    /** Expose project model for analysis tools. */
    get project() { return this.#project; }

    /**
     * Compile notebook DSL and sync to backend (without running simulation).
     * Used by analysis tools that need the model state synced.
     * @returns {Promise<{ok: boolean, dsl?: string, error?: string}>}
     */
    async syncDslToBackend() {
        if (!this.#project?.isOpen) {
            return { ok: false, error: 'No project open' };
        }

        // Flush ALL open editors to ProjectModel so DSL compilation uses current state
        this.#flushAllEditors();
        await this.#flushAndSaveActive();

        // Open all namespace files
        const namespacePaths = this.#project.namespacePaths;
        const namespaceCells = [];
        for (const nsPath of namespacePaths) {
            if (!this.#project.getOpenFile(nsPath)) {
                await this.#project.openFile(nsPath);
            }
            const nsFile = this.#project.getOpenFile(nsPath);
            const cells = nsFile?.content?.cells ?? [];
            const nsName = nsPath.replace('.namespace', '').split('/').pop();
            namespaceCells.push({ namespace: nsName, fileName: nsPath, cells });
        }

        // Open all module files
        const modulePaths = this.#project.modulePaths ?? [];
        const moduleSources = [];
        for (const modPath of modulePaths) {
            if (!this.#project.getOpenFile(modPath)) {
                await this.#project.openFile(modPath);
            }
            const modFile = this.#project.getOpenFile(modPath);
            if (modFile?.content) {
                moduleSources.push({ fileName: modPath, source: modFile.content });
            }
        }

        // Use default scenario for time/solver settings
        const manifest = this.#project.getOpenFile('project.ecosim')?.content;
        const defaultPath = manifest?.settings?.defaultScenario;
        const files = this.#project.files ?? [];
        const scenarios = files.filter(f => f.type === 'scenario');
        const scenarioPath = (defaultPath && scenarios.some(f => f.path === defaultPath))
            ? defaultPath
            : scenarios[0]?.path ?? null;

        let scenarioContent = {};
        if (scenarioPath) {
            if (!this.#project.getOpenFile(scenarioPath)) {
                await this.#project.openFile(scenarioPath);
            }
            scenarioContent = this.#project.getOpenFile(scenarioPath)?.content ?? {};
        }

        const { notebookDslCompiler } = await import('../../../notebook/notebook_dsl_compiler.js');
        const { dsl, solver, time } = notebookDslCompiler.compile({
            namespaceCells,
            scenarioData: scenarioContent,
            moduleSources,
        });

        if (!dsl.trim()) {
            return { ok: false, error: 'Model has no DSL content' };
        }

        const api = window.pywebview?.api;
        if (!api) {
            return { ok: false, error: 'Backend not available' };
        }

        const result = await api.sim_sync_graph_state({
            dsl,
            time: { t0: time.t0, t1: time.t1, dt: time.dt },
            solver: { method: solver.method, rtol: solver.rtol, atol: solver.atol },
        });

        if (!result?.ok) {
            return { ok: false, error: result?.error || 'Failed to sync graph state' };
        }

        return { ok: true, dsl };
    }

    /**
     * Sync the top bar solver/time inputs from the given scenario file.
     * @param {string} scenarioPath
     */
    async #syncTopBarFromScenario(scenarioPath) {
        if (!scenarioPath) return;
        if (!this.#project.getOpenFile(scenarioPath)) {
            await this.#project.openFile(scenarioPath);
        }
        const file = this.#project.getOpenFile(scenarioPath);
        if (!file?.content) return;

        const time = file.content.time ?? {};
        const solver = file.content.solver ?? {};

        const t0Input = document.getElementById('sim-t0-top');
        const t1Input = document.getElementById('sim-t1-top');
        const dtInput = document.getElementById('sim-dt-top');
        const solverSelect = document.getElementById('sim-solver-method-top');

        if (t0Input && Number.isFinite(time.t0)) t0Input.value = time.t0;
        if (t1Input && Number.isFinite(time.t1)) t1Input.value = time.t1;
        if (dtInput && Number.isFinite(time.dt)) dtInput.value = time.dt;
        const method = solver.method ?? null;
        if (solverSelect && method) solverSelect.value = method;
    }

    /**
     * Resolve the default scenario path from the project manifest.
     * @returns {string|null}
     */
    #resolveDefaultScenarioPath() {
        const manifest = this.#project.getOpenFile('project.ecosim')?.content;
        const defaultPath = manifest?.settings?.defaultScenario;
        const files = this.#project.files ?? [];
        const scenarios = files.filter(f => f.type === 'scenario');
        if (defaultPath && scenarios.some(f => f.path === defaultPath)) return defaultPath;
        return scenarios[0]?.path ?? null;
    }

    /** @type {NotebookValidation} */
    #validation = null;

    /** @type {NotebookValidationIndicator} */
    #validationIndicator = null;

    /** @type {Function[]} */
    #disposers = [];

    constructor(deps) {
        super(deps);
        this.#project = deps.project ?? new ProjectModel({
            eventBus: deps.eventBus,
            logger: deps.logger,
        });
    }

    // ─── PageBase lifecycle ───────────────────────────────────────────────────

    mount(container, { fileNavContainer } = {}) {
        this.container = container;
        this.#fileNavContainer = fileNavContainer ?? null;
        this._mounted = true;
        this._initPromise = this.#init();
    }

    async show() {
        if (!this.#project.isOpen) {
            await this.#project.restoreLastProject();
        }
        if (!this.#project.isOpen) {
            this.#showEmptyState();
        } else if (!this.#symbolIndex?.symbols?.length) {
            // Project was opened before this page was mounted (e.g. app started
            // on simulation-run page).  Run the same init that onOpened would do.
            await this.#hydrateForOpenProject();
        }
        this.#emitBreadcrumb(this.#getActiveFilePath());
    }

    dispose() {
        for (const d of this.#disposers) d?.();
        this.#disposers = [];
        this.#simController?.dispose();
        this.#symbolIndex?.dispose();
        this.#validation?.dispose();
        this.#validationIndicator?.dispose();
        this.#disposeAllPaneEditors();
        this.#leftPane?.dispose();
        this.#rightPane?.dispose();
        this.#splitContainer?.dispose();
        this.#fileNav?.dispose();
        this.#closeAddDropdown();
        // Clear toolbar content from shell slot (the slot element persists)
        if (this.#toolbarEl?.id === 'notebook-toolbar-slot') {
            this.#toolbarEl.innerHTML = '';
        }
        this._mounted = false;
    }

    // ─── Initialisation ───────────────────────────────────────────────────────

    async #init() {
        this.#buildLayout();
        this.#initControllers();
        this.#subscribeProjectEvents();

        const onWidthModeChanged = ({ value }) => {
            this.#forEachPaneContainer(el => { el.dataset.cellWidthMode = value; });
        };
        const onCodeMaxHeightChanged = ({ value }) => {
            this.#forEachPaneContainer(el => { el.dataset.codeMaxHeight = String(!!value); });
        };
        const onParamMaxHeightChanged = ({ value }) => {
            this.#forEachPaneContainer(el => { el.dataset.paramMaxHeight = String(!!value); });
        };
        const h1 = this.eventBus?.on('settings:notebook.cellWidthMode:changed', onWidthModeChanged);
        const h2 = this.eventBus?.on('settings:notebook.codeCellMaxHeight:changed', onCodeMaxHeightChanged);
        const h3 = this.eventBus?.on('settings:notebook.paramCellMaxHeight:changed', onParamMaxHeightChanged);
        if (h1) this.#disposers.push(() => h1.dispose?.());
        if (h2) this.#disposers.push(() => h2.dispose?.());
        if (h3) this.#disposers.push(() => h3.dispose?.());

        // Keyboard shortcut: Ctrl+\ to split/unsplit
        const kbd = (e) => {
            if (e.ctrlKey && e.key === '\\') {
                e.preventDefault();
                this.#toggleSplit();
            }
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                this.#onToolbarAction(e.shiftKey ? 'save-all' : 'save');
            }
        };
        document.addEventListener('keydown', kbd);
        this.#disposers.push(() => document.removeEventListener('keydown', kbd));

        // Load Monaco in background
        initMonaco('vendor/monaco');
        const monaco = await monacoReady;
        registerEcoLang(monaco, {
            symbolProvider: () => this.#symbolIndex?.symbols ?? [],
        });

        // Pre-warm the editor factory so it's ready when the first file opens
        getEditorFactory();
    }

    #initControllers() {
        // Simulation controller — compile + run + result routing + toolbar state
        this.#simController = new NotebookSimulationController({
            eventBus: this.eventBus,
            logger: this.logger,
        });
        this.#simController.initialize({
            project: this.#project,
            toolbarEl: this.#toolbarEl,
            notificationCenter: this.notificationCenter,
            page: {
                getEditor:          () => this.#getActiveEditor(),
                getScenarioEditor:  () => this.#getActiveScenarioEditor(),
                getAllEditors:      () => this.#getAllEditors(),
                getActiveFilePath:  () => this.#getActiveFilePath(),
                activateTab:        (path) => this.#activateTab(this.#focusedPaneId, path),
                flushAndSaveActive: () => this.#flushAndSaveActive(),
                flushAllEditors:    () => this.#flushAllEditors(),
            },
        });

        // Symbol index — outline extraction with debounced rebuild
        this.#symbolIndex = new NotebookSymbolIndex({
            onChange: (symbols) => {
                this.#fileNav.setOutlineSymbols(symbols);
                // Update all pane editors that support symbol index
                for (const state of this.#paneEditors.values()) {
                    state.scenarioEditor?.setSymbolIndex(this.#symbolIndex);
                    state.editor?.setSymbolIndex(this.#symbolIndex);
                }
                // Re-run Monaco linter with the new symbol table
                refreshEcoLangDiagnostics();
                // Live validation — debounced so it doesn't fire on every keystroke
                this.#validation?.validateDebounced();
            },
        });

        // Validation indicator — mounts into toolbar
        this.#validationIndicator = new NotebookValidationIndicator({
            eventBus: this.eventBus,
        });
    }

    // ─── Layout ──────────────────────────────────────────────────────────────

    #buildLayout() {
        this.container.innerHTML = '';
        this.container.classList.add('notebook-page');

        // Toolbar renders into the shell's top-bar notebook slot (falls back to inline)
        const shellSlot = document.getElementById('notebook-toolbar-slot');
        this.#toolbarEl = shellSlot ?? document.createElement('div');
        this.#toolbarEl.className = 'notebook-toolbar';
        this.#buildToolbar();
        if (!shellSlot) this.container.appendChild(this.#toolbarEl);

        // Split container wrapper (fills remaining vertical space)
        this.#splitWrapper = document.createElement('div');
        this.#splitWrapper.className = 'notebook-split-wrapper';
        this.container.appendChild(this.#splitWrapper);

        // SplitPaneContainer
        this.#splitContainer = new SplitPaneContainer({
            onRatioChanged: () => this.#persistSplitState(),
        });
        this.#splitContainer.mount(this.#splitWrapper);

        // Create left pane (always present)
        this.#leftPane = this.#createPane('left');
        this.#paneEditors.set('left', this.#emptyEditorState());
        this.#splitContainer.setPanes(this.#leftPane.element);
        this.#leftPane.setFocused(true);

        // File navigator mounts into the shell's fixed-200 sidebar slot
        const navContainer = this.#fileNavContainer ?? (() => {
            const el = document.createElement('div');
            el.className = 'notebook-nav';
            this.container.prepend(el);
            return el;
        })();
        navContainer.innerHTML = '';

        this.#fileNav = new FileNavigator({
            eventBus: this.eventBus,
            logger: this.logger,
        });
        this.#fileNav.mount(navContainer, {
            project: this.#project,
            onOpenFile: (path) => this.#openFile(path, { preview: true }),
            onPinFile: (path) => this.#openFile(path, { preview: false }),
            onNewFile: (fileType, suggestedPath) => this.#newFile(fileType, suggestedPath),
            onRenameFile: (oldPath, newPath) => this.#renameFile(oldPath, newPath),
            onDeleteFile: (path) => this.#deleteFile(path),
            onDuplicateFile: (path) => this.#duplicateFile(path),
            onRevealInExplorer: (path) => this.#project.revealInExplorer(path),
            onOpenBuiltinModule: (bm) => this.#openBuiltinModule(bm),
            onImportModule: () => this.#importModule(),
            onOpenDiff: (filePath, status, ref) => this.#openDiffFile(filePath, status, ref),
        });

        // Apply settings to pane containers
        this.#applySettingsToPane(this.#leftPane);

        // Empty state
        this.#showEmptyState();
    }

    /** Create an EditorPane with all callbacks wired. */
    #createPane(id) {
        const pane = new EditorPane(id, {
            onActivate:        (pId, path) => this.#activateTab(pId, path, { pin: true }),
            onClose:           (pId, path) => this.#closeTab(pId, path),
            onCloseOthers:     (pId, path) => this.#closeOtherTabs(pId, path),
            onCloseToRight:    (pId, path) => this.#closeTabsToRight(pId, path),
            onCloseAll:        (pId)       => this.#closeAllTabs(pId),
            onCloseSaved:      (pId)       => this.#closeSavedTabs(pId),
            onRename:          (oldP, newP) => this.#renameFile(oldP, newP),
            onDuplicate:       (path)       => this.#duplicateFile(path),
            onReorder:         (pId, paths) => this.#reorderPaneTabs(pId, paths),
            onRevealInExplorer:(path)       => this.#project.revealInExplorer(path),
            onFocus:           (pId)        => this.#setFocusedPane(pId),
            onSplitRight:      (pId, path)  => this.#splitRight(pId, path),
            onMoveToOtherPane: (pId, path)  => this.#moveToOtherPane(pId, path),
            onDropFromOtherPane: (targetPaneId, path) => this.#handleCrossPaneDrop(targetPaneId, path),
        });
        pane.mount();
        return pane;
    }

    #emptyEditorState() {
        return {
            editor: null,
            plainEditorHandle: null,
            testEditor: null,
            scenarioEditor: null,
            moduleEditor: null,
            diffEditorHandle: null,
            slideOutPanel: null,
        };
    }

    #applySettingsToPane(pane) {
        const el = pane.editorContainer;
        if (!el) return;
        el.dataset.cellWidthMode = getSetting('notebook.cellWidthMode', 'fixed');
        el.dataset.codeMaxHeight = String(!!getSetting('notebook.codeCellMaxHeight', false));
        el.dataset.paramMaxHeight = String(!!getSetting('notebook.paramCellMaxHeight', false));
    }

    // ─── Pane helpers ────────────────────────────────────────────────────────

    /** Get the pane by id. */
    #getPane(paneId) {
        return paneId === 'left' ? this.#leftPane : this.#rightPane;
    }

    /** Get the focused pane. */
    #getFocusedPane() {
        return this.#getPane(this.#focusedPaneId);
    }

    /** Get the other pane id. */
    #otherPaneId(paneId) {
        return paneId === 'left' ? 'right' : 'left';
    }

    /** Find which pane owns a file, or null. */
    #findPaneForFile(filePath) {
        if (this.#leftPane?.hasFile(filePath)) return 'left';
        if (this.#rightPane?.hasFile(filePath)) return 'right';
        return null;
    }

    /** Get active file path of the focused pane. */
    #getActiveFilePath() {
        return this.#getFocusedPane()?.activeFilePath ?? null;
    }

    /** Get the NotebookEditor of the focused pane. */
    #getActiveEditor() {
        const state = this.#paneEditors.get(this.#focusedPaneId);
        return state?.editor ?? null;
    }

    /** Return the active pane's scenario editor (if a scenario file is open). */
    #getActiveScenarioEditor() {
        const state = this.#paneEditors.get(this.#focusedPaneId);
        return state?.scenarioEditor ?? null;
    }

    /** Return all currently mounted namespace editors across all panes. */
    #getAllEditors() {
        const editors = [];
        for (const state of this.#paneEditors.values()) {
            if (state?.editor) editors.push(state.editor);
        }
        return editors;
    }

    /**
     * Ensure a file is open and return its NotebookEditor (namespace files only).
     * Opens the file if not already open, then returns the editor from the pane.
     * @param {string} filePath
     * @returns {Promise<NotebookEditor|null>}
     */
    async #ensureEditorForFile(filePath) {
        // Open the file if not already open
        let paneId = this.#findPaneForFile(filePath);
        if (!paneId) {
            await this.#openFile(filePath, { preview: false });
            paneId = this.#findPaneForFile(filePath);
        }
        if (!paneId) return null;

        // Activate the tab to ensure the editor is mounted
        const pane = this.#getPane(paneId);
        if (pane?.activeFilePath !== filePath) {
            await this.#activateTab(paneId, filePath);
        }

        const state = this.#paneEditors.get(paneId);
        return state?.editor ?? null;
    }

    /** Apply a function to each pane's editor container. */
    #forEachPaneContainer(fn) {
        if (this.#leftPane?.editorContainer) fn(this.#leftPane.editorContainer);
        if (this.#rightPane?.editorContainer) fn(this.#rightPane.editorContainer);
    }

    #setFocusedPane(paneId) {
        if (this.#focusedPaneId === paneId) return;
        this.#focusedPaneId = paneId;
        this.#leftPane?.setFocused(paneId === 'left');
        this.#rightPane?.setFocused(paneId === 'right');

        // Update toolbar and file nav for the newly focused pane
        const pane = this.#getPane(paneId);
        if (pane?.activeFilePath) {
            this.#fileNav.setActiveFile(pane.activeFilePath);
            this.#updateToolbarForFile(pane.activeFilePath);
        }
        this.#persistSplitState();
    }

    // ─── Split operations ────────────────────────────────────────────────────

    /** Split: move a file from its pane to a new right pane. */
    #splitRight(sourcePaneId, filePath) {
        if (this.#rightPane) {
            // Already split — just move the tab to the right pane
            this.#moveToOtherPane(sourcePaneId, filePath);
            return;
        }

        // Create right pane
        this.#rightPane = this.#createPane('right');
        this.#paneEditors.set('right', this.#emptyEditorState());
        this.#applySettingsToPane(this.#rightPane);

        // Move the file from source pane to right pane
        const sourcePane = this.#getPane(sourcePaneId);
        sourcePane.removeFile(filePath);

        // If the moved file was active in the source, switch to another
        if (sourcePane.activeFilePath === null && sourcePane.filePaths.length > 0) {
            // removeFile already updated activeFilePath
        }

        this.#rightPane.addFile(filePath);
        this.#rightPane.setActiveFile(filePath);

        // Show split layout
        this.#splitContainer.setPanes(this.#leftPane.element, this.#rightPane.element);

        // Restore persisted ratio if available
        const saved = this.#loadSplitState();
        if (saved?.ratio) this.#splitContainer.setRatio(saved.ratio);

        // Focus the new pane
        this.#setFocusedPane('right');

        // Re-mount editors for both panes
        this.#syncPaneTabBar('left');
        this.#syncPaneTabBar('right');
        this.#mountEditorForPane('left');
        this.#mountEditorForPane('right');
        this.#updateToolbarForFile(filePath);

        this.#persistSplitState();
    }

    /** Move a file from one pane to the other. */
    #moveToOtherPane(sourcePaneId, filePath) {
        const targetPaneId = this.#otherPaneId(sourcePaneId);
        const targetPane = this.#getPane(targetPaneId);

        if (!targetPane) {
            // No other pane exists — split right instead
            this.#splitRight(sourcePaneId, filePath);
            return;
        }

        const sourcePane = this.#getPane(sourcePaneId);

        // Flush current editor if this file is active in the source pane
        if (sourcePane.activeFilePath === filePath) {
            this.#flushEditorToProject(sourcePaneId, filePath);
        }

        sourcePane.removeFile(filePath);
        targetPane.addFile(filePath);
        targetPane.setActiveFile(filePath);

        // If source pane is now empty, collapse the split
        if (sourcePane.isEmpty) {
            this.#collapsePaneInto(sourcePaneId, targetPaneId);
        } else {
            this.#syncPaneTabBar(sourcePaneId);
            this.#mountEditorForPane(sourcePaneId);
        }

        this.#setFocusedPane(targetPaneId);
        this.#syncPaneTabBar(targetPaneId);
        this.#mountEditorForPane(targetPaneId);
        this.#persistSplitState();
    }

    /** Handle a tab dragged from one pane and dropped onto another. */
    #handleCrossPaneDrop(targetPaneId, filePath) {
        // Find which pane currently owns this file
        const sourcePaneId = this.#findPaneForFile(filePath);
        if (!sourcePaneId || sourcePaneId === targetPaneId) return;
        this.#moveToOtherPane(sourcePaneId, filePath);
    }

    /** Toggle split on/off using the focused pane's active file. */
    #toggleSplit() {
        if (this.#rightPane) {
            // Unsplit: merge right pane into left
            this.#collapsePaneInto('right', 'left');
        } else {
            // Split: move active file to new right pane
            const pane = this.#getFocusedPane();
            if (pane && pane.activeFilePath && pane.filePaths.length > 1) {
                this.#splitRight(pane.id, pane.activeFilePath);
            }
        }
    }

    /** Collapse a pane, moving its files into the survivor. */
    #collapsePaneInto(removedPaneId, survivorPaneId) {
        const removedPane = this.#getPane(removedPaneId);
        const survivorPane = this.#getPane(survivorPaneId);

        if (!removedPane || !survivorPane) return;

        // Flush the removed pane's active editor
        if (removedPane.activeFilePath) {
            this.#flushEditorToProject(removedPaneId, removedPane.activeFilePath);
        }

        // Move files from removed pane to survivor
        for (const fp of removedPane.filePaths) {
            if (!survivorPane.hasFile(fp)) survivorPane.addFile(fp);
        }

        // Dispose removed pane
        this.#disposePaneEditors(removedPaneId);
        removedPane.dispose();

        if (removedPaneId === 'right') {
            this.#rightPane = null;
        } else {
            // Left was removed, right becomes left
            this.#leftPane = survivorPane;
            this.#rightPane = null;
        }
        this.#paneEditors.delete(removedPaneId);

        // Ensure left pane editor state entry exists
        if (!this.#paneEditors.has('left')) {
            // Survivor was 'right', now promoted to 'left'
            const rightState = this.#paneEditors.get('right');
            if (rightState) {
                this.#paneEditors.set('left', rightState);
                this.#paneEditors.delete('right');
            } else {
                this.#paneEditors.set('left', this.#emptyEditorState());
            }
            this.#leftPane = survivorPane;
        }

        this.#splitContainer.setPanes(this.#leftPane.element);
        this.#focusedPaneId = 'left';
        this.#leftPane.setFocused(true);

        this.#syncPaneTabBar('left');
        this.#mountEditorForPane('left');
        this.#persistSplitState();
    }

    // ─── Toolbar ─────────────────────────────────────────────────────────────

    #buildToolbar() {
        this.#toolbarEl.innerHTML = `
            <div class="nb-view-actions">
                <div class="fn-add-group">
                    <button type="button" class="nb-toolbar-btn fn-add-trigger" data-action="add-new" title="Create new\u2026">
                        <span class="material-symbols-outlined">add</span>
                    </button>
                    <div class="fn-add-menu" role="menu" hidden>
                        <button type="button" class="fn-add-option" data-create-type="namespace">
                            <span class="material-symbols-outlined">dataset</span>
                            <div class="option-text">
                                <span class="option-title">New Namespace</span>
                                <span class="option-desc">Model equations and variables</span>
                            </div>
                        </button>
                        <button type="button" class="fn-add-option" data-create-type="module">
                            <span class="material-symbols-outlined">extension</span>
                            <div class="option-text">
                                <span class="option-title">New Module</span>
                                <span class="option-desc">Reusable equation module (.edf)</span>
                            </div>
                        </button>
                        <button type="button" class="fn-add-option" data-create-type="import-module">
                            <span class="material-symbols-outlined">upload_file</span>
                            <div class="option-text">
                                <span class="option-title">Import Module</span>
                                <span class="option-desc">Import module from file</span>
                            </div>
                        </button>
                        <div class="fn-add-menu__separator"></div>
                        <button type="button" class="fn-add-option" data-create-type="test">
                            <span class="material-symbols-outlined">fact_check</span>
                            <div class="option-text">
                                <span class="option-title">New Test</span>
                                <span class="option-desc">Regression test suite</span>
                            </div>
                        </button>
                    </div>
                </div>
                <button class="nb-toolbar-btn" data-action="reveal-folder" title="Open project folder">
                    <span class="material-symbols-outlined">folder_copy</span>
                </button>
                <span class="nb-toolbar-divider"></span>
                <button class="nb-toolbar-btn" data-action="toggle-width" title="Toggle cell width (fixed / full)" disabled>
                    <span class="material-symbols-outlined">${getSetting('notebook.cellWidthMode', 'fixed') === 'full' ? 'width_full' : 'width_normal'}</span>
                </button>
                <button class="nb-toolbar-btn" data-action="toggle-view" title="Switch all cells: Config / EcoLang" disabled>
                    <span class="material-symbols-outlined">visibility</span>
                    <span class="nb-view-label">Config</span>
                </button>
                <span class="nb-toolbar-divider"></span>
                <span id="nb-validation-slot"></span>
            </div>
        `;

        // Mount validation indicator into slot
        const validationSlot = this.#toolbarEl.querySelector('#nb-validation-slot');
        if (validationSlot && this.#validationIndicator) {
            this.#validationIndicator.mount(validationSlot);
        }

        this.#toolbarEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            this.#onToolbarAction(btn.dataset.action);
        });

        // Wire the (+) add-new dropdown
        this.#wireAddNewDropdown();
    }

    // ─── Add-new dropdown ──────────────────────────────────────────────────

    #addDropdownVisible = false;
    #addTriggerEl = null;
    #addMenuEl = null;

    #wireAddNewDropdown() {
        this.#addTriggerEl = this.#toolbarEl.querySelector('[data-action="add-new"]');
        this.#addMenuEl = this.#toolbarEl.querySelector('.fn-add-menu');

        this.#addTriggerEl?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.#addDropdownVisible) this.#closeAddDropdown();
            else this.#openAddDropdown();
        });

        this.#addMenuEl?.addEventListener('click', (e) => {
            const option = e.target.closest('.fn-add-option');
            if (!option) return;
            e.stopPropagation();
            this.#closeAddDropdown();
            this.#onAddNewAction(option.dataset.createType);
        });
    }

    #openAddDropdown() {
        if (!this.#addTriggerEl || !this.#addMenuEl) return;
        this.#addDropdownVisible = true;
        this.#addMenuEl.removeAttribute('hidden');
        requestAnimationFrame(() => this.#addMenuEl.classList.add('visible'));
        this.#addTriggerEl.classList.add('is-active');

        // Position below trigger, right-aligned (drops left)
        const rect = this.#addTriggerEl.getBoundingClientRect();
        this.#addMenuEl.style.top = `${rect.bottom + 6}px`;
        this.#addMenuEl.style.left = '';
        this.#addMenuEl.style.right = `${window.innerWidth - rect.right}px`;

        setTimeout(() => {
            document.addEventListener('click', this.#boundCloseAddDropdown, true);
            document.addEventListener('keydown', this.#boundAddDropdownKeydown, true);
        }, 0);
    }

    #closeAddDropdown() {
        if (!this.#addMenuEl) return;
        this.#addDropdownVisible = false;
        this.#addMenuEl.classList.remove('visible');
        this.#addMenuEl.setAttribute('hidden', '');
        this.#addTriggerEl?.classList.remove('is-active');
        document.removeEventListener('click', this.#boundCloseAddDropdown, true);
        document.removeEventListener('keydown', this.#boundAddDropdownKeydown, true);
    }

    #boundCloseAddDropdown = (e) => {
        if (!this.#addDropdownVisible) return;
        if (this.#addMenuEl?.contains(e.target) || this.#addTriggerEl?.contains(e.target)) return;
        this.#closeAddDropdown();
    };

    #boundAddDropdownKeydown = (e) => {
        if (e.key === 'Escape') {
            this.#closeAddDropdown();
            this.#addTriggerEl?.focus();
        }
    };

    #onAddNewAction(type) {
        if (!this.#project.isOpen) return;
        switch (type) {
            case 'namespace':
                this.#newFile('namespace', 'untitled.namespace');
                break;
            case 'module':
                this.#newFile('module', 'modules/untitled.edf');
                break;
            case 'import-module':
                this.#importModule();
                break;
            case 'test':
                this.#newFile('test', 'tests/untitled.test');
                break;
        }
    }

    // ─── Toolbar actions ─────────────────────────────────────────────────────

    async #onToolbarAction(action) {
        switch (action) {
            case 'new-project':   await this.#project.create(); break;
            case 'open-project':  await this.#project.open(); break;
            case 'open-demo':     await this.#project.openDemo('world3'); break;
            case 'reveal-folder': await this.#project.revealProjectFolder(); break;
            case 'toggle-width':  this.#toggleCellWidth(); break;
            case 'toggle-view':   this.#toggleCellView(); break;
            case 'save':          await this.#flushAndSaveActive(); break;
            case 'save-all':      await this.#project.saveAll(); break;
        }
    }

    #toggleCellWidth() {
        const pane = this.#getFocusedPane();
        const container = pane?.editorContainer;
        if (!container) return;
        const current = container.dataset.cellWidthMode;
        const next = current === 'fixed' ? 'full' : 'fixed';
        // Apply to all pane containers
        this.#forEachPaneContainer(el => { el.dataset.cellWidthMode = next; });
        const icon = this.#toolbarEl.querySelector('[data-action="toggle-width"] .material-symbols-outlined');
        if (icon) icon.textContent = next === 'full' ? 'width_full' : 'width_normal';
        setSetting('notebook.cellWidthMode', next);
        // Re-render Plotly charts after layout reflow to avoid artifacts
        requestAnimationFrame(() => {
            // Double-rAF ensures the browser has completed reflow after the CSS change
            requestAnimationFrame(() => {
                this.#forEachPaneContainer(el => {
                    for (const chartDiv of el.querySelectorAll('.plot-cell-chart')) {
                        if (chartDiv.offsetWidth > 0 && window.Plotly) {
                            try { window.Plotly.Plots.resize(chartDiv); } catch (_) {}
                        }
                    }
                });
            });
        });
    }

    /** Cycle all cells through config → ecolang view */
    #toggleCellView() {
        const VIEWS = ['config', 'dsl'];
        const ICONS = { config: 'visibility', dsl: 'code' };
        const LABELS = { config: 'Config', dsl: 'EcoLang' };

        const pane = this.#getFocusedPane();
        const container = pane?.editorContainer;
        const current = container?.dataset.cellView ?? 'config';
        const idx = VIEWS.indexOf(current);
        const next = VIEWS[(idx + 1) % VIEWS.length];

        this.#forEachPaneContainer(el => { el.dataset.cellView = next; });

        // Update toolbar button
        const btn = this.#toolbarEl.querySelector('[data-action="toggle-view"]');
        const icon = btn?.querySelector('.material-symbols-outlined');
        const label = btn?.querySelector('.nb-view-label');
        if (icon) icon.textContent = ICONS[next];
        if (label) label.textContent = LABELS[next];

        // Tell every pane's editor to switch tabs
        for (const state of this.#paneEditors.values()) {
            state.editor?.switchAllCellTabs(next);
        }

        setSetting('notebook.defaultCellView', next);
    }

    async onActivated() {
        await this.waitForReady();
        await this.show();
    }

    // ─── File operations ──────────────────────────────────────────────────────

    /**
     * Open a file in the focused pane.
     * @param {string} filePath
     * @param {{ preview?: boolean }} [opts]  — preview: open as transient preview tab
     */
    async #openFile(filePath, { preview = true } = {}) {
        if (!this.#project.isOpen) return;

        try {
            await this.#project.openFile(filePath);

            // If file is already in a pane, just activate it there
            const existingPane = this.#findPaneForFile(filePath);
            if (existingPane) {
                // Double-click (preview=false) pins an existing preview tab
                if (!preview) {
                    const existingPaneObj = this.#getPane(existingPane);
                    if (existingPaneObj.isPreview(filePath)) {
                        existingPaneObj.pinPreview();
                        this.#syncPaneTabBar(existingPane);
                    }
                }
                await this.#activateTab(existingPane, filePath);
                return;
            }

            const paneId = this.#focusedPaneId;
            const pane = this.#getPane(paneId);

            // Replace existing preview tab if opening a new preview
            if (preview) {
                const oldPreview = pane.previewFilePath;
                if (oldPreview && oldPreview !== filePath) {
                    await this.#closeTab(paneId, oldPreview);
                }
            }

            pane.addFile(filePath);
            if (preview) pane.setPreview(filePath);
            await this.#activateTab(paneId, filePath);
        } catch (e) {
            this.logger?.error?.('Failed to open file', filePath, e);
            this.notificationCenter?.error?.(`Failed to open: ${e.message}`);
        }
    }

    /**
     * Open a builtin module as a readonly virtual file.
     * @param {{ name: string, filename: string, content: string }} bm
     */
    async #openBuiltinModule(bm) {
        const virtualPath = `builtin://${bm.filename}`;

        // Register as a virtual open file in ProjectModel if not already open
        const existing = this.#project.getOpenFile(virtualPath);
        if (!existing) {
            this.#project.registerVirtualFile(virtualPath, {
                filePath: virtualPath,
                fileType: 'module',
                content: bm.content,
                isDirty: false,
                builtinSource: true,
            });
        }

        // If already in a pane, activate it
        const existingPane = this.#findPaneForFile(virtualPath);
        if (existingPane) {
            await this.#activateTab(existingPane, virtualPath);
            return;
        }

        const paneId = this.#focusedPaneId;
        const pane = this.#getPane(paneId);

        // Replace existing preview tab
        const oldPreview = pane.previewFilePath;
        if (oldPreview && oldPreview !== virtualPath) {
            await this.#closeTab(paneId, oldPreview);
        }

        pane.addFile(virtualPath);
        pane.setPreview(virtualPath);
        await this.#activateTab(paneId, virtualPath);
    }

    /**
     * Open a git diff view for a changed file.
     * @param {string} filePath - relative path within the project
     * @param {string} status - M/A/D/U/R/C
     * @param {string} [ref] - optional commit ref (for viewing a specific commit's changes)
     */
    async #openDiffFile(filePath, status, ref) {
        if (!this.#project.isOpen) return;

        const api = window.pywebview?.api;
        if (!api) return;

        try {
            const projectPath = this.#project.projectPath;
            let result;

            if (ref) {
                // Diff for a specific commit: show parent vs commit
                const parentRef = ref + '~1';
                const [origResult, modResult] = await Promise.all([
                    api.git_file_at_ref({ projectPath, filePath, ref: parentRef }),
                    api.git_file_at_ref({ projectPath, filePath, ref }),
                ]);
                result = {
                    ok: true,
                    original: origResult?.ok ? origResult.content : '',
                    modified: modResult?.ok ? modResult.content : '',
                    language: 'plaintext',
                };
            } else {
                result = await api.git_diff_file({ projectPath, filePath, status });
            }

            if (!result?.ok) {
                this.notificationCenter?.error?.(result?.error || 'Failed to load diff');
                return;
            }

            const virtualPath = `diff://${filePath}`;
            const fileName = filePath.replace(/^.*[/\\]/, '');

            // Register as virtual file
            this.#project.registerVirtualFile(virtualPath, {
                filePath: virtualPath,
                fileType: 'diff',
                content: result,   // { original, modified, language }
                isDirty: false,
                tabLabel: `↔ ${fileName}`,
            });

            // If already in a pane, activate it and update content
            const existingPane = this.#findPaneForFile(virtualPath);
            if (existingPane) {
                await this.#activateTab(existingPane, virtualPath);
                return;
            }

            const paneId = this.#focusedPaneId;
            const pane = this.#getPane(paneId);

            // Replace existing preview tab
            const oldPreview = pane.previewFilePath;
            if (oldPreview && oldPreview !== virtualPath) {
                await this.#closeTab(paneId, oldPreview);
            }

            pane.addFile(virtualPath);
            pane.setPreview(virtualPath);
            await this.#activateTab(paneId, virtualPath);
        } catch (e) {
            this.logger?.error?.('Failed to open diff', filePath, e);
            this.notificationCenter?.error?.(`Failed to open diff: ${e.message}`);
        }
    }

    /** Import a .edf module file into the project's modules/ directory. */
    async #importModule() {
        if (!this.#project.isOpen) return;

        try {
            const api = window.pywebview?.api;
            if (!api?.open_file_dialog) {
                this.notificationCenter?.error?.('File dialog not available');
                return;
            }

            const result = await api.open_file_dialog('edf');
            if (!result?.ok) {
                if (result?.error) this.notificationCenter?.error?.(result.error);
                return; // cancelled or error
            }

            const content = result.content ?? '';
            // Derive module name from the imported filename
            const importedFileName = (result.path || '').replace(/^.*[/\\]/, '');
            let moduleName = importedFileName.replace(/\.edf$/i, '');

            // Validate module name
            if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(moduleName)) {
                moduleName = moduleName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[^a-zA-Z]/, 'M');
            }

            const filePath = `modules/${moduleName}.edf`;

            // Check for existing file with same name
            const existing = this.#project.files.find(f => f.path === filePath);
            if (existing) {
                this.notificationCenter?.warn?.(`Module "${moduleName}" already exists. Rename it first or delete the existing one.`);
                return;
            }

            await this.#project.createFile(filePath, 'module', content);

            // Open in focused pane
            const paneId = this.#focusedPaneId;
            const pane = this.#getPane(paneId);
            pane.addFile(filePath);
            await this.#activateTab(paneId, filePath);

            this.notificationCenter?.show?.({ message: `Module "${moduleName}" imported`, severity: 'info' });
        } catch (e) {
            this.logger?.error?.('Failed to import module', e);
            this.notificationCenter?.error?.(`Import failed: ${e.message}`);
        }
    }

    /** Fetch builtin modules from backend and pass to FileNavigator. */
    async #fetchBuiltinModules() {
        try {
            const api = window.pywebview?.api;
            if (!api?.module_list_builtins) return;
            const result = await api.module_list_builtins();
            if (result?.ok) {
                this.#fileNav.setBuiltinModules(result.modules);
            }
        } catch (e) {
            this.logger?.warn?.('Failed to fetch builtin modules', e);
        }
    }

    /**
     * Compute and push file badges to the FileNavigator.
     * Called after project open and file save.
     *
     * Badges:
     *   - Namespaces: cell count (muted)
     *   - Modules: function count (muted) or "empty" if no functions
     */
    #updateFileBadges() {
        if (!this.#project?.isOpen) return;

        const files = this.#project.files ?? [];

        for (const f of files) {
            const openFile = this.#project.getOpenFile(f.path);
            if (!openFile) continue;

            if (f.type === 'namespace') {
                const cells = openFile.content?.cells;
                if (Array.isArray(cells)) {
                    const count = cells.filter(c => c.type !== 'metadata' && c.type !== 'scenario-settings').length;
                    if (count > 0) {
                        this.#fileNav.setFileBadge(f.path, { text: String(count), variant: 'muted' });
                    }
                }
            } else if (f.type === 'module') {
                const content = typeof openFile.content === 'string' ? openFile.content : '';
                // Quick function count from raw content — count top-level function definitions
                const funcCount = (content.match(/^[a-zA-Z]\w*\s+(?:\w+\s+)*\w*\s*=/gm) || []).length;
                if (funcCount > 0) {
                    this.#fileNav.setFileBadge(f.path, {
                        text: `${funcCount}`,
                        variant: 'muted',
                    });
                }
            }
        }
    }

    async #activateTab(paneId, filePath, { pin = false } = {}) {
        const pane = this.#getPane(paneId);
        if (!pane) return;

        // Pin preview tab if requested (e.g. user clicked the tab directly)
        if (pin && pane.isPreview(filePath)) {
            pane.pinPreview();
            this.#syncPaneTabBar(paneId);
        }

        if (pane.activeFilePath === filePath) {
            // Already active — just ensure focus
            this.#setFocusedPane(paneId);
            return;
        }

        // Flush current editor content before switching
        if (pane.activeFilePath) {
            this.#flushEditorToProject(paneId, pane.activeFilePath);
        }

        pane.setActiveFile(filePath);
        this.#project.setActiveFile(filePath);

        const openFile = this.#project.getOpenFile(filePath);
        if (!openFile) {
            await this.#project.openFile(filePath);
        }

        await this.#mountEditorForPane(paneId);
        this.#syncPaneTabBar(paneId);
        this.#fileNav.setActiveFile(filePath);
        this.#updateToolbarForFile(filePath);
        this.#setFocusedPane(paneId);
    }

    async #closeTab(paneId, filePath) {
        const isDirty = this.#project.isDirty(filePath);
        if (isDirty) {
            const choice = await showChoiceDialog({
                title: 'Unsaved Changes',
                message: `"${filePath.split('/').pop()}" has unsaved changes.`,
                icon: 'warning',
                actions: [
                    { label: 'Cancel',  value: 'cancel',  variant: 'cancel' },
                    { label: 'Discard', value: 'discard', variant: 'danger' },
                    { label: 'Save',    value: 'save',    variant: 'primary' },
                ],
            });
            if (choice === 'cancel' || choice === null) return;
            if (choice === 'save') {
                this.#flushEditorToProject(paneId, filePath);
                await this.#project.saveFile(filePath);
            }
        }

        const pane = this.#getPane(paneId);
        const wasActive = pane.activeFilePath === filePath;
        pane.removeFile(filePath);

        // Close in ProjectModel only if no other pane has it
        const otherPaneId = this.#otherPaneId(paneId);
        const otherPane = this.#getPane(otherPaneId);
        if (!otherPane?.hasFile(filePath)) {
            this.#project.closeFile(filePath);
        }

        if (pane.isEmpty) {
            // If this is the only pane, show empty state
            if (!this.#rightPane || paneId === 'left' && !this.#rightPane) {
                this.#disposePaneEditors(paneId);
                pane.editorContainer.innerHTML = '';
                this.#showEmptyState();
                this.#syncPaneTabBar(paneId);
                return;
            }
            // Otherwise collapse this pane into the other
            this.#collapsePaneInto(paneId, otherPaneId);
            return;
        }

        if (wasActive) {
            await this.#mountEditorForPane(paneId);
        }
        this.#syncPaneTabBar(paneId);
    }

    async #closeOtherTabs(paneId, keepPath) {
        const pane = this.#getPane(paneId);
        const others = pane.filePaths.filter(p => p !== keepPath);
        for (const path of others) await this.#closeTab(paneId, path);
    }

    async #closeTabsToRight(paneId, filePath) {
        const pane = this.#getPane(paneId);
        const paths = pane.filePaths;
        const idx = paths.indexOf(filePath);
        if (idx === -1) return;
        const toClose = paths.slice(idx + 1);
        for (const path of toClose) await this.#closeTab(paneId, path);
    }

    async #closeAllTabs(paneId) {
        const pane = this.#getPane(paneId);
        const all = [...pane.filePaths];
        for (const path of all) await this.#closeTab(paneId, path);
    }

    #closeSavedTabs(paneId) {
        const pane = this.#getPane(paneId);
        const saved = pane.filePaths.filter(p => !this.#project.isDirty(p));
        for (const path of saved) {
            pane.removeFile(path);
            // Close in ProjectModel only if no other pane has it
            const otherPaneId = this.#otherPaneId(paneId);
            const otherPane = this.#getPane(otherPaneId);
            if (!otherPane?.hasFile(path)) {
                this.#project.closeFile(path);
            }
        }

        if (pane.isEmpty) {
            if (this.#rightPane) {
                const otherPaneId = this.#otherPaneId(paneId);
                this.#collapsePaneInto(paneId, otherPaneId);
            } else {
                this.#disposePaneEditors(paneId);
                pane.editorContainer.innerHTML = '';
                this.#showEmptyState();
            }
        } else if (pane.activeFilePath && !pane.hasFile(pane.activeFilePath)) {
            this.#mountEditorForPane(paneId);
        }

        this.#syncPaneTabBar(paneId);
    }

    #reorderPaneTabs(paneId, orderedPaths) {
        const pane = this.#getPane(paneId);
        pane.reorderFiles(orderedPaths);
        this.#persistSplitState();
    }

    async #newFile(fileType, suggestedPath) {
        if (!this.#project.isOpen) return;

        const dir = suggestedPath.split('/').slice(0, -1).join('/');
        const ext = suggestedPath.split('.').pop();
        const baseName = suggestedPath.split('/').pop().replace(/\.\w+$/, '');

        // Generate a unique name (untitled, untitled_2, untitled_3, ...)
        const existingPaths = new Set((this.#project.files ?? []).map(f => f.path));
        let name = baseName;
        let suffix = 2;
        while (existingPaths.has(dir ? `${dir}/${name}.${ext}` : `${name}.${ext}`)) {
            name = `${baseName}_${suffix++}`;
        }

        const filePath = dir ? `${dir}/${name}.${ext}` : `${name}.${ext}`;
        try {
            await this.#project.createFile(filePath, fileType);
            const paneId = this.#focusedPaneId;
            const pane = this.#getPane(paneId);
            pane.addFile(filePath);
            await this.#activateTab(paneId, filePath);
            this.#fileNav.startRename(filePath);
        } catch (e) {
            this.notificationCenter?.error?.(`Failed to create file: ${e.message}`);
        }
    }

    async #renameFile(oldPath, newName) {
        try {
            const newPath = await this.#project.renameFile(oldPath, newName);
            // Update pane file lists
            this.#leftPane?.renameFile(oldPath, newPath);
            this.#rightPane?.renameFile(oldPath, newPath);
            this.#syncPaneTabBar('left');
            if (this.#rightPane) this.#syncPaneTabBar('right');
        } catch (e) {
            this.notificationCenter?.error?.(`Failed to rename: ${e.message}`);
        }
    }

    async #duplicateFile(filePath) {
        if (!this.#project.isOpen) return;
        try {
            const openFile = await this.#project.duplicateFile(filePath);
            if (openFile) {
                const paneId = this.#focusedPaneId;
                const pane = this.#getPane(paneId);
                pane.addFile(openFile.filePath);
                await this.#activateTab(paneId, openFile.filePath);
            }
        } catch (e) {
            this.notificationCenter?.error?.(`Failed to duplicate: ${e.message}`);
        }
    }

    async #deleteFile(filePath) {
        const name = filePath.split('/').pop();
        const confirmed = await showDeleteConfirmDialog({
            itemName: name,
            itemType: 'file',
            additionalMessage: 'This cannot be undone.',
        });
        if (!confirmed) return;

        try {
            // Remove from any pane that has it
            if (this.#leftPane?.hasFile(filePath)) {
                this.#leftPane.removeFile(filePath);
                if (this.#leftPane.isEmpty && this.#rightPane) {
                    this.#collapsePaneInto('left', 'right');
                } else {
                    this.#syncPaneTabBar('left');
                    this.#mountEditorForPane('left');
                }
            }
            if (this.#rightPane?.hasFile(filePath)) {
                this.#rightPane.removeFile(filePath);
                if (this.#rightPane.isEmpty) {
                    this.#collapsePaneInto('right', 'left');
                } else {
                    this.#syncPaneTabBar('right');
                    this.#mountEditorForPane('right');
                }
            }
            await this.#project.deleteFile(filePath);
        } catch (e) {
            this.notificationCenter?.error?.(`Failed to delete: ${e.message}`);
        }
    }

    // ─── Editor mounting ──────────────────────────────────────────────────────

    async #mountEditorForPane(paneId) {
        await this.#mountEditorForPaneCore(paneId);
        this.#installPreviewPinListener(paneId);
    }

    async #mountEditorForPaneCore(paneId) {
        const pane = this.#getPane(paneId);
        if (!pane) return;

        const filePath = pane.activeFilePath;
        const container = pane.editorContainer;

        // Dispose previous editors for this pane
        this.#disposePaneEditors(paneId);
        container.innerHTML = '';
        // Reset any classes added by previous editors
        container.className = 'notebook-editor-container';
        this.#applySettingsToPane(pane);

        if (!filePath) return;

        // Show loading placeholder while editor mounts
        container.innerHTML = `
            <div class="nb-pane-loading">
                <span class="nb-pane-loading__spinner"></span>
                <p>Loading…</p>
            </div>`;
        // Double-rAF: let the browser paint the spinner before heavy editor work
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Clear loading placeholder before mounting the actual editor
        container.innerHTML = '';

        const openFile = this.#project.getOpenFile(filePath);
        if (!openFile) return;

        const state = this.#paneEditors.get(paneId) ?? this.#emptyEditorState();
        this.#paneEditors.set(paneId, state);

        const fileType = openFile.fileType;

        // Diff files → Monaco side-by-side diff editor
        if (fileType === 'diff') {
            const diffData = openFile.content; // { original, modified, language }
            const wrapper = document.createElement('div');
            wrapper.className = 'nb-diff-editor';
            wrapper.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
            container.appendChild(wrapper);

            const factory = await getEditorFactory();
            state.diffEditorHandle = factory.createDiffEditor(
                wrapper,
                diffData.original || '',
                diffData.modified || '',
                { language: diffData.language || 'plaintext' },
            );
            return;
        }

        // Namespace files → detail header + cell-based NotebookEditor
        if (fileType === 'namespace') {
            // Wrap in .nb-structured-editor (same as scenario/model editors)
            const root = document.createElement('div');
            root.className = 'nb-structured-editor';

            // Detail header with renameable title
            const nsName = filePath.replace(/^.*[/\\]/, '').replace(/\.namespace$/, '');
            root.appendChild(createDetailHeader({
                title: nsName,
                badges: [{ text: 'Namespace' }],
                renameable: true,
                onRename: async (newName) => {
                    const trimmed = newName.trim();
                    if (!trimmed) return { success: false };
                    const dir = filePath.replace(/[/\\][^/\\]*$/, '');
                    const newPath = `${dir}/${trimmed}.namespace`;
                    if (newPath === filePath) return { success: true, newValue: trimmed };
                    try {
                        await this.#renameFile(filePath, newPath);
                        return { success: true, newValue: trimmed };
                    } catch (e) {
                        this.logger?.error('Rename failed', e);
                        return { success: false };
                    }
                },
            }));

            // Sub-container so NotebookEditor.#render() doesn't clear the header
            const editorWrapper = document.createElement('div');
            editorWrapper.className = 'nb-structured-editor__content';
            editorWrapper.style.position = 'relative';
            root.appendChild(editorWrapper);
            container.appendChild(root);

            const notebookData = typeof openFile.content === 'object' ? openFile.content : {};
            const cells = notebookData.cells ?? [];

            // Slide-out panel mounts on the root (not editorWrapper) because
            // NotebookEditor.#render() clears editorWrapper with innerHTML=''.
            const slideOutPanel = new SlideOutPanel({ width: 700 });
            slideOutPanel.mount(root);
            state.slideOutPanel = slideOutPanel;

            state.editor = new NotebookEditor({
                eventBus: this.eventBus,
                logger: this.logger,
                onCellSelected: (cellId, _cellType) => {
                    this.#showCellConfigInPanel(slideOutPanel, state.editor, cellId);
                },
            });

            await state.editor.mount(editorWrapper, {
                cells,
                fileType: 'namespace',
                filePath,
                onChange: () => {
                    this.#project.updateFileContent(filePath, this.#buildNotebookData(filePath, state.editor.getCells()));
                    this.#syncPaneTabBar(paneId);
                    this.#symbolIndex.rebuild(state.editor.getCells(), filePath);
                },
            });

            state.editor.setSymbolIndex(this.#symbolIndex);

            // Push stored simulation results to any plot cells
            this.#simController.pushStoredResults(state.editor);

            // Rebuild symbols for this file
            this.#rebuildFileSymbols(filePath);
            return;
        }

        // Test files → dedicated structured editor
        if (fileType === 'test') {
            state.testEditor = new TestFileEditor();
            await state.testEditor.mount(container, {
                data: typeof openFile.content === 'object' ? openFile.content : {},
                project: this.#project,
                symbolIndex: this.#symbolIndex,
                onChange: (data) => {
                    this.#project.updateFileContent(filePath, data);
                    this.#syncPaneTabBar(paneId);
                },
            });
            return;
        }


        // Scenario files → dedicated tabbed editor
        if (fileType === 'scenario') {
            state.scenarioEditor = new ScenarioFileEditor({
                eventBus: this.eventBus,
                logger: this.logger,
            });
            await state.scenarioEditor.mount(container, {
                data: typeof openFile.content === 'object' ? openFile.content : {},
                symbolIndex: this.#symbolIndex,
                project: this.#project,
                onChange: () => {
                    this.#project.updateFileContent(filePath, state.scenarioEditor.getData());
                    this.#syncPaneTabBar(paneId);
                },
            });

            // Push stored simulation results to scenario documentation plot cells
            this.#simController.pushStoredResultsToScenario(state.scenarioEditor);
            return;
        }

        // Module files (.edf) → ModuleFileEditor with breadcrumb
        if (fileType === 'module') {
            const moduleName = filePath.replace(/^.*[/\\]/, '').replace(/\.edf$/i, '');
            const rawContent = typeof openFile.content === 'string' ? openFile.content : '';
            const isBuiltin = !!openFile.builtinSource;

            state.moduleEditor = new ModuleFileEditor();
            await state.moduleEditor.mount(container, {
                content: rawContent,
                moduleName,
                readonly: isBuiltin,
                onChange: () => {
                    this.#project.updateFileContent(filePath, state.moduleEditor.getValue());
                    this.#syncPaneTabBar(paneId);
                },
                onRename: async (newName) => {
                    const trimmed = newName.trim();
                    if (!trimmed) return { success: false };
                    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) return { success: false };
                    const dir = filePath.replace(/[/\\][^/\\]*$/, '');
                    const newPath = `${dir}/${trimmed}.edf`;
                    if (newPath === filePath) return { success: true, newValue: trimmed };
                    try {
                        await this.#renameFile(filePath, newPath);
                        return { success: true, newValue: trimmed };
                    } catch (e) {
                        this.logger?.error('Module rename failed', e);
                        return { success: false };
                    }
                },
            });
            return;
        }

        // Plain text file — render as a full Monaco EcoLang editor
        const notebookData = typeof openFile.content === 'object'
            ? openFile.content
            : null;

        if (!notebookData) {
            const wrapper = document.createElement('div');
            wrapper.className = 'nb-plain-editor';
            container.appendChild(wrapper);

            const factory = await getEditorFactory();
            const initialContent = typeof openFile.content === 'string' ? openFile.content : '';
            state.plainEditorHandle = factory.createEditor(wrapper, initialContent);
            state.plainEditorHandle.onDidChange(() => {
                this.#project.updateFileContent(filePath, state.plainEditorHandle.getValue());
                this.#syncPaneTabBar(paneId);
            });
            return;
        }

        // Fallback: generic cell editor (legacy model files, etc.)
        const cells = notebookData.cells ?? [];

        state.editor = new NotebookEditor({
            eventBus: this.eventBus,
            logger: this.logger,
        });

        await state.editor.mount(container, {
            cells,
            fileType,
            filePath,
            onChange: () => {
                this.#project.updateFileContent(filePath, this.#buildNotebookData(filePath, state.editor.getCells()));
                this.#syncPaneTabBar(paneId);
                this.#symbolIndex.rebuild(state.editor.getCells(), filePath);
            },
        });

        this.#symbolIndex.rebuildImmediate(cells, filePath);
    }

    /**
     * If the given pane's active file is a preview tab, install a one-time
     * interaction listener that pins it on first click or keypress.
     */
    #installPreviewPinListener(paneId) {
        const pane = this.#getPane(paneId);
        if (!pane) return;
        const filePath = pane.activeFilePath;
        if (!filePath || !pane.isPreview(filePath)) return;

        const container = pane.editorContainer;
        if (!container) return;

        const pin = () => {
            // Guard: still the same preview?
            if (pane.isPreview(filePath)) {
                pane.pinPreview();
                this.#syncPaneTabBar(paneId);
            }
            container.removeEventListener('mousedown', pin, true);
            container.removeEventListener('keydown', pin, true);
        };
        container.addEventListener('mousedown', pin, true);
        container.addEventListener('keydown', pin, true);
    }

    #flushEditorToProject(paneId, filePath) {
        const state = this.#paneEditors.get(paneId);
        if (!state || !filePath) return;

        if (state.testEditor) {
            this.#project.syncFileContent(filePath, state.testEditor.getData());
            return;
        }
        if (state.scenarioEditor) {
            this.#project.syncFileContent(filePath, state.scenarioEditor.getData());
            return;
        }
        if (state.moduleEditor) {
            this.#project.syncFileContent(filePath, state.moduleEditor.getValue());
            return;
        }
        if (state.plainEditorHandle) {
            this.#project.syncFileContent(filePath, state.plainEditorHandle.getValue());
            return;
        }
        if (!state.editor) return;
        const cells = state.editor.getCells();
        this.#project.syncFileContent(filePath, this.#buildNotebookData(filePath, cells));
    }

    #disposePaneEditors(paneId) {
        const state = this.#paneEditors.get(paneId);
        if (!state) return;
        state.slideOutPanel?.dispose();
        state.editor?.dispose();
        state.plainEditorHandle?.dispose();
        state.testEditor?.dispose();
        state.scenarioEditor?.dispose();
        state.moduleEditor?.dispose();
        state.diffEditorHandle?.dispose();
        this.#paneEditors.set(paneId, this.#emptyEditorState());
    }

    #disposeAllPaneEditors() {
        for (const paneId of this.#paneEditors.keys()) {
            this.#disposePaneEditors(paneId);
        }
    }

    /**
     * Show cell config in a slide-out panel (generic dispatch).
     */
    #showCellConfigInPanel(slideOutPanel, editor, cellId) {
        const renderer = editor?.getCellRenderer(cellId);
        const binding = renderer?.getConfigBinding?.();
        if (!binding?.renderConfig || !slideOutPanel) {
            slideOutPanel?.close();
            return;
        }

        slideOutPanel.open(binding.title ?? 'Config', binding.icon ?? 'settings');

        const body = document.createElement('div');
        body.className = 'simrun-dashboard__param-body';
        slideOutPanel.contentEl.appendChild(body);

        binding.renderConfig(body);
    }

    /**
     * Fetch available ETL overlay sources (cached for session).
     * @returns {Promise<Array<{etlKey:string, label:string, category:string}>>}
     */
    async #fetchOverlaySources() {
        if (this.#overlaySources) return this.#overlaySources;
        const api = window.pywebview?.api;
        if (!api?.etl_list_overlay_sources) return [];
        try {
            const result = await api.etl_list_overlay_sources();
            if (result?.ok) {
                this.#overlaySources = result.sources;
                return result.sources;
            }
        } catch { /* ignore */ }
        return [];
    }

    /**
     * Rebuild the global symbol index for all namespace files in the project.
     */
    async #rebuildGlobalSymbolIndex() {
        await this.#symbolIndex.rebuildProject(this.#project);
    }

    /**
     * Late-hydrate the notebook page when a project is already open but the
     * page was mounted after the project:opened event fired (e.g. the app
     * started on the simulation-run page and the user navigated to Model).
     */
    async #hydrateForOpenProject() {
        await this.#simController.loadCachedResults();

        // Restore split layout or open the first namespace file
        const saved = this.#loadSplitState();
        if (saved) {
            await this.#restoreSplitState(saved);
        } else {
            const firstNs = this.#project.namespacePaths?.[0];
            if (firstNs) await this.#openFile(firstNs, { preview: false });
        }
        this.#updateToolbarForFile(this.#getActiveFilePath());

        // Sync top bar solver/time from default scenario
        const defaultScenario = this.#resolveDefaultScenarioPath();
        if (defaultScenario) {
            await this.#syncTopBarFromScenario(defaultScenario);
        }

        this.#simController.fetchAndPushActuals().catch(() => {});

        await this.#rebuildGlobalSymbolIndex();

        this.#validation?.dispose();
        this.#validation = new NotebookValidation({
            eventBus: this.eventBus,
            project: this.#project,
            symbolIndex: this.#symbolIndex,
        });

        this.#fetchBuiltinModules();
        this.#validation?.validate();

        requestAnimationFrame(() => this.#updateFileBadges());
    }

    /**
     * Push validation diagnostics to open editors as Monaco markers.
     * @param {import('../../../notebook/notebook_validation.js').ValidationStatus} status
     */
    #pushDiagnosticsToEditors(status) {
        const monaco = window.monaco;
        if (!monaco) return;

        // Group diagnostics by cellId
        /** @type {Map<string, Array>} */
        const byCellId = new Map();
        for (const d of status.all) {
            if (!d.cellId) continue;
            if (!byCellId.has(d.cellId)) byCellId.set(d.cellId, []);
            byCellId.get(d.cellId).push({
                startLineNumber: d.cellLine || 1,
                startColumn: 1,
                endLineNumber: d.cellLine || 1,
                endColumn: 1000,
                message: d.message,
                severity: d.severity === 'error'
                    ? monaco.MarkerSeverity.Error
                    : monaco.MarkerSeverity.Warning,
            });
        }

        // Push to all open editors
        for (const state of this.#paneEditors.values()) {
            if (!state.editor) continue;
            // Clear all existing markers first
            state.editor.clearAllDiagnostics();
            // Set markers for cells that have diagnostics
            for (const [cellId, markers] of byCellId) {
                state.editor.setDiagnostics(cellId, markers);
            }
        }
    }

    /**
     * Rebuild symbols for a single namespace file after save or edit.
     * @param {string} filePath
     */
    #rebuildFileSymbols(filePath) {
        const openFile = this.#project.getOpenFile(filePath);
        const cells = openFile?.content?.cells;
        if (!Array.isArray(cells)) return;
        this.#symbolIndex.rebuildFile(filePath, cells);
    }

    #buildNotebookData(filePath, cells) {
        const openFile = this.#project.getOpenFile(filePath);
        const existing = typeof openFile?.content === 'object' ? openFile.content : {};
        return { ...existing, cells };
    }

    async #flushAndSaveActive() {
        const paneId = this.#focusedPaneId;
        const pane = this.#getPane(paneId);
        if (!pane?.activeFilePath) return;
        this.#flushEditorToProject(paneId, pane.activeFilePath);
        await this.#project.saveFile(pane.activeFilePath);
        this.notificationCenter?.show?.({ message: 'Saved.', severity: 'info', skipHistory: true });
    }

    /**
     * Flush all active editors in all panes to ProjectModel.
     * Called before simulation to ensure DSL compilation uses current editor state.
     */
    #flushAllEditors() {
        for (const paneId of ['left', 'right']) {
            const pane = this.#getPane(paneId);
            if (pane?.activeFilePath) {
                this.#flushEditorToProject(paneId, pane.activeFilePath);
            }
        }
    }

    // ─── UI sync ──────────────────────────────────────────────────────────────

    #syncPaneTabBar(paneId) {
        const pane = this.#getPane(paneId);
        if (!pane) return;

        const tabs = pane.filePaths.map(path => {
            const f = this.#project.getOpenFile(path);
            return {
                filePath: path,
                fileType: f?.fileType ?? 'unknown',
                isDirty: this.#project.isDirty(path),
                isPreview: pane.isPreview(path),
            };
        });
        pane.syncTabBar(tabs, pane.activeFilePath);
    }

    #updateToolbarForFile(filePath) {
        this.#emitBreadcrumb(filePath);

        // Toggle-width and toggle-view only make sense for cell-based editors (namespace files)
        const openFile = filePath ? this.#project.getOpenFile(filePath) : null;
        const hasCells = openFile?.fileType === 'namespace';
        const widthBtn = this.#toolbarEl.querySelector('[data-action="toggle-width"]');
        const viewBtn  = this.#toolbarEl.querySelector('[data-action="toggle-view"]');
        if (widthBtn) widthBtn.disabled = !hasCells;
        if (viewBtn)  viewBtn.disabled  = !hasCells;
    }

    #emitBreadcrumb(filePath) {
        const segments = [];

        if (this.#project.isOpen) {
            segments.push({
                icon: 'folder',
                label: this.#project.projectName ?? 'Untitled',
                onClick: null,
            });
        }

        if (filePath) {
            const openFile = this.#project.getOpenFile(filePath);
            const fileType = openFile?.fileType ?? null;

            // File type group segment (e.g., "Modules", "Tests", "Namespaces")
            const GROUP_META = {
                namespace: { label: 'Namespaces', icon: 'dataset' },
                module:    { label: 'Modules',    icon: 'extension' },
                test:      { label: 'Tests',      icon: 'fact_check' },
                scenario:  { label: 'Scenarios',  icon: 'science' },
            };
            const group = GROUP_META[fileType];
            if (group) {
                segments.push({ icon: group.icon, label: group.label, onClick: null });
            }

            // File name segment (strip extension for cleaner display)
            const fileName = filePath.split('/').pop();
            const displayName = fileType === 'module'    ? fileName.replace(/\.edf$/i, '')
                              : fileType === 'namespace' ? fileName.replace(/\.namespace$/i, '')
                              : fileType === 'test'      ? fileName.replace(/\.test$/i, '')
                              : fileType === 'scenario'  ? fileName.replace(/\.scenario$/i, '')
                              : fileName;
            segments.push({ icon: 'description', label: displayName, onClick: null });
        }

        if (segments.length === 0) {
            segments.push({ icon: 'edit_note', label: 'Notebook', onClick: null });
        }

        this.eventBus?.emit('topbar:breadcrumb:update', { segments });
    }

    // ─── Project event subscriptions ──────────────────────────────────────────

    #subscribeProjectEvents() {
        const onOpened = async ({ manifest }) => {
            this.notificationCenter?.show?.({
                message: `Project opened: ${manifest.name}`,
                severity: 'info',
                skipHistory: true,
            });

            // Collapse to single pane on project open
            if (this.#rightPane) {
                this.#disposePaneEditors('right');
                this.#rightPane.dispose();
                this.#rightPane = null;
                this.#paneEditors.delete('right');
                this.#splitContainer.setPanes(this.#leftPane.element);
            }
            this.#leftPane.setFilePaths([]);
            this.#leftPane.setActiveFile(null);
            this.#paneEditors.set('left', this.#emptyEditorState());
            this.#focusedPaneId = 'left';
            this.#leftPane.setFocused(true);

            // Load cached simulation results BEFORE opening files, so that
            // pushStoredResults() has data when editors mount plot cells.
            await this.#simController.loadCachedResults();

            // Restore split layout if persisted
            const saved = this.#loadSplitState();
            if (saved) {
                await this.#restoreSplitState(saved);
            } else {
                // Open the first namespace file by default
                const firstNs = this.#project.namespacePaths?.[0];
                if (firstNs) await this.#openFile(firstNs, { preview: false });
            }
            this.#updateToolbarForFile(this.#getActiveFilePath());

            // Sync top bar solver/time from default scenario
            const defaultScenario = this.#resolveDefaultScenarioPath();
            if (defaultScenario) {
                await this.#syncTopBarFromScenario(defaultScenario);
            }

            // Fetch actuals overlays for plot cells (after files are open)
            this.#simController.fetchAndPushActuals().catch(() => {});

            // Build full-project symbol index
            await this.#rebuildGlobalSymbolIndex();

            // Create validation engine for this project
            this.#validation?.dispose();
            this.#validation = new NotebookValidation({
                eventBus: this.eventBus,
                project: this.#project,
                symbolIndex: this.#symbolIndex,
            });

            // Fetch builtin modules for FileNavigator
            this.#fetchBuiltinModules();

            // Run initial validation so the indicator is up-to-date from the start
            this.#validation?.validate();

            // Compute file badges after a tick (let files open first)
            requestAnimationFrame(() => this.#updateFileBadges());
        };

        const onFileDirty = ({ filePath, isDirty }) => {
            this.#leftPane?.markDirty(filePath, isDirty);
            this.#rightPane?.markDirty(filePath, isDirty);
        };

        const onFileRenamed = ({ oldPath, newPath }) => {
            this.#leftPane?.renameFile(oldPath, newPath);
            this.#rightPane?.renameFile(oldPath, newPath);
            this.#syncPaneTabBar('left');
            if (this.#rightPane) this.#syncPaneTabBar('right');
        };

        const sub = (event, fn) => {
            const h = this.eventBus?.on(event, fn);
            if (h) this.#disposers.push(() => h.dispose?.());
        };
        const onExternalChange = ({ filePath, changeType }) => {
            this.#handleExternalFileChange(filePath, changeType);
        };

        sub(ProjectModel.EVENTS.OPENED,      onOpened);
        sub(ProjectModel.EVENTS.CLOSED, () => {
            this.#disposeAllPaneEditors();
            this.#leftPane?.setFilePaths([]);
            this.#leftPane?.setActiveFile(null);
            if (this.#rightPane) {
                this.#rightPane.dispose();
                this.#rightPane = null;
                this.#paneEditors.delete('right');
                this.#splitContainer.setPanes(this.#leftPane.element);
            }
            this.#showEmptyState();
            this.#emitBreadcrumb(null);
        });
        sub(ProjectModel.EVENTS.FILE_DIRTY,  onFileDirty);
        sub(ProjectModel.EVENTS.FILE_RENAMED, onFileRenamed);
        sub(ProjectModel.EVENTS.FILE_SAVED,  ({ filePath }) => {
            this.#rebuildFileSymbols(filePath);
            // Only re-validate when files that affect DSL compilation change.
            // Dashboards, scenarios, paper, etc. don't influence validation output.
            if (filePath?.endsWith('.namespace') || filePath?.endsWith('.module')) {
                this.#validation?.validate();
            }
            this.#updateFileBadges();
        });
        sub(ProjectModel.EVENTS.EXTERNAL_CHANGE, onExternalChange);

        // Sync top bar time/solver when scenario dropdown changes
        sub('scenario:topbar:selected', async ({ scenarioPath }) => {
            if (!scenarioPath || !this.#project?.isOpen) return;
            await this.#syncTopBarFromScenario(scenarioPath);
        });

        // Clear overlay sources cache when datasets change (ETL run completed)
        sub('data:datasets:updated', () => { this.#overlaySources = null; });

        // Cross-file navigation from cells, global search, etc.
        sub('project:file:request-open', async ({ filePath, cellId }) => {
            if (!filePath) return;

            // Switch to notebook page if not already there (e.g., from simulation run page)
            this.eventBus?.emit('shell:request-mode', { mode: 'notebook' });

            await this.#openFile(filePath, { preview: false });

            if (cellId) {
                for (const [paneId, state] of this.#paneEditors) {
                    if (!state.editor) continue;
                    const pane = this.#getPane(paneId);
                    if (pane?.activeFilePath !== filePath) continue;
                    state.editor.scrollToCell(cellId);
                    this.#setFocusedPane(paneId);
                    break;
                }
            }
        });

        // Validation status → update indicator + push Monaco markers
        sub('notebook:validation:updated', (status) => {
            this.#validationIndicator?.update(status);
            this.#pushDiagnosticsToEditors(status);
        });

        // Insert cell from external tools (e.g. Policy Designer → switch cell)
        sub('notebook:insert-cell', ({ type, data }) => {
            const editor = this.#getActiveEditor();
            if (editor) {
                editor.addCellWithData(type, data);
            }
        });

        // Outline navigation — open file if needed, scroll to cell + line
        sub('notebook:outline:jump', async (sym) => {
            if (!sym?.cellId) return;

            // If the symbol's file differs from the focused pane's active file, open it first
            const focusedPane = this.#getPane(this.#focusedPaneId);
            if (sym.fileName && sym.fileName !== focusedPane?.activeFilePath) {
                await this.#openFile(sym.fileName, { preview: false });
            }

            // Find the pane that now has this file open and scroll to cell + line
            for (const [paneId, state] of this.#paneEditors) {
                if (!state.editor) continue;
                const pane = this.#getPane(paneId);
                if (sym.fileName && pane?.activeFilePath !== sym.fileName) continue;
                state.editor.scrollToCellLine(sym.cellId, sym.line ?? null);
                this.#setFocusedPane(paneId);
                break;
            }
        });

        // Dashboard widget → Add to Documentation: append plot cell to scenario doc
        sub('tile:add-to-documentation', ({ tileType, config }) => {
            if (tileType !== 'plot') return;
            // Find the first open scenario editor
            for (const [, state] of this.#paneEditors) {
                if (state.scenarioEditor) {
                    state.scenarioEditor.addDocCell('plot', config);
                    this.eventBus?.emit('toast:show', {
                        text: 'Plot added to documentation',
                        type: 'success',
                        autoHide: true,
                    });
                    return;
                }
            }
            this.eventBus?.emit('toast:show', {
                text: 'Open a scenario to add to its documentation',
                type: 'warning',
                autoHide: true,
            });
        });

        // ── AI integration events ─────────────────────────────────────────

        sub('ai:cell:add', async ({ filePath, cellId, cellType, cellData, afterCellId }) => {
            const editor = await this.#ensureEditorForFile(filePath);
            if (editor) {
                await editor.insertCellWithId(cellType, cellData, cellId, afterCellId);
            }
        });

        sub('ai:cell:update', async ({ filePath, cellId, cellData }) => {
            const editor = await this.#ensureEditorForFile(filePath);
            if (editor) {
                await editor.updateCellData(cellId, cellData);
            }
        });

        sub('ai:cell:delete', async ({ filePath, cellId }) => {
            const editor = await this.#ensureEditorForFile(filePath);
            if (editor) {
                editor.removeCellById(cellId);
            }
        });

        sub('ai:cell:move', async ({ filePath, cellId, direction }) => {
            const editor = await this.#ensureEditorForFile(filePath);
            if (editor) {
                editor.moveCellById(cellId, direction);
            }
        });

        sub('ai:file:create', async ({ path, fileType, content }) => {
            if (!this.#project?.isOpen) return;
            await this.#project.createFile(path, fileType, content);
            await this.#openFile(path, { preview: false });
        });

        sub('ai:file:delete', async ({ path }) => {
            if (!this.#project?.isOpen) return;
            await this.#project.deleteFile(path);
        });

        sub('ai:file:rename', async ({ oldPath, newPath }) => {
            if (!this.#project?.isOpen) return;
            const baseName = newPath.split('/').pop().replace(/\.[^.]+$/, '');
            await this.#project.renameFile(oldPath, baseName);
        });

        sub('ai:file:update', async ({ path, content }) => {
            if (!this.#project?.isOpen) return;
            this.#project.updateFileContent(path, content);
            // If the file is open in an editor, reload it
            const paneId = this.#findPaneForFile(path);
            if (paneId) {
                await this.#activateTab(paneId, path);
            }
        });

        sub('ai:scenario:update', async ({ filePath, patch }) => {
            if (!this.#project?.isOpen) return;
            const existing = this.#project.getOpenFile(filePath);
            if (existing?.content && typeof existing.content === 'object') {
                const updated = { ...existing.content };
                for (const [key, value] of Object.entries(patch)) {
                    if (typeof value === 'object' && value !== null && typeof updated[key] === 'object' && updated[key] !== null) {
                        updated[key] = { ...updated[key], ...value };
                    } else {
                        updated[key] = value;
                    }
                }
                this.#project.updateFileContent(filePath, updated);
            }
        });

        sub('ai:dashboard:update', async ({ action, filePath, tile, tileId }) => {
            if (!this.#project?.isOpen) return;
            const existing = this.#project.getOpenFile(filePath);
            if (!existing?.content || typeof existing.content !== 'object') return;
            const updated = { ...existing.content };
            const tiles = [...(updated.tiles || [])];

            if (action === 'add_tile' && tile) {
                tiles.push(tile);
            } else if (action === 'update_tile' && tileId && tile) {
                const idx = tiles.findIndex(t => t.id === tileId);
                if (idx >= 0) tiles[idx] = { ...tile, id: tileId };
            } else if (action === 'remove_tile' && tileId) {
                const idx = tiles.findIndex(t => t.id === tileId);
                if (idx >= 0) tiles.splice(idx, 1);
            }

            updated.tiles = tiles;
            this.#project.updateFileContent(filePath, updated);
        });

    }

    // ─── External file change handling ──────────────────────────────────────

    async #handleExternalFileChange(filePath, changeType) {
        const isOpen = this.#project.getOpenFile(filePath) !== null;
        if (!isOpen) return;

        if (changeType === 'deleted') {
            this.notificationCenter?.show?.({
                message: `"${filePath.split('/').pop()}" was deleted externally.`,
                severity: 'warn',
            });

            // Remove from panes
            for (const paneId of ['left', 'right']) {
                const pane = this.#getPane(paneId);
                if (pane?.hasFile(filePath)) {
                    pane.removeFile(filePath);
                    if (pane.isEmpty && this.#rightPane) {
                        this.#collapsePaneInto(paneId, this.#otherPaneId(paneId));
                    } else if (pane.isEmpty) {
                        this.#disposePaneEditors(paneId);
                        pane.editorContainer.innerHTML = '';
                        this.#showEmptyState();
                    } else {
                        this.#mountEditorForPane(paneId);
                    }
                    this.#syncPaneTabBar(paneId);
                }
            }

            this.#project.closeFile(filePath);
            return;
        }

        // Modified file — check if dirty
        const isDirty = this.#project.isDirty(filePath);

        if (!isDirty) {
            await this.#project.reloadFileFromDisk(filePath);
            // Re-mount in any pane that has this file active
            for (const paneId of ['left', 'right']) {
                const pane = this.#getPane(paneId);
                if (pane?.activeFilePath === filePath) {
                    await this.#mountEditorForPane(paneId);
                }
            }
            this.#syncPaneTabBar('left');
            if (this.#rightPane) this.#syncPaneTabBar('right');
            return;
        }

        const fileName = filePath.split('/').pop();
        this.notificationCenter?.show?.({
            message: `"${fileName}" was modified externally. Reload to see changes, or keep your edits.`,
            severity: 'warn',
            persistent: true,
            actions: [
                {
                    label: 'Reload',
                    handler: async () => {
                        await this.#project.reloadFileFromDisk(filePath);
                        for (const paneId of ['left', 'right']) {
                            const pane = this.#getPane(paneId);
                            if (pane?.activeFilePath === filePath) {
                                await this.#mountEditorForPane(paneId);
                            }
                        }
                        this.#syncPaneTabBar('left');
                        if (this.#rightPane) this.#syncPaneTabBar('right');
                    },
                },
                { label: 'Keep', handler: () => {} },
            ],
        });
    }


    // ─── Split state persistence ─────────────────────────────────────────────

    #persistSplitState() {
        if (!this.#project?.isOpen) return;

        const state = {
            projectPath: this.#project.projectPath,
            isSplit: !!this.#rightPane,
            ratio: this.#splitContainer.ratio,
            focusedPane: this.#focusedPaneId,
            left: {
                files: this.#leftPane.filePaths,
                active: this.#leftPane.activeFilePath,
            },
        };
        if (this.#rightPane) {
            state.right = {
                files: this.#rightPane.filePaths,
                active: this.#rightPane.activeFilePath,
            };
        }

        try {
            localStorage.setItem('ecosim.split.state', JSON.stringify(state));
        } catch { /* ignore */ }
    }

    #loadSplitState() {
        try {
            const raw = localStorage.getItem('ecosim.split.state');
            if (!raw) return null;
            const state = JSON.parse(raw);
            // Only restore for the same project
            if (state.projectPath !== this.#project.projectPath) return null;
            return state;
        } catch {
            return null;
        }
    }

    async #restoreSplitState(saved) {
        // Restore left pane files
        for (const fp of saved.left?.files ?? []) {
            try {
                await this.#project.openFile(fp);
                this.#leftPane.addFile(fp);
            } catch { /* skip missing files */ }
        }

        if (saved.left?.active && this.#leftPane.hasFile(saved.left.active)) {
            this.#leftPane.setActiveFile(saved.left.active);
        } else if (this.#leftPane.filePaths.length > 0) {
            this.#leftPane.setActiveFile(this.#leftPane.filePaths[0]);
        }

        // Restore right pane if split
        if (saved.isSplit && saved.right?.files?.length > 0) {
            this.#rightPane = this.#createPane('right');
            this.#paneEditors.set('right', this.#emptyEditorState());
            this.#applySettingsToPane(this.#rightPane);

            for (const fp of saved.right.files) {
                try {
                    await this.#project.openFile(fp);
                    this.#rightPane.addFile(fp);
                } catch { /* skip missing files */ }
            }

            if (this.#rightPane.filePaths.length > 0) {
                if (saved.right.active && this.#rightPane.hasFile(saved.right.active)) {
                    this.#rightPane.setActiveFile(saved.right.active);
                } else {
                    this.#rightPane.setActiveFile(this.#rightPane.filePaths[0]);
                }

                this.#splitContainer.setPanes(this.#leftPane.element, this.#rightPane.element);
                if (saved.ratio) this.#splitContainer.setRatio(saved.ratio);
            } else {
                // No files restored for right pane — don't split
                this.#rightPane.dispose();
                this.#rightPane = null;
                this.#paneEditors.delete('right');
            }
        }

        // Restore focus
        this.#focusedPaneId = (saved.focusedPane === 'right' && this.#rightPane) ? 'right' : 'left';
        this.#leftPane.setFocused(this.#focusedPaneId === 'left');
        this.#rightPane?.setFocused(this.#focusedPaneId === 'right');

        // Mount editors and sync tab bars
        this.#syncPaneTabBar('left');
        await this.#mountEditorForPane('left');
        if (this.#rightPane) {
            this.#syncPaneTabBar('right');
            await this.#mountEditorForPane('right');
        }

        // If no files were restored at all, open the first namespace
        if (this.#leftPane.isEmpty && (!this.#rightPane || this.#rightPane.isEmpty)) {
            const firstNs = this.#project.namespacePaths?.[0];
            if (firstNs) await this.#openFile(firstNs, { preview: false });
        }

        const activeFile = this.#getActiveFilePath();
        if (activeFile) {
            this.#fileNav.setActiveFile(activeFile);
            this.#updateToolbarForFile(activeFile);
        }
    }

    // ─── Empty state ──────────────────────────────────────────────────────────

    #showEmptyState() {
        const container = this.#leftPane?.editorContainer;
        if (!container) return;

        // The no-project case is owned by EcoAgent's own home screen (the
        // project-selector overlay), so the notebook editor area only ever
        // needs a neutral "nothing open here" placeholder.
        container.innerHTML = `
            <div class="notebook-empty-state">
                <div class="notebook-empty-icon">
                    <span class="material-symbols-outlined">edit_note</span>
                </div>
                <h2>No open editors</h2>
                <p>Open a file from the navigator to start editing.</p>
            </div>
        `;
    }
}
