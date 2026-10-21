/**
 * test-server-identity.mjs — a host names the signed-in user per request
 * (STORY-0058, BUGDESK_TRUSTED_USER_HEADER), against the REAL server.
 *
 * Run on purpose, like test-server-config.mjs (`npm run test:server`): it
 * builds the server into a temporary folder and starts it three times over
 * throwaway layouts —
 *   off     the setting unset: the header means nothing.
 *   on      the setting on, listening on 127.0.0.1: the header names the user.
 *   open    the setting on, listening on 0.0.0.0: the header is NOT honoured,
 *           and the log says so once.
 * The process user is alice in all three (projects.toml [user]).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'bugdesk-identity-'));
const HEADER = 'X-AIDesk-User';

let pass = 0, fail = 0;
const t = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};

const freePort = () => new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

console.log('building the server …');
const artifacts = join(TMP, 'artifacts');
const build = spawnSync('dotnet', ['build', join(ROOT, 'server'), '-c', 'Release', '--nologo', '-v', 'q', '--artifacts-path', artifacts],
    { encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stdout, build.stderr); process.exit(1); }
const dll = join(artifacts, 'bin', 'BugDesk.Server', 'release', 'BugDesk.Server.dll');

/** One server over its own project `demo`, with alice as the process user. */
async function start(name, { trusted, bind = '127.0.0.1' }) {
    const dir = join(TMP, name);
    const project = join(dir, 'demo');
    const config = join(dir, 'config');
    mkdirSync(join(project, 'bugs'), { recursive: true });
    mkdirSync(join(project, 'backlog'), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(project, 'bugs', 'BUG-0001.md'), '---\nid: 1\ntitle: "One"\nstatus: open\nassignee:\nreporter: alice\n---\n\nbody\n');
    // carol's profile names her own assistant: a header user keeps it.
    writeFileSync(join(config, 'user-carol.json'), JSON.stringify({ slug: 'carol', name: 'carol', agentName: 'helper' }));
    const toml = join(dir, 'projects.toml');
    writeFileSync(toml, [
        '[user]', "name = 'alice'", '',
        '[projects.demo]', `bugs = '${join(project, 'bugs')}'`, `backlog = '${join(project, 'backlog')}'`, `config = '${config}'`, '',
    ].join('\n'));
    const port = await freePort();
    const env = { ...process.env, BUGDESK_PROJECTS: toml, BUGDESK_STATE: join(dir, 'state'),
                  ASPNETCORE_URLS: `http://${bind}:${port}`, BUGDESK_TRACKER_HOME: join(dir, 'trackers') };
    for (const k of Object.keys(env)) if (k.startsWith('BUGDESK_') && !['BUGDESK_PROJECTS', 'BUGDESK_STATE', 'BUGDESK_TRACKER_HOME'].includes(k)) delete env[k];
    if (trusted) env.BUGDESK_TRUSTED_USER_HEADER = trusted;
    const proc = spawn('dotnet', [dll], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const s = { proc, dir, project, config, toml, base: `http://127.0.0.1:${port}/p/demo`, log: '' };
    proc.stdout.on('data', (d) => { s.log += d; });
    proc.stderr.on('data', (d) => { s.log += d; });
    for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/api/projects`)).ok) return s; } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the ${name} server did not answer:\n${s.log}`);
}

const as = (user) => (user === undefined ? {} : { [HEADER]: user });
async function call(s, method, path, user, body) {
    const headers = { ...as(user) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(s.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
}
const get = (s, path, user) => call(s, 'GET', path, user);
const post = (s, path, user, body) => call(s, 'POST', path, user, body);

const servers = [];
try {
    const off = await start('off', {});
    servers.push(off);
    const on = await start('on', { trusted: HEADER });
    servers.push(on);
    const open = await start('open', { trusted: HEADER, bind: '0.0.0.0' });
    servers.push(open);

    await t('setting unset: a request carrying the header is still the process user', async () => {
        const c = (await get(off, '/api/config', 'bob')).body;
        assert.equal(c.humanAuthor, 'alice');
        assert.equal(c.user, 'alice');
        const r = await post(off, '/api/bugs', 'bob', { title: 'filed with a header' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.match(readFileSync(join(off.project, 'bugs', 'BUG-0002.md'), 'utf8'), /^reporter: alice$/m);
        assert.ok(!existsSync(join(off.config, 'user-bob.json')), 'no profile for a header nobody trusts');
    });

    await t('setting on, loopback: /api/config is the header user, per request', async () => {
        const bob = (await get(on, '/api/config', 'bob')).body;
        assert.equal(bob.humanAuthor, 'bob');
        assert.equal(bob.agentAuthor, 'bob_agent');
        assert.equal(bob.user, 'bob');
        assert.equal(bob.configured, true);
        const carol = (await get(on, '/api/config', 'carol')).body;
        assert.equal(carol.humanAuthor, 'carol');
        assert.equal(carol.agentAuthor, 'helper', "carol's profile names her agent");
        assert.equal((await get(on, '/api/config')).body.humanAuthor, 'alice');
    });

    await t('setting on: a missing or empty header is the process user, never blank', async () => {
        for (const user of [undefined, '', '   ']) {
            const c = await get(on, '/api/config', user);
            assert.equal(c.status, 200);
            assert.equal(c.body.humanAuthor, 'alice', JSON.stringify(user));
            assert.equal(c.body.agentAuthor, 'alice_agent');
        }
        const r = await post(on, '/api/bugs', '', { title: 'no one named' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.match(readFileSync(join(on.project, 'bugs', `BUG-${String(r.body.bug?.id ?? r.body.id).padStart(4, '0')}.md`), 'utf8'),
            /^reporter: alice$/m);
    });

    await t('setting on: a header that cannot be a name is refused, not misfiled', async () => {
        const long = await get(on, '/api/config', 'x'.repeat(61));
        assert.equal(long.status, 400);
        assert.match(long.body.error, new RegExp(HEADER));
    });

    await t('setting on: new records, comments, status changes and assignments are the header user\'s', async () => {
        const bug = await post(on, '/api/bugs', 'bob', { title: "bob's bug" });
        assert.equal(bug.status, 200, JSON.stringify(bug.body));
        const id = bug.body.bug?.id ?? bug.body.id;
        const file = join(on.project, 'bugs', `BUG-${String(id).padStart(4, '0')}.md`);
        const filed = readFileSync(file, 'utf8');
        assert.match(filed, /^reporter: bob$/m);
        assert.match(filed, /^assignee: bob$/m, "the default assignee is the header user too");

        assert.equal((await post(on, `/api/bugs/${id}`, 'bob', { status: 'investigating', assignee: 'carol' })).status, 200);
        assert.equal((await post(on, `/api/bugs/${id}/comments`, 'bob', { body: 'looking' })).status, 200);
        const text = readFileSync(file, 'utf8');
        assert.match(text, /· bob · status: open -> investigating/);
        assert.match(text, /· bob · assignee: bob -> carol/);
        assert.match(text, /^### .* · bob$/m);
        assert.ok(!/· alice ·|· alice$/m.test(text), text);

        const item = await post(on, '/api/backlog', 'carol', { title: "carol's story", type: 'story' });
        assert.equal(item.status, 200, JSON.stringify(item.body));
        const itemId = item.body.item?.id ?? item.body.id;
        assert.match(readFileSync(join(on.project, 'backlog', `STORY-${String(itemId).padStart(4, '0')}.md`), 'utf8'), /^reporter: carol$/m);
    });

    await t('setting on: two users at once keep their own filters and settings', async () => {
        await Promise.all([
            post(on, '/api/filters', 'bob', { filters: [{ name: 'bobs' }] }),
            post(on, '/api/filters', 'dave', { filters: [{ name: 'daves' }] }),
            post(on, '/api/user/settings', 'bob', { theme: 'dark' }),
            post(on, '/api/user/settings', 'dave', { theme: 'light' }),
        ]);
        const [bob, dave, alice] = await Promise.all([get(on, '/api/filters', 'bob'), get(on, '/api/filters', 'dave'), get(on, '/api/filters')]);
        assert.deepEqual(bob.body.filters.map((f) => f.name), ['bobs']);
        assert.deepEqual(dave.body.filters.map((f) => f.name), ['daves']);
        assert.deepEqual(alice.body.filters, [], "the process user's profile is untouched");
        assert.equal((await get(on, '/api/user/settings', 'bob')).body.settings.theme, 'dark');
        assert.equal((await get(on, '/api/user/settings', 'dave')).body.settings.theme, 'light');
        assert.equal((await get(on, '/api/user/settings')).body.settings.theme, undefined);
        assert.ok(existsSync(join(on.config, 'user-bob.json')) && existsSync(join(on.config, 'user-dave.json')));
        assert.equal(JSON.parse(readFileSync(join(on.config, 'active.json'), 'utf8')).user, 'alice', 'active.json still names alice');
    });

    await t('setting on: a header user cannot rename the process user', async () => {
        const before = readFileSync(on.toml, 'utf8');
        const r = await post(on, '/api/config/user', 'bob', { name: 'mallory' });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(readFileSync(on.toml, 'utf8'), before);
        assert.equal((await get(on, '/api/config')).body.humanAuthor, 'alice');
    });

    await t('setting on, non-loopback listen: the header is not honoured, and the log says so once', async () => {
        const c = (await get(open, '/api/config', 'bob')).body;
        assert.equal(c.humanAuthor, 'alice');
        await get(open, '/api/config', 'bob');
        const hits = open.log.split('\n').filter((l) => l.includes('BUGDESK_TRUSTED_USER_HEADER') && l.includes('NOT honoured'));
        assert.equal(hits.length, 1, open.log);
        assert.ok(!on.log.includes('NOT honoured'), 'a loopback server honours it');
        assert.ok(!off.log.includes('BUGDESK_TRUSTED_USER_HEADER'), 'nothing said when unset');
    });
} finally {
    for (const s of servers) {
        s.proc.kill('SIGTERM');
        await new Promise((r) => { s.proc.once('exit', r); setTimeout(r, 3000); });
    }
    rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
