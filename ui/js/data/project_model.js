/**
 * ProjectModel — Frontend representation of an EcoSim project.
 *
 * Manages the project lifecycle: create, open, list files, track open files,
 * dirty state, and bridge to the backend project CRUD API.
 *
 * Events emitted:
 *   project:opened        { path, manifest }
 *   project:closed
 *   project:file:opened   { filePath, fileType, content }
 *   project:file:closed   { filePath }
 *   project:file:saved    { filePath }
 *   project:file:created  { filePath, fileType }
 *   project:file:deleted  { filePath }
 *   project:file:renamed  { oldPath, newPath }
 *   project:file:dirty    { filePath, isDirty }
 *   project:files:changed { files }
 *   project:file:external-change { filePath, changeType }
 */

import { addRecentProject } from './recent_projects.js';

const EVENTS = Object.freeze({
    OPENED:        'project:opened',
    CLOSED:        'project:closed',
    FILE_OPENED:   'project:file:opened',
    FILE_CLOSED:   'project:file:closed',
    FILE_SAVED:    'project:file:saved',
    FILE_CREATED:  'project:file:created',
    FILE_DELETED:  'project:file:deleted',
    FILE_RENAMED:  'project:file:renamed',
    FILE_DIRTY:    'project:file:dirty',
    FILES_CHANGED: 'project:files:changed',
    EXTERNAL_CHANGE: 'project:file:external-change',
});

/** @typedef {{ path: string, type: string, size: number, modified: number }} ProjectFileEntry */
/** @typedef {{ filePath: string, fileType: string, content: string|object, isDirty: boolean }} OpenFile */

export class ProjectModel {
    /** @type {string|null} Absolute path to project directory */
    #projectPath = null;

    /** @type {object|null} Parsed manifest */
    #manifest = null;

    /** @type {ProjectFileEntry[]} All files in project */
    #files = [];

    /** @type {Map<string, OpenFile>} Currently open files keyed by relative path */
    #openFiles = new Map();

    /** @type {Map<string, number>} Pending autosave timers keyed by file path */
    #autosaveTimers = new Map();

    /** Autosave debounce delay in ms */
    static AUTOSAVE_DELAY = 1500;

    /** @type {string|null} Currently active file tab */
    #activeFilePath = null;

    static EVENTS = EVENTS;

    constructor({ eventBus, logger } = {}) {
        this.eventBus = eventBus;
        this.log = logger?.createScope?.('ProjectModel') ?? console;

        // Register global handler for backend file watcher events
        window._ecosimFileChanged = (evt) => this.#onExternalFileChange(evt);
    }

    // ─── Getters ─────────────────────────────────────────────

    get isOpen()       { return this.#projectPath !== null; }
    get projectPath()  { return this.#projectPath; }
    get projectName()  { return this.#manifest?.name ?? null; }
    get manifest()     { return this.#manifest; }
    get files()        { return this.#files; }
    get activeFilePath() { return this.#activeFilePath; }

    /** Paths of all namespace files in manifest order. */
    get namespacePaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'namespace')
            .map(f => f.path);
    }

    /** Paths of all module (.edf) files in manifest order. */
    get modulePaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'module')
            .map(f => f.path);
    }

    get dashboardPaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'dashboard')
            .map(f => f.path);
    }

    /** Paths of all orchestration files in manifest order. */
    get orchestrationPaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'orchestration')
            .map(f => f.path);
    }

    /** Paths of all pipeline files in manifest order. */
    get pipelinePaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'pipeline')
            .map(f => f.path);
    }

    /** Paths of all calibration config files in manifest order. */
    get calibrationPaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'calibration')
            .map(f => f.path);
    }

    /** Paths of all scenario files in manifest order. */
    get scenarioPaths() {
        return (this.#manifest?.files ?? [])
            .filter(f => f.type === 'scenario')
            .map(f => f.path);
    }

    get openFilePaths() {
        return [...this.#openFiles.keys()];
    }

    getOpenFile(filePath) {
        return this.#openFiles.get(filePath) ?? null;
    }

    isDirty(filePath) {
        return this.#openFiles.get(filePath)?.isDirty ?? false;
    }

    get hasAnyDirty() {
        for (const f of this.#openFiles.values()) {
            if (f.isDirty) return true;
        }
        return false;
    }

    // ─── Project lifecycle ───────────────────────────────────

    /**
     * Create a new project via backend dialog.
     * @param {string} [name] Optional project name
     */
    async create(name) {
        const api = window.pywebview?.api;
        if (!api) throw new Error('pywebview API not available');

        const result = await api.project_create({ name: name ?? 'Untitled Project' });
        if (!result.ok) {
            if (result.cancelled) return null;
            throw new Error(result.error);
        }

        await this.#loadProject(result.path, result.manifest);
        return this.#manifest;
    }

    /**
     * Open an existing project via backend dialog or direct path.
     * @param {string} [path] Optional direct path (skips dialog)
     */
    async open(path) {
        const api = window.pywebview?.api;
        if (!api) throw new Error('pywebview API not available');

        const result = await api.project_open(path ? { path } : {});
        if (!result.ok) {
            if (result.cancelled) return null;
            throw new Error(result.error);
        }

        await this.#loadProject(result.path, result.manifest);
        return this.#manifest;
    }

    /**
     * Open a bundled demo project by name.
     * @param {string} name  e.g. 'world3'
     */
    async openDemo(name = 'world3') {
        const api = window.pywebview?.api;
        if (!api) throw new Error('pywebview API not available');

        const result = await api.project_open_demo({ name });
        if (!result.ok) throw new Error(result.error);

        await this.#loadProject(result.path, result.manifest);
        return this.#manifest;
    }

    /**
     * Close the current project. Warns if there are unsaved changes.
     * @returns {boolean} true if closed, false if cancelled
     */
    close() {
        if (!this.isOpen) return true;

        // Cancel all pending autosave timers
        for (const timer of this.#autosaveTimers.values()) clearTimeout(timer);
        this.#autosaveTimers.clear();

        this.#stopWatcher();
        this.#projectPath = null;
        this.#manifest = null;
        this.#files = [];
        this.#openFiles.clear();
        this.#activeFilePath = null;

        this.eventBus?.emit(EVENTS.CLOSED);
        this.#persistState();
        return true;
    }

    // ─── Import / Export ──────────────────────────────────────

    /**
     * Export the current project as a .ecoproj archive.
     * Opens a Save dialog for the user to pick a destination.
     * @returns {{ path: string }|null} Exported file path, or null if cancelled
     */
    async exportProject() {
        const api = window.pywebview?.api;
        if (!api) throw new Error('pywebview API not available');
        if (!this.isOpen) throw new Error('No project is open');

        const result = await api.project_export({ path: this.#projectPath });
        if (!result.ok) {
            if (result.cancelled) return null;
            throw new Error(result.error);
        }

        return { path: result.path };
    }

    /**
     * Import a project from a .ecoproj archive.
     * Opens dialogs to pick the archive and destination, then opens the project.
     * @returns {object|null} Manifest of the imported project, or null if cancelled
     */
    async importProject() {
        const api = window.pywebview?.api;
        if (!api) throw new Error('pywebview API not available');

        const result = await api.project_import();
        if (!result.ok) {
            if (result.cancelled) return null;
            throw new Error(result.error);
        }

        await this.#loadProject(result.path, result.manifest);
        return this.#manifest;
    }

    // ─── File operations ─────────────────────────────────────

    /**
     * Read file content without opening it in the editor.
     * Returns from cache if already open, otherwise reads from disk.
     * Does not modify open files, active file, or emit events.
     * @param {string} filePath Relative path within project
     * @returns {Promise<*>} Parsed content (object for JSON files, string otherwise), or null on error
     */
    async readFileContent(filePath) {
        const cached = this.#openFiles.get(filePath);
        if (cached) return cached.content;

        const api = window.pywebview?.api;
        if (!api || !this.#projectPath) return null;

        try {
            const result = await api.project_read_file({
                projectPath: this.#projectPath,
                filePath,
            });
            if (!result.ok) return null;

            let content = result.content;
            if (result.isJson) {
                try { content = JSON.parse(content); } catch { /* keep as string */ }
            }
            return content;
        } catch {
            return null;
        }
    }

    /**
     * Open a file for editing. Reads from disk if not already open.
     * @param {string} filePath Relative path within project
     */
    async openFile(filePath) {
        if (this.#openFiles.has(filePath)) {
            this.#activeFilePath = filePath;
            this.eventBus?.emit(EVENTS.FILE_OPENED, this.#openFiles.get(filePath));
            return this.#openFiles.get(filePath);
        }

        const api = window.pywebview?.api;
        const result = await api.project_read_file({
            projectPath: this.#projectPath,
            filePath,
        });

        if (!result.ok) throw new Error(result.error);

        const fileType = this.#inferFileType(filePath);
        let content = result.content;
        if (result.isJson) {
            try { content = JSON.parse(content); } catch { /* keep as string */ }
        }

        const openFile = { filePath, fileType, content, isDirty: false };
        this.#openFiles.set(filePath, openFile);
        this.#activeFilePath = filePath;

        this.eventBus?.emit(EVENTS.FILE_OPENED, openFile);
        this.#persistState();
        return openFile;
    }

    /**
     * Register a virtual file (e.g., builtin modules) that doesn't live on disk.
     * @param {string} filePath Virtual path (e.g., 'builtin://MathExtended.edf')
     * @param {object} openFile { filePath, fileType, content, isDirty, builtinSource? }
     */
    registerVirtualFile(filePath, openFile) {
        if (this.#openFiles.has(filePath)) return;
        this.#openFiles.set(filePath, openFile);
        this.#activeFilePath = filePath;
        this.eventBus?.emit(EVENTS.FILE_OPENED, openFile);
    }

    /**
     * Close an open file tab.
     * @param {string} filePath
     */
    closeFile(filePath) {
        this.#cancelAutosave(filePath);
        this.#openFiles.delete(filePath);
        if (this.#activeFilePath === filePath) {
            const remaining = [...this.#openFiles.keys()];
            this.#activeFilePath = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        }
        this.eventBus?.emit(EVENTS.FILE_CLOSED, { filePath });
        this.#persistState();
    }

    /**
     * Reorder open file tabs. Rebuilds the internal Map in the given order.
     * @param {string[]} orderedPaths — file paths in desired tab order
     */
    reorderTabs(orderedPaths) {
        const old = new Map(this.#openFiles);
        this.#openFiles.clear();
        for (const p of orderedPaths) {
            const f = old.get(p);
            if (f) this.#openFiles.set(p, f);
        }
        // Append any files not in the new order (shouldn't happen, but safety)
        for (const [p, f] of old) {
            if (!this.#openFiles.has(p)) this.#openFiles.set(p, f);
        }
        this.#persistState();
    }

    /**
     * Save an open file to disk.
     * @param {string} filePath
     */
    async saveFile(filePath) {
        this.#cancelAutosave(filePath);

        const openFile = this.#openFiles.get(filePath);
        if (!openFile) throw new Error(`File not open: ${filePath}`);

        // Virtual files (e.g., builtin modules) cannot be saved
        if (filePath.startsWith('builtin://')) return;

        const content = typeof openFile.content === 'object'
            ? JSON.stringify(openFile.content, null, 2)
            : openFile.content;

        const api = window.pywebview?.api;
        const result = await api.project_write_file({
            projectPath: this.#projectPath,
            filePath,
            content,
        });

        if (!result.ok) throw new Error(result.error);

        openFile.isDirty = false;
        this.eventBus?.emit(EVENTS.FILE_SAVED, { filePath });
        this.eventBus?.emit(EVENTS.FILE_DIRTY, { filePath, isDirty: false });
    }

    /** Save all dirty files. */
    async saveAll() {
        const dirty = [...this.#openFiles.entries()].filter(([, f]) => f.isDirty);
        for (const [path] of dirty) {
            await this.saveFile(path);
        }
    }

    /**
     * Update the in-memory content of an open file and mark dirty.
     * @param {string} filePath
     * @param {string|object} content
     */
    updateFileContent(filePath, content) {
        const openFile = this.#openFiles.get(filePath);
        if (!openFile) return;

        openFile.content = content;
        if (!openFile.isDirty) {
            openFile.isDirty = true;
            this.eventBus?.emit(EVENTS.FILE_DIRTY, { filePath, isDirty: true });
        }

        this.#scheduleAutosave(filePath);
    }

    /**
     * Schedule a debounced autosave for the given file.
     * Resets the timer on each call so saves only fire after edits settle.
     */
    #scheduleAutosave(filePath) {
        // Virtual files cannot be saved
        if (filePath.startsWith('builtin://')) return;

        const existing = this.#autosaveTimers.get(filePath);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            this.#autosaveTimers.delete(filePath);
            const openFile = this.#openFiles.get(filePath);
            if (!openFile?.isDirty) return;
            try {
                await this.saveFile(filePath);
            } catch (err) {
                this.log.warn(`Autosave failed for ${filePath}:`, err);
            }
        }, ProjectModel.AUTOSAVE_DELAY);

        this.#autosaveTimers.set(filePath, timer);
    }

    /** Cancel any pending autosave for the given file. */
    #cancelAutosave(filePath) {
        const timer = this.#autosaveTimers.get(filePath);
        if (timer) {
            clearTimeout(timer);
            this.#autosaveTimers.delete(filePath);
        }
    }

    /**
     * Sync editor content to the in-memory model without marking dirty.
     * Used when flushing editor state before tab switches — not a user edit.
     * @param {string} filePath
     * @param {string|object} content
     */
    syncFileContent(filePath, content) {
        const openFile = this.#openFiles.get(filePath);
        if (!openFile) return;
        openFile.content = content;
    }

    /**
     * Create a new file in the project.
     * @param {string} filePath Relative path
     * @param {string} fileType 'scenario'|'module'|'test'
     */
    async createFile(filePath, fileType, initialContent = undefined) {
        const api = window.pywebview?.api;
        const payload = {
            projectPath: this.#projectPath,
            filePath,
            fileType,
        };
        if (initialContent !== undefined) payload.content = initialContent;
        const result = await api.project_create_file(payload);
        if (!result.ok) throw new Error(result.error);

        // Update manifest file list
        this.#manifest.files.push({ path: filePath, type: fileType });
        await this.#saveManifest();

        // Refresh file list
        await this.refreshFiles();

        this.eventBus?.emit(EVENTS.FILE_CREATED, { filePath, fileType });

        // Open the newly created file
        return this.openFile(filePath);
    }

    /**
     * Delete a file from the project.
     * @param {string} filePath
     */
    async deleteFile(filePath) {
        const api = window.pywebview?.api;
        const result = await api.project_delete_file({
            projectPath: this.#projectPath,
            filePath,
        });
        if (!result.ok) throw new Error(result.error);

        // Close if open
        if (this.#openFiles.has(filePath)) {
            this.closeFile(filePath);
        }

        // Update manifest
        this.#manifest.files = this.#manifest.files.filter(f => f.path !== filePath);
        await this.#saveManifest();

        await this.refreshFiles();
        this.eventBus?.emit(EVENTS.FILE_DELETED, { filePath });
    }

    /**
     * Rename a file in the project.
     * @param {string} oldPath
     * @param {string} newPath
     */
    async renameFile(oldPath, newName) {
        const api = window.pywebview?.api;
        const result = await api.project_rename_file({
            projectPath: this.#projectPath,
            oldPath,
            newName,
        });
        if (!result.ok) throw new Error(result.error);

        const newPath = result.newPath;

        // Update manifest
        const entry = this.#manifest.files.find(f => f.path === oldPath);
        if (entry) entry.path = newPath;
        await this.#saveManifest();

        // Update open file reference
        if (this.#openFiles.has(oldPath)) {
            const openFile = this.#openFiles.get(oldPath);
            openFile.filePath = newPath;
            this.#openFiles.delete(oldPath);
            this.#openFiles.set(newPath, openFile);
            if (this.#activeFilePath === oldPath) {
                this.#activeFilePath = newPath;
            }
        }

        await this.refreshFiles();
        this.eventBus?.emit(EVENTS.FILE_RENAMED, { oldPath, newPath });
        return newPath;
    }

    /**
     * Duplicate a file in the project. Creates a "(copy)" variant and opens it.
     * @param {string} filePath Relative path within project
     */
    async duplicateFile(filePath) {
        const newPath = await this.duplicateFileSilent(filePath);
        return this.openFile(newPath);
    }

    /**
     * Duplicate a file without opening it. Returns the new relative path.
     * @param {string} filePath Relative path within project
     * @returns {Promise<string>} New relative path
     */
    async duplicateFileSilent(filePath) {
        const api = window.pywebview?.api;
        const result = await api.project_duplicate_file({
            projectPath: this.#projectPath,
            filePath,
        });
        if (!result.ok) throw new Error(result.error);

        const newPath = result.newPath;
        const fileType = this.#inferFileType(newPath);

        this.#manifest.files.push({ path: newPath, type: fileType });
        await this.#saveManifest();

        await this.refreshFiles();
        this.eventBus?.emit(EVENTS.FILE_CREATED, { filePath: newPath, fileType });

        return newPath;
    }

    /**
     * Reveal a project file in the OS file explorer.
     * @param {string} filePath Relative path within project
     */
    async revealInExplorer(filePath) {
        const api = window.pywebview?.api;
        if (!api) return;
        const absPath = this.#projectPath + '/' + filePath;
        await api.project_reveal_in_explorer({ path: absPath });
    }

    /**
     * Reveal the project root folder in the OS file explorer.
     */
    async revealProjectFolder() {
        const api = window.pywebview?.api;
        if (!api || !this.#projectPath) return;
        await api.project_reveal_in_explorer({ path: this.#projectPath });
    }

    /** Set the active file tab. */
    setActiveFile(filePath) {
        if (!this.#openFiles.has(filePath)) return;
        this.#activeFilePath = filePath;
        this.#persistState();
    }

    /**
     * Reload an open file's content from disk (discards in-memory edits).
     * @param {string} filePath Relative path within project
     */
    async reloadFileFromDisk(filePath) {
        if (!this.#openFiles.has(filePath)) return;

        const api = window.pywebview?.api;
        const result = await api.project_read_file({
            projectPath: this.#projectPath,
            filePath,
        });
        if (!result.ok) throw new Error(result.error);

        let content = result.content;
        if (result.isJson) {
            try { content = JSON.parse(content); } catch { /* keep as string */ }
        }

        const openFile = this.#openFiles.get(filePath);
        openFile.content = content;
        openFile.isDirty = false;

        this.eventBus?.emit(EVENTS.FILE_OPENED, openFile);
        this.eventBus?.emit(EVENTS.FILE_DIRTY, { filePath, isDirty: false });
    }

    /** Refresh file list from disk. */
    async refreshFiles() {
        const api = window.pywebview?.api;
        const result = await api.project_list_files({
            projectPath: this.#projectPath,
        });
        if (result.ok) {
            this.#files = result.files;
            this.eventBus?.emit(EVENTS.FILES_CHANGED, { files: this.#files });
        }
    }

    // ─── Internal ────────────────────────────────────────────

    async #loadProject(path, manifest) {
        // Close previous project if open
        if (this.isOpen) this.close();

        this.#projectPath = path;
        this.#manifest = manifest;

        // Scope the backend's workspace/scenario state to this project so that
        // sim_get_scenario_result and sim_list_scenarios return the right data.
        const api = window.pywebview?.api;
        if (api?.set_active_workspace) {
            try {
                await api.set_active_workspace({ workspaceId: path });
            } catch (e) {
                this.log.warn?.('Failed to set active workspace', e);
            }
        }

        // Persist project path immediately so that a crash between here and the
        // first openFile() call (which also persists) does not lose the reference.
        this.#persistState();

        await this.refreshFiles();

        this.eventBus?.emit(EVENTS.OPENED, { path, manifest });
        this.log.info?.(`Opened project: ${manifest.name} at ${path}`);

        addRecentProject(path, manifest.name);

        // Start file watcher
        this.#startWatcher();

        // Restore previously open tabs
        this.#restoreState();
    }

    async #startWatcher() {
        const api = window.pywebview?.api;
        if (!api?.project_start_watcher || !this.#projectPath) return;
        try {
            await api.project_start_watcher({ projectPath: this.#projectPath });
        } catch (e) {
            this.log.warn?.('Failed to start file watcher', e);
        }
    }

    async #stopWatcher() {
        const api = window.pywebview?.api;
        if (!api?.project_stop_watcher) return;
        try {
            await api.project_stop_watcher({});
        } catch (e) {
            this.log.warn?.('Failed to stop file watcher', e);
        }
    }

    async #onExternalFileChange({ type, filePath }) {
        if (!this.isOpen) return;
        this.log.info?.(`External file change: ${type} ${filePath}`);

        // Reload open file content from disk if the file was modified externally
        if ((type === 'modified' || type === 'created') && this.#openFiles.has(filePath)) {
            const openFile = this.#openFiles.get(filePath);
            // Skip if the file has unsaved user edits — user changes take priority
            if (!openFile.isDirty) {
                try {
                    await this.reloadFileFromDisk(filePath);
                    this.log.info?.(`Reloaded externally modified file: ${filePath}`);
                } catch (e) {
                    this.log.warn?.(`Failed to reload externally modified file: ${filePath}`, e);
                }
            }
        }

        this.eventBus?.emit(EVENTS.EXTERNAL_CHANGE, { filePath, changeType: type });

        // Refresh the file list for any change type
        this.refreshFiles();
    }

    async #saveManifest() {
        const api = window.pywebview?.api;
        await api.project_save_manifest({
            projectPath: this.#projectPath,
            manifest: this.#manifest,
        });
    }

    #inferFileType(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const map = {
            namespace: 'namespace',
            scenario: 'scenario',
            dashboard: 'dashboard',
            edf: 'module',
            esmp: 'module',
            test: 'test',
            orchestration: 'orchestration',
            pipeline: 'pipeline',
        };
        return map[ext] ?? 'unknown';
    }

    // ─── State persistence (localStorage) ────────────────────

    #persistState() {
        if (!this.#projectPath) {
            localStorage.removeItem('ecosim.project.state');
            return;
        }
        const state = {
            projectPath: this.#projectPath,
            openFiles: [...this.#openFiles.keys()],
            activeFile: this.#activeFilePath,
        };
        localStorage.setItem('ecosim.project.state', JSON.stringify(state));
    }

    async #restoreState() {
        try {
            const raw = localStorage.getItem('ecosim.project.state');
            if (!raw) return;

            const state = JSON.parse(raw);
            if (state.projectPath !== this.#projectPath) return;

            // Reopen previously open files
            for (const filePath of state.openFiles ?? []) {
                try {
                    await this.openFile(filePath);
                } catch (e) {
                    this.log.warn?.(`Could not restore file: ${filePath}`, e);
                }
            }

            // Restore active tab
            if (state.activeFile && this.#openFiles.has(state.activeFile)) {
                this.#activeFilePath = state.activeFile;
            }
        } catch (e) {
            this.log.warn?.('Failed to restore project state', e);
        }
    }

    /** Restore last project on app startup. */
    async restoreLastProject() {
        try {
            const raw = localStorage.getItem('ecosim.project.state');
            if (!raw) return false;

            const state = JSON.parse(raw);
            if (!state.projectPath) return false;

            await this.open(state.projectPath);
            return true;
        } catch {
            return false;
        }
    }
}
