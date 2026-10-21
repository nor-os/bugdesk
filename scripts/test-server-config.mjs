/**
 * test-server-config.mjs — a project's settings folder named in projects.toml
 * (STORY-0060), against the REAL server.
 *
 * WHY A SEPARATE SCRIPT. `npm test` never invokes dotnet (see
 * record-fixtures.mjs): it stays a node-only run. This one builds the server
 * into a temporary folder, starts it on a free loopback port over a throwaway
 * layout, and talks to it over HTTP — so it is `npm run test:server`, run on
 * purpose and by anything that changes how a store finds its settings.
 *
 * THE LAYOUT. Two git checkouts, each with a COMMITTED legacy root
 * `bugdesk.json` and a committed `.bugdesk/project.json`:
 *   hosted  — `config = '<outside>'` in projects.toml: the host keeps its
 *             settings out of the checkout. Every write must land there, and
 *             `git status` in the checkout must stay empty.
 *   plain   — no `config`: exactly as before, the legacy root file wins.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'bugdesk-config-'));

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};

function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
}

const ROSTER = (who) => JSON.stringify({ collaborators: [{ name: who, agent: `${who}_agent`, added: '2026-01-01' }] }, null, 2) + '\n';

function checkout(name) {
    const dir = join(TMP, name);
    mkdirSync(join(dir, 'bugs'), { recursive: true });
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    mkdirSync(join(dir, '.bugdesk'), { recursive: true });
    writeFileSync(join(dir, 'bugdesk.json'), ROSTER('legacy'));
    writeFileSync(join(dir, '.bugdesk', 'project.json'), ROSTER('tracked'));
    writeFileSync(join(dir, 'bugs', 'BUG-0001.md'), '---\nid: 1\ntitle: "One"\nstatus: open\n---\n\nbody\n');
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return dir;
}

const freePort = () => new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const hosted = checkout('hosted');
const plain = checkout('plain');
const outside = join(TMP, 'host', 'hosted');   // the host's folder; BugDesk creates it
const toml = join(TMP, 'projects.toml');
writeFileSync(toml, [
    '[user]', "name = 'alice'", '',
    '[projects.hosted]', `bugs = '${join(hosted, 'bugs')}'`, `backlog = '${join(hosted, 'backlog')}'`, `config = '${outside}'`, '',
    '[projects.plain]', `bugs = '${join(plain, 'bugs')}'`, `backlog = '${join(plain, 'backlog')}'`, '',
].join('\n'));

console.log('building the server …');
const artifacts = join(TMP, 'artifacts');
const build = spawnSync('dotnet', ['build', join(ROOT, 'server'), '-c', 'Release', '--nologo', '-v', 'q', '--artifacts-path', artifacts],
    { encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout, build.stderr); process.exit(1); }
const dll = join(artifacts, 'bin', 'BugDesk.Server', 'release', 'BugDesk.Server.dll');

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn('dotnet', [dll], {
    cwd: TMP,
    env: { ...process.env, BUGDESK_PROJECTS: toml, BUGDESK_STATE: join(TMP, 'state'),
           ASPNETCORE_URLS: base, BUGDESK_TRACKER_HOME: join(TMP, 'trackers') },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

async function up() {
    for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`${base}/api/projects`)).ok) return; } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the server did not answer:\n${log}`);
}

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
};
const clean = (dir) => git(dir, 'status', '--porcelain=v1', '-uall').trim();

try {
    await up();

    await t('a configured folder is the project.json in force, over the legacy root file', async () => {
        const p = await get('/p/hosted/api/project');
        assert.equal(p.path, join(outside, 'project.json'));
        assert.ok(!(p.assignees || []).includes('legacy'), 'the legacy roster must not be read');
        assert.ok(!(p.assignees || []).includes('tracked'), "the checkout's .bugdesk/project.json must not be read");
    });

    await t('a settings write lands in the configured folder; the checkout stays clean', async () => {
        const r = await post('/p/hosted/api/project/collaborators', { collaborators: [{ name: 'bob', agent: 'bob_agent' }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const doc = JSON.parse(readFileSync(join(outside, 'project.json'), 'utf8'));
        assert.ok(doc.collaborators.some((c) => c.name === 'bob'));
        assert.equal(readFileSync(join(hosted, 'bugdesk.json'), 'utf8'), ROSTER('legacy'));
        assert.equal(readFileSync(join(hosted, '.bugdesk', 'project.json'), 'utf8'), ROSTER('tracked'));
        assert.equal(clean(hosted), '');
    });

    await t('the per-user files go to the configured folder too', async () => {
        assert.ok(existsSync(join(outside, 'active.json')) || existsSync(join(outside, 'user-alice.json')),
            'a profile in the configured folder');
        assert.ok(!existsSync(join(hosted, '.bugdesk', 'active.json')), 'no profile in the checkout');
    });

    await t('the Changes pane still names changes when the folder is outside the repo', async () => {
        writeFileSync(join(hosted, 'bugs', 'notes.txt'), 'not a record\n');
        const g = await get('/p/hosted/api/git');
        assert.ok((g.others || []).includes('bugs/notes.txt'), JSON.stringify(g.others));
        rmSync(join(hosted, 'bugs', 'notes.txt'));
    });

    await t('without config nothing changes: the legacy root bugdesk.json still wins', async () => {
        const p = await get('/p/plain/api/project');
        assert.equal(p.path, join(plain, 'bugdesk.json'));
        const r = await post('/p/plain/api/project/collaborators', { collaborators: [{ name: 'carol', agent: 'carol_agent' }] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(JSON.parse(readFileSync(join(plain, 'bugdesk.json'), 'utf8')).collaborators.some((c) => c.name === 'carol'));
    });
} finally {
    server.kill('SIGTERM');
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000); });
    rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
