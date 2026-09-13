/**
 * boot.js — BugDesk's application boot: the settings, the bus, the logger, and
 * the two bars the tiling shell mounts between.
 *
 * WHAT THIS REPLACED. `app_bootstrap.js`, 1602 lines, was the boot of the
 * economic simulator BugDesk was built out of, and it still ran every time
 * BugDesk opened: a DataManager, an expression service, a user-module registry
 * and loader, a DSL symbol registry, a data hub, an undo/redo bridge to a
 * file journal, a workspace state machine with import and save controllers,
 * recent files and projects, a project model, a history service, a state guard
 * and an AI project applier — to host a bug tracker that reads markdown files.
 * Of all of it, BugDesk used four things: the settings registration, the event
 * bus, the logger, and the markup of the top and bottom bars. That is what this
 * file is, and nothing else.
 *
 * The bars keep their existing class names and element ids (`.global-top-bar`,
 * `.bar-center`, `#toggle-left-panel`, `#sim-status`, the Help menu entries…)
 * because the tiling shell and every page's status line address them by those
 * names. What is gone from them is what nothing ever wrote to: the project chip,
 * a hidden file input for opening workspace JSON, and a debug indicator.
 */

import { EventBus, LoggingService } from '@flexdesk/core';
// Imported for its side effect as well: TooltipService initialises itself when
// the module is evaluated, so there is no init() to call — calling one anyway
// would bind every tooltip listener twice.
import { showAboutDialog } from '@flexdesk/widgets';
import { registerSettings, registerSettingsEventBus, BUGDESK_SETTINGS_SLICE } from '../core/settings.js';
import { HelpModal } from '../help/help_modal.js';

/**
 * Boot BugDesk up to the point where the tiling shell can be installed.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.enableConsoleLogging]
 * @returns {{eventBus: EventBus, loggingService: LoggingService}}
 */
export function bootBugDesk({ enableConsoleLogging = false } = {}) {
    // The settings slice has to be registered BEFORE anything reads or writes a
    // setting, or the first write persists against a schema that does not know
    // the key — see registerSettings in @flexdesk/core.
    registerSettings(BUGDESK_SETTINGS_SLICE);

    const eventBus = new EventBus();
    registerSettingsEventBus(eventBus);

    const loggingService = new LoggingService({
        name: 'bugdesk',
        eventBus,
        enableConsole: enableConsoleLogging,
    });

    buildTopBar();
    buildBottomBar();

    return { eventBus, loggingService };
}

/**
 * The top bar: brand and Help on the left, page shortcuts in the centre, the
 * panel toggles on the right.
 *
 * The Help dropdown is built even though it is never shown as a dropdown: the
 * tiling shell folds its entries into the hamburger menu and hides the menu bar,
 * and it finds the entries by reading this markup and clicking them by id. So
 * the entries carry their own handlers here, and the hamburger stays generic.
 */
function buildTopBar() {
    const bar = document.createElement('div');
    bar.className = 'global-top-bar';
    bar.innerHTML = `
        <div class="bar-left">
            <nav class="app-menu" aria-label="Application menu">
                <span class="ecoagent-brand" style="font-weight:600; padding:0 10px; letter-spacing:0.04em; color:#ddd;">BugDesk</span>
                <div class="menu-item" tabindex="0">
                    <span>Help</span>
                    <div class="menu-dropdown">
                        <button class="menu-entry" id="menu-help-topics">Help Topics</button>
                        <hr class="menu-sep" />
                        <button class="menu-entry" id="menu-help-about">About BugDesk</button>
                    </div>
                </div>
            </nav>
        </div>
        <div class="bar-center"></div>
        <div class="bar-right">
            <div class="panel-toggles">
                <button class="panel-toggle-btn has-tooltip" id="toggle-left-panel" data-tooltip="Toggle Left Panel · per desktop" data-tooltip-placement="bottom" aria-label="Toggle Left Panel">
                    <span class="material-symbols-outlined">dock_to_left</span>
                </button>
                <button class="panel-toggle-btn has-tooltip" id="toggle-bottom-panel" data-tooltip="Toggle Bottom Panel · per desktop" data-tooltip-placement="bottom" aria-label="Toggle Bottom Panel">
                    <span class="material-symbols-outlined">dock_to_bottom</span>
                </button>
                <button class="panel-toggle-btn has-tooltip" id="toggle-right-panel" data-tooltip="Toggle Right Panel · per desktop" data-tooltip-placement="bottom" aria-label="Toggle Right Panel">
                    <span class="material-symbols-outlined">dock_to_right</span>
                </button>
            </div>
        </div>`;
    bar.querySelector('#menu-help-topics').addEventListener('click', () => HelpModal.open());
    bar.querySelector('#menu-help-about').addEventListener('click', () => showAboutDialog({ name: 'BugDesk' }));
    document.body.appendChild(bar);
    // No F1 binding, and no "F1" hint on Help Topics. The entry used to advertise
    // one, but FlexDesk's keymap owns F1..F8 as "jump to the Nth page", so F1 has
    // always taken you to the first page rather than to help. A second listener
    // here would make one key do both.
}

/**
 * The bottom bar: the status line on the left, and a right-hand section the
 * tiling shell fills with the user chip, the desktop strip and the zoom.
 *
 * `#sim-status` keeps its old id on purpose: `statusLine()` in every page writes
 * the result of a save or a transition there, and renaming it would silence all
 * of them at once with nothing reporting the change.
 */
function buildBottomBar() {
    const bar = document.createElement('div');
    bar.className = 'global-bottom-bar';
    bar.innerHTML = `
        <div class="bar-left">
            <div class="sim-status is-info" id="sim-status">BugDesk ready.</div>
        </div>
        <div class="bar-center"></div>
        <div class="bar-right"></div>`;
    document.body.appendChild(bar);
}
