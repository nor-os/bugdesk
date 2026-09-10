#!/usr/bin/env node
/**
 * sync-flexdesk.mjs — refresh `ui/vendor/flexdesk/` from the installed
 * `flexdesk` npm package.
 *
 *   npm run sync:flexdesk     copy node_modules/flexdesk -> ui/vendor/flexdesk
 *   npm run check:flexdesk    verify the vendored copy matches, change nothing
 *
 * WHY VENDOR AT ALL, if it comes from npm?
 *
 * BugDesk's UI has no build step: `ui/index.html` loads ES modules straight
 * from disk through an import map, and the C# bridge serves `ui/` as static
 * files. `node_modules/` is not on that served tree and its layout is not
 * something an import map should encode, so the shipped bytes live under
 * `ui/vendor/flexdesk/` and are committed — same as every other vendored
 * dependency in `ui/vendor/`. npm decides WHICH bytes; this script moves them.
 *
 * That makes the vendored copy reproducible instead of hand-copied: the
 * version is pinned in package.json, recorded in `ui/vendor/flexdesk/VERSION`,
 * and `--check` fails loudly when the two have drifted (a stale vendor dir is
 * otherwise invisible — the app boots fine on old code).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(root, 'node_modules', 'flexdesk');
const vendorDir = join(root, 'ui', 'vendor', 'flexdesk');
const check = process.argv.includes('--check');

/** Files copied out of the package, relative to its own root. `dist/` is
 *  flattened into the vendor directory because that is what the import map
 *  points at ("./vendor/flexdesk/core.js", not ".../dist/core.js"). */
const FLATTEN_FROM = 'dist';
const EXTRA_FILES = ['LICENSE', 'THIRD_PARTY_LICENSES.md'];

function die(msg) {
    console.error(`sync-flexdesk: ${msg}`);
    process.exit(1);
}

if (!existsSync(pkgDir)) {
    die('node_modules/flexdesk is missing — run `npm install` first.');
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const distDir = join(pkgDir, FLATTEN_FROM);
if (!existsSync(distDir)) {
    die(`the installed flexdesk@${pkg.version} has no ${FLATTEN_FROM}/ — nothing to vendor.`);
}

/** Every file the package contributes, as `[vendorRelativeName, sourcePath]`. */
function sources() {
    const out = [];
    for (const name of readdirSync(distDir).sort()) {
        const src = join(distDir, name);
        if (statSync(src).isFile()) out.push([name, src]);
    }
    for (const name of EXTRA_FILES) {
        const src = join(pkgDir, name);
        if (existsSync(src)) out.push([name, src]);
    }
    return out;
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const versionStamp = () =>
    `flexdesk ${pkg.version}\n` +
    `vendored from node_modules/flexdesk/${FLATTEN_FROM} by scripts/sync-flexdesk.mjs\n` +
    'Do not hand-edit these files — run `npm run sync:flexdesk` instead.\n';

const files = sources();
const versionPath = join(vendorDir, 'VERSION');

if (check) {
    // Report EVERY difference, not the first: "you are three files behind" is
    // actionable, "file X differs" invites a one-file fix that leaves the rest
    // stale.
    const problems = [];
    const expected = new Set(['VERSION']);
    for (const [name, src] of files) {
        expected.add(name);
        const dst = join(vendorDir, name);
        if (!existsSync(dst)) problems.push(`missing: ${name}`);
        else if (sha(dst) !== sha(src)) problems.push(`differs: ${name}`);
    }
    if (existsSync(vendorDir)) {
        for (const name of readdirSync(vendorDir)) {
            if (!expected.has(name)) problems.push(`stale (not in the package): ${name}`);
        }
    }
    const stamped = existsSync(versionPath) ? readFileSync(versionPath, 'utf8') : '';
    if (stamped !== versionStamp()) {
        problems.push(`VERSION says "${stamped.split('\n')[0] || '(absent)'}", package is flexdesk ${pkg.version}`);
    }
    if (problems.length) {
        console.error(`sync-flexdesk: ui/vendor/flexdesk is out of date with flexdesk@${pkg.version}:`);
        for (const p of problems) console.error(`  ${p}`);
        console.error('Run `npm run sync:flexdesk` to refresh it.');
        process.exit(1);
    }
    console.log(`sync-flexdesk: ui/vendor/flexdesk matches flexdesk@${pkg.version} (${files.length} files).`);
    process.exit(0);
}

// Replace wholesale rather than merge: a file DROPPED by a new flexdesk
// release would otherwise linger forever, and a lingering chunk-*.js is
// exactly the kind of thing that loads fine and serves last release's code.
rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
for (const [name, src] of files) copyFileSync(src, join(vendorDir, name));
writeFileSync(versionPath, versionStamp());

console.log(`sync-flexdesk: vendored flexdesk@${pkg.version} -> ${relative(root, vendorDir)} (${files.length} files).`);
