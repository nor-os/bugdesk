/**
 * test-server-host-secret.mjs — BUGDESK_HOST_SECRET (STORY-0059), against the
 * REAL server.
 *
 * Like test-server-config.mjs this builds the server into a temporary folder
 * and talks to it over HTTP, so it is part of `npm run test:server`, not of
 * `npm test`. It starts the server three times over the same throwaway
 * project: with a secret, with the setting empty, and without it.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'bugdesk-secret-'));
const HEADER = 'X-BugDesk-Host-Secret';
// Generated here, never printed: a failure message shows statuses and bodies,
// and the tests below check that no body contains it.
const SECRET = randomBytes(32).toString('base64url');

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message.replaceAll(SECRET, '<secret>')}`); fail++; }
};

const repo = join(TMP, 'alpha');
mkdirSync(join(repo, 'bugs'), { recursive: true });
mkdirSync(join(repo, 'backlog'), { recursive: true });
writeFileSync(join(repo, 'bugs', 'BUG-0001.md'), '---\nid: 1\ntitle: "One"\nstatus: open\n---\n\nbody\n');
spawnSync('git', ['init', '-q'], { cwd: repo });
const toml = join(TMP, 'projects.toml');
writeFileSync(toml, [
    '[user]', "name = 'alice'", '',
    '[projects.alpha]', `bugs = '${join(repo, 'bugs')}'`, `backlog = '${join(repo, 'backlog')}'`, '',
].join('\n'));

console.log('building the server …');
const artifacts = join(TMP, 'artifacts');
const build = spawnSync('dotnet', ['build', join(ROOT, 'server'), '-c', 'Release', '--nologo', '-v', 'q', '--artifacts-path', artifacts],
    { encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout, build.stderr); process.exit(1); }
const dll = join(artifacts, 'bin', 'BugDesk.Server', 'release', 'BugDesk.Server.dll');

const freePort = () => new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Start the server with `secret` as BUGDESK_HOST_SECRET (undefined: unset). */
async function start(secret) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, BUGDESK_PROJECTS: toml, BUGDESK_STATE: join(TMP, 'state'),
                  ASPNETCORE_URLS: base, BUGDESK_TRACKER_HOME: join(TMP, 'trackers') };
    delete env.BUGDESK_HOST_SECRET;
    if (secret !== undefined) env.BUGDESK_HOST_SECRET = secret;
    // From server/, so the build in TMP still finds ../ui and serves the pages.
    const proc = spawn('dotnet', [dll], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const srv = { base, proc, log: '' };
    proc.stdout.on('data', (d) => { srv.log += d; });
    proc.stderr.on('data', (d) => { srv.log += d; });
    const headers = secret ? { [HEADER]: secret } : {};
    for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`${base}/api/projects`, { headers })).ok) return srv; } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the server did not answer:\n${srv.log}`);
}

async function stop(srv) {
    srv.proc.kill('SIGTERM');
    await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
}

/** A request's status and body text; redirects are reported, not followed. */
async function req(srv, path, { secret, method = 'GET', body } = {}) {
    const headers = {};
    if (secret !== undefined) headers[HEADER] = secret;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(srv.base + path, { method, headers, redirect: 'manual',
        body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
}

/** The first chunk of the event stream, or the refusal. */
async function events(srv, secret) {
    const ctl = new AbortController();
    const r = await fetch(`${srv.base}/p/alpha/api/events`,
        { headers: secret === undefined ? {} : { [HEADER]: secret }, signal: ctl.signal });
    try {
        if (!r.ok) return { status: r.status, text: await r.text() };
        const { value } = await r.body.getReader().read();
        return { status: r.status, type: r.headers.get('content-type'), text: new TextDecoder().decode(value) };
    } finally { ctl.abort(); }
}

// Every kind of request the port answers: the API (reads and writes), the
// stream, and the UI's own pages and scripts.
const PATHS = ['/', '/p/alpha/', '/p/alpha/index.html', '/p/alpha/js/ticketdesk/embed.js', '/css/tokens.css',
               '/api/projects', '/p/alpha/api/config', '/p/alpha/api/bugs', '/p/nope/api/config', '/t/'];
const NEW_BUG = { title: 'Filed through the port', description: 'x' };
const bugFiles = () => ['BUG-0002.md', 'BUG-0003.md'].filter((f) => existsSync(join(repo, 'bugs', f)));

try {
    // ---- with the secret ----------------------------------------------------
    let srv = await start(SECRET);
    try {
        await t('on: without the header every request gets 401 and no data', async () => {
            for (const p of PATHS) {
                const r = await req(srv, p);
                assert.equal(r.status, 401, `${p} → ${r.status}`);
                const body = JSON.parse(r.text);
                assert.deepEqual(Object.keys(body).sort(), ['error', 'ok'], `${p}: ${r.text}`);
                assert.equal(body.ok, false);
            }
            assert.equal((await events(srv)).status, 401, '/api/events');
        });

        await t('on: a wrong secret is refused like a missing one, the empty string included', async () => {
            const wrong = [SECRET.slice(0, -1) + (SECRET.endsWith('A') ? 'B' : 'A'), SECRET + 'x', 'nope', ''];
            for (const w of wrong) {
                for (const p of PATHS) assert.equal((await req(srv, p, { secret: w })).status, 401, p);
                assert.equal((await events(srv, w)).status, 401, '/api/events');
            }
        });

        await t('on: a refused write writes nothing', async () => {
            const r = await req(srv, '/p/alpha/api/bugs', { method: 'POST', body: NEW_BUG });
            assert.equal(r.status, 401, r.text);
            assert.deepEqual(bugFiles(), []);
        });

        await t('on: the right secret is answered as if the setting were unset', async () => {
            assert.equal((await req(srv, '/', { secret: SECRET })).status, 302);
            for (const p of ['/p/alpha/', '/p/alpha/js/ticketdesk/embed.js', '/css/tokens.css', '/api/projects',
                             '/p/alpha/api/config', '/p/alpha/api/bugs'])
                assert.equal((await req(srv, p, { secret: SECRET })).status, 200, p);
            assert.equal((await req(srv, '/p/nope/api/config', { secret: SECRET })).status, 404);
            const w = await req(srv, '/p/alpha/api/bugs', { secret: SECRET, method: 'POST', body: NEW_BUG });
            assert.equal(w.status, 200, w.text);
            assert.equal(bugFiles().length, 1);
        });

        await t('on: the event stream flows with the right secret', async () => {
            const r = await events(srv, SECRET);
            assert.equal(r.status, 200, r.text);
            assert.match(r.type, /text\/event-stream/);
            assert.match(r.text, /: connected/);
        });

        await t('on: the secret appears in no response and not in the log; the mode is announced once', async () => {
            for (const p of [...PATHS, '/p/alpha/api/project', '/p/alpha/api/meta']) {
                assert.ok(!(await req(srv, p, { secret: SECRET })).text.includes(SECRET), p);
                assert.ok(!(await req(srv, p, { secret: 'nope' })).text.includes(SECRET), p);
            }
            assert.ok(!srv.log.includes(SECRET), 'the log names the secret');
            const lines = srv.log.split('\n').filter((l) => l.includes('host-secret mode is on'));
            assert.equal(lines.length, 1, 'announced once');
            assert.ok(lines[0].includes(HEADER), 'names the header');
        });
    } finally { await stop(srv); }

    // ---- empty and unset ----------------------------------------------------
    for (const [label, value] of [['empty', ''], ['blank', '   '], ['unset', undefined]]) {
        srv = await start(value);
        try {
            await t(`${label}: nothing changes, with or without the header`, async () => {
                for (const secret of [undefined, SECRET, 'anything']) {
                    assert.equal((await req(srv, '/', { secret })).status, 302);
                    for (const p of ['/p/alpha/', '/css/tokens.css', '/api/projects', '/p/alpha/api/config', '/p/alpha/api/bugs'])
                        assert.equal((await req(srv, p, { secret })).status, 200, `${p} (${secret === undefined ? 'no header' : 'header'})`);
                    assert.match((await events(srv, secret)).text, /: connected/);
                }
                assert.ok(!srv.log.includes('host-secret mode'), 'no announcement');
            });
        } finally { await stop(srv); }
    }
} finally {
    rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
