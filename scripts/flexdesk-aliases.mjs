/**
 * flexdesk-aliases.mjs — the import map, for Node.
 *
 * Node has no import map, so every test script that imports the UI needs
 * `@flexdesk/<entry>` to resolve some other way. This writes one alias package
 * per entry of the import map in ui/index.html, each re-exporting the vendored
 * file the map points at. Reading the map is what keeps the two from disagreeing,
 * and writing them all is what keeps a script from depending on which script ran
 * before it. `npm install` prunes them, so they are checked each time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function installFlexdeskAliases() {
    const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
    for (const [, name] of html.matchAll(/"@flexdesk\/(\w+)":\s*"\.\/vendor\/flexdesk\/\1\.js"/g)) {
        const dir = join(ROOT, 'node_modules', '@flexdesk', name);
        if (existsSync(join(dir, 'index.js'))) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify(
            { name: `@flexdesk/${name}`, version: '0.0.0-local-alias', type: 'module', main: 'index.js' }, null, 2));
        writeFileSync(join(dir, 'index.js'),
            // Relative, so the alias works for Linux and Windows node alike.
            `export * from '../../../ui/vendor/flexdesk/${name}.js';\n`);
    }
}
