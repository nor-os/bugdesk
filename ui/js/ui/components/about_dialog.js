/**
 * About Dialog Component
 * Location: ui/components/about_dialog.js
 *
 * Purpose: Show EcoAgent version, license, GitHub link, and third-party credits.
 * Uses ManagedWindow modal following the confirm_dialog.js pattern.
 */

import { ManagedWindow } from './managed_window.js';

const GITHUB_URL = 'https://github.com/nor-os/EcoAgent';
const LICENSE = 'MPL-2.0';
const VERSION = '0.1';
const PRODUCT_NAME = 'EcoAgent';
const TAGLINE = 'Heterogeneous-agent, stock-flow-consistent macroeconomic simulation';

const PYTHON_DEPS = [
    { name: 'NumPy', license: 'BSD-3-Clause', url: 'https://numpy.org' },
    { name: 'SciPy', license: 'BSD-3-Clause', url: 'https://scipy.org' },
    { name: 'pandas', license: 'BSD-3-Clause', url: 'https://pandas.pydata.org' },
    { name: 'pywebview', license: 'BSD-3-Clause', url: 'https://pywebview.flowrl.com' },
    { name: 'Flask', license: 'BSD-3-Clause', url: 'https://flask.palletsprojects.com' },
];

const FRONTEND_DEPS = [
    { name: 'CodeMirror 6', license: 'MIT', url: 'https://codemirror.net' },
    { name: 'Monaco Editor', license: 'MIT', url: 'https://microsoft.github.io/monaco-editor' },
    { name: 'Plotly.js', license: 'MIT', url: 'https://plotly.com/javascript' },
    { name: 'KaTeX', license: 'MIT', url: 'https://katex.org' },
    { name: 'Material Symbols', license: 'Apache 2.0', url: 'https://fonts.google.com/icons' },
];

function createExternalLink(text, url, className) {
    const a = document.createElement('a');
    a.className = className;
    a.textContent = text;
    a.href = url;
    a.title = url;
    a.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(url, '_blank');
    });
    return a;
}

function buildDepSection(title, deps) {
    const section = document.createElement('div');
    section.className = 'about-dialog__section';

    const heading = document.createElement('div');
    heading.className = 'about-dialog__section-title';
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'about-dialog__dep-list';

    for (const dep of deps) {
        const row = document.createElement('div');
        row.className = 'about-dialog__dep';

        const link = createExternalLink(dep.name, dep.url, 'about-dialog__dep-name');
        row.appendChild(link);

        const lic = document.createElement('span');
        lic.className = 'about-dialog__dep-license';
        lic.textContent = dep.license;
        row.appendChild(lic);

        list.appendChild(row);
    }

    section.appendChild(list);
    return section;
}

/**
 * Show the About EcoAgent dialog.
 * @returns {Promise<void>} Resolves when the dialog is closed.
 */
export function showAboutDialog() {
    return new Promise((resolve) => {
        let resolved = false;

        const finish = () => {
            if (resolved) return;
            resolved = true;
            dialogWindow.close();
            resolve();
        };

        // --- Content ---
        const contentEl = document.createElement('div');
        contentEl.className = 'about-dialog__content';

        // Header
        const header = document.createElement('div');
        header.className = 'about-dialog__header';

        const logo = document.createElement('span');
        logo.className = 'about-dialog__logo material-symbols-outlined';
        logo.textContent = 'account_balance';
        header.appendChild(logo);

        const title = document.createElement('h2');
        title.className = 'about-dialog__title';
        title.textContent = PRODUCT_NAME;
        header.appendChild(title);

        const version = document.createElement('div');
        version.className = 'about-dialog__version';
        version.textContent = `Version ${VERSION}`;
        header.appendChild(version);

        const tagline = document.createElement('div');
        tagline.className = 'about-dialog__tagline';
        tagline.textContent = TAGLINE;
        header.appendChild(tagline);

        contentEl.appendChild(header);

        // Body (scrollable)
        const body = document.createElement('div');
        body.className = 'about-dialog__body';

        // Project section
        const projectSection = document.createElement('div');
        projectSection.className = 'about-dialog__section';

        const projectTitle = document.createElement('div');
        projectTitle.className = 'about-dialog__section-title';
        projectTitle.textContent = 'Project';
        projectSection.appendChild(projectTitle);

        const links = document.createElement('div');
        links.className = 'about-dialog__links';

        const ghLink = createExternalLink('GitHub Repository', GITHUB_URL, 'about-dialog__link');
        const ghIcon = document.createElement('span');
        ghIcon.className = 'material-symbols-outlined';
        ghIcon.textContent = 'open_in_new';
        ghLink.prepend(ghIcon);
        links.appendChild(ghLink);

        const licenseSpan = document.createElement('span');
        licenseSpan.className = 'about-dialog__license-text';
        const licIcon = document.createElement('span');
        licIcon.className = 'material-symbols-outlined';
        licIcon.textContent = 'license';
        licenseSpan.appendChild(licIcon);
        licenseSpan.appendChild(document.createTextNode(`License: ${LICENSE}`));
        links.appendChild(licenseSpan);

        projectSection.appendChild(links);
        body.appendChild(projectSection);

        // Dependency sections
        body.appendChild(buildDepSection('Python Backend', PYTHON_DEPS));
        body.appendChild(buildDepSection('Frontend JavaScript', FRONTEND_DEPS));

        contentEl.appendChild(body);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'about-dialog__footer';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'about-dialog__btn about-dialog__btn--close';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', finish);
        footer.appendChild(closeBtn);

        contentEl.appendChild(footer);

        // --- Window ---
        const dialogWindow = new ManagedWindow({
            id: 'about-dialog',
            title: `About ${PRODUCT_NAME}`,
            icon: 'info',
            content: contentEl,
            minWidth: 420,
            minHeight: 400,
            defaultWidth: 460,
            defaultHeight: 540,
            canMinimize: false,
            canMaximize: false,
            canResize: false,
            canDrag: false,
            modal: true,
            onClose: () => {
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            },
        });

        dialogWindow.show();

        requestAnimationFrame(() => {
            closeBtn.focus();
        });
    });
}
