/**
 * test-dashboards.mjs — the dashboards model (EPIC-0033), no DOM.
 *
 * Which stored entries the UI can read, what it writes back, and that the page
 * keeps FlexDesk's tiles and charts (and through them Plotly) off the boot path.
 * The page itself is exercised in test-dashboards-dom.mjs.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const model = await import(join(ROOT, 'ui', 'js', 'dashboards', 'model.js'));

let pass = 0, fail = 0;
const t = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
};

console.log('\ndashboards: reading what project.json holds');

const good = {
    id: 'bugs', name: 'Bugs', version: 1, owner: 'kept-unknown-key',
    tiles: [
        { id: 't1', type: 'flexdesk.chart', x: 0, y: 0, w: 6, h: 4, config: { chart_type: 'bar', title: 'Open' } },
        { id: 't-bad', type: 'pie-of-the-future', x: 0, y: 4, w: 6, h: 4 },
        { id: 't2', type: 'flexdesk.kpi', x: 6, y: 0, w: 3, h: 2, config: {}, note: 'kept' },
    ],
};
const raw = [
    'just a string',
    { name: 'No id' },
    { id: 'no-name' },
    { id: 'tiles-str', name: 'Tiles', tiles: 'nope' },
    { id: 'newer', name: 'Newer', version: 2, tiles: [] },
    good,
];

t('every malformed entry is read as broken, with its reason', () => {
    const e = model.readEntries(raw);
    assert.equal(e.length, raw.length, 'an entry was dropped');
    assert.deepEqual(e.map((x) => x.ok), [false, false, false, false, false, true]);
    assert.equal(e[0].reason, 'not an object');
    assert.equal(e[1].reason, 'no valid id');
    assert.equal(e[2].reason, 'no name');
    assert.equal(e[3].reason, 'tiles is not a list');
    assert.match(e[4].reason, /newer BugDesk \(version 2\)/);
    for (let i = 0; i < raw.length; i++) assert.equal(e[i].raw, raw[i], 'the raw entry is not the one read');
});

t('a tile that cannot be read is set aside, not dropped', () => {
    const [, , , , , e] = model.readEntries(raw);
    assert.deepEqual(e.tiles.map((x) => x.id), ['t1', 't2']);
    assert.deepEqual(e.keptTiles.map((x) => x.id), ['t-bad']);
});

t('a repeated dashboard id is broken and cannot be acted on by id', () => {
    const e = model.readEntries([
        { id: 'x', name: 'Newer', version: 2, tiles: [] },
        { id: 'x', name: 'Same id', tiles: [] },
    ]);
    assert.equal(e[0].ok, false);
    assert.equal(e[0].id, 'x');
    assert.equal(e[1].ok, false, 'the second entry would be saved over the first');
    assert.equal(e[1].id, null);
    assert.match(e[1].reason, /repeats the id "x"/);
});

t('a repeated tile id is kept aside, and written back where it was', () => {
    const dup = {
        id: 'd', name: 'D', tiles: [
            { id: 't1', type: 'flexdesk.kpi', x: 0, y: 0, w: 3, h: 2, config: {} },
            { id: 't1', type: 'flexdesk.chart', x: 3, y: 0, w: 6, h: 4, config: {} },
        ],
    };
    const entry = model.readEntry(JSON.parse(JSON.stringify(dup)));
    assert.deepEqual(entry.tiles.map((x) => x.type), ['flexdesk.kpi']);
    assert.deepEqual(entry.keptTiles.map((x) => x.type), ['flexdesk.chart']);
    const layout = entry.tiles.map((x) => ({ ...x, x: 1 }));
    const out = model.toEntry(entry, layout);
    assert.equal(out.tiles.length, 2, 'a tile was lost');
    assert.deepEqual(out.tiles[1], dup.tiles[1]);
    assert.equal(out.tiles[0].x, 1);
});

t('anything but a list reads as no dashboards', () => {
    assert.deepEqual(model.readEntries(null), []);
    assert.deepEqual(model.readEntries({ a: 1 }), []);
});

console.log('\ndashboards: what is written back');

const defaults = {
    'flexdesk.chart': { title: '', chart_type: 'line', unit: '', legend: 'bottom', y_min: null },
    'flexdesk.kpi': { title: '', label: '', format: 'number' },
};
const defaultsFor = (type) => defaults[type];
// What TileGrid.getLayout() hands back: every default merged into each config.
const layoutOf = (entry) => entry.tiles.map((x) => ({
    id: x.id, type: x.type, x: x.x, y: x.y, w: x.w, h: x.h,
    config: { ...defaults[x.type], ...x.config },
}));

t('an unchanged grid writes back exactly what was read', () => {
    const entry = model.readEntry(JSON.parse(JSON.stringify(good)));
    const out = model.toEntry(entry, layoutOf(entry), defaultsFor);
    assert.equal(JSON.stringify(out), JSON.stringify(good));
});

t('a moved tile changes only its position; unknown keys and the unreadable tile stay', () => {
    const entry = model.readEntry(JSON.parse(JSON.stringify(good)));
    const layout = layoutOf(entry);
    layout[0].x = 6; layout[0].w = 5;
    const out = model.toEntry(entry, layout, defaultsFor);
    assert.equal(out.owner, 'kept-unknown-key');
    assert.deepEqual(out.tiles[0], { ...good.tiles[0], x: 6, w: 5 });
    assert.deepEqual(out.tiles.find((x) => x.id === 't-bad'), good.tiles[1]);
    assert.equal(out.tiles.find((x) => x.id === 't2').note, 'kept');
});

t('a configured value is written; an untouched default is not', () => {
    const entry = model.readEntry(JSON.parse(JSON.stringify(good)));
    const layout = layoutOf(entry);
    layout[0].config.unit = 'pts';
    const out = model.toEntry(entry, layout, defaultsFor);
    assert.deepEqual(out.tiles[0].config, { chart_type: 'bar', title: 'Open', unit: 'pts' });
});

t('a rename keeps everything else', () => {
    const entry = { ...model.readEntry(JSON.parse(JSON.stringify(good))), name: 'Bug overview' };
    const out = model.toEntry(entry, layoutOf(entry), defaultsFor);
    assert.equal(out.name, 'Bug overview');
    assert.equal(out.id, 'bugs');
    assert.equal(out.tiles.length, 3);
});

t('a new dashboard is readable and has a valid id', () => {
    const e = model.newEntry('  Mine  ');
    assert.equal(e.ok, true);
    assert.equal(e.name, 'Mine');
    assert.match(e.id, model.ID_RE);
    assert.match(model.newId('t'), model.ID_RE);
});

t('names are compared ignoring case and surrounding spaces', () => {
    const entries = model.readEntries([good]);
    assert.equal(model.nameTaken(' bugs ', entries), true);
    assert.equal(model.nameTaken('bugs', entries, 'bugs'), false, 'renaming to its own name is not a clash');
    assert.equal(model.nameTaken('Backlog', entries), false);
});

console.log('\ndashboards: sections (STORY-0046)');

t('a dashboard with no section, or one BugDesk does not know, is listed everywhere', () => {
    // Saved before the key existed: dropping it from every rail would lose it.
    for (const raw of [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', section: 'reports' }, { id: 'c', name: 'C', section: 7 }]) {
        const e = model.readEntry(raw);
        assert.ok(e.ok, `${raw.id} is not readable`);
        assert.equal(model.sectionOf(e), 'all');
        for (const s of ['bugs', 'backlog', 'tracker']) assert.ok(model.listedIn(e, s), `${raw.id} is not listed in ${s}`);
    }
});
t('a dashboard of one section is listed there and nowhere else', () => {
    const e = model.readEntry({ id: 'b', name: 'B', section: 'backlog' });
    assert.equal(model.sectionOf(e), 'backlog');
    assert.deepEqual(['bugs', 'backlog', 'tracker'].filter((s) => model.listedIn(e, s)), ['backlog']);
    assert.ok(model.listedIn(model.readEntry({ id: 'x', name: 'X', section: 'all' }), 'tracker'));
});
t('a new dashboard is listed in the section it was created in', () => {
    assert.equal(model.newEntry('Mine', 'p-1', 'tracker').raw.section, 'tracker');
    assert.equal(model.sectionOf(model.newEntry('Mine', 'p-2', 'bugs')), 'bugs');
    assert.ok(!('section' in model.newEntry('Mine', 'p-3').raw), 'no section given, none written');
    assert.ok(!('section' in model.newEntry('Mine', 'p-4', 'nonsense').raw));
});
t('a section BugDesk does not know is written back unchanged', () => {
    const e = model.readEntry({ id: 'b', name: 'B', section: 'reports', tiles: [] });
    assert.equal(model.toEntry(e, []).section, 'reports');
});
t('a rename that leaves it under All sections keeps a section BugDesk does not know', () => {
    const raw = { id: 'b', name: 'B', section: 'reports', tiles: [] };
    assert.equal(model.withSection(raw, 'all').section, 'reports');
    assert.equal(model.withSection(raw, 'backlog').section, 'backlog');
    assert.equal(raw.section, 'reports', 'the original was changed');
    assert.ok(!('section' in model.withSection({ id: 'n', name: 'N' }, 'all')), 'no section, none written for All sections');
});
t('a dashboard of a section the project does not have is listed in the ones it has', () => {
    const e = model.readEntry({ id: 'g', name: 'G', section: 'bugs' });
    assert.ok(!model.listedIn(e, 'backlog'), 'without the sections present, only its own');
    assert.ok(model.listedIn(e, 'backlog', ['backlog']), 'a bugs dashboard in a backlog-only project is unreachable');
    assert.ok(!model.listedIn(e, 'backlog', ['bugs', 'backlog']));
    // No tracker here (switched off, or not merged): its dashboards wait, unlisted.
    assert.ok(!model.listedIn(model.readEntry({ id: 't', name: 'T', section: 'tracker' }), 'bugs', ['bugs', 'backlog']));
});

console.log('\ndashboards: personal (STORY-0035)');

t('the personal file: none yet reads as empty; one that does not parse is broken, never empty', () => {
    assert.deepEqual(model.parsePersonal(null), { doc: { version: 1, dashboards: [] }, broken: null });
    assert.deepEqual(model.parsePersonal('  '), { doc: { version: 1, dashboards: [] }, broken: null });
    const ok = model.parsePersonal('{"version":1,"dashboards":[{"id":"p-1","name":"Mine"}],"extra":true}');
    assert.equal(ok.broken, null);
    assert.equal(ok.doc.extra, true);
    assert.equal(ok.doc.dashboards[0].id, 'p-1');
    for (const text of ['{oops', '[]', '{"dashboards":{}}', '"x"']) {
        const r = model.parsePersonal(text);
        assert.equal(r.doc, null, text);
        assert.match(r.broken, /dashboards\.json/, text);
    }
});

t('a copy gets a name no personal dashboard has', () => {
    const entries = model.readEntries([{ id: 'a', name: 'Bugs' }, { id: 'b', name: 'bugs (copy)' }]);
    assert.equal(model.freeName('Open', entries), 'Open');
    assert.equal(model.freeName(' Bugs ', entries), 'Bugs (copy 2)');
});

t('personal dashboards live in the git-ignored profile state, never beside project.json', () => {
    assert.equal(model.PERSONAL_FILE, 'dashboards.json');
    const store = readFileSync(join(ROOT, 'ui', 'js', 'dashboards', 'store.js'), 'utf8');
    const personal = store.slice(store.indexOf('personal dashboards'));
    assert.match(personal, /personal_state_write/);
    assert.doesNotMatch(personal, /\/project\//, 'a personal save goes to the project config');
    const ignore = readFileSync(join(ROOT, 'server', 'UserConfig.cs'), 'utf8');
    assert.match(ignore, /\$"state-\{ActiveSlug\}"/, 'the state is no longer per profile');
    assert.match(ignore, /"\*",\s*"!\.gitignore",\s*"!" \+ SharedFileName,\s*""/, '.bugdesk/.gitignore no longer ignores all but project.json');
});

console.log('\ndashboards: records into series (STORY-0036)');

/* ── STORY-0036: records → series ─────────────────────────────────── */

const series = await import(join(ROOT, 'ui', 'js', 'dashboards', 'series.js'));
const resolve = await import(join(ROOT, 'ui', 'js', 'dashboards', 'resolve.js'));
const { createFilterModel } = await import(join(ROOT, 'ui', 'js', 'ticketdesk', 'filter_engine.js'));

const pending = [];
const ta = (name, fn) => pending.push([name, fn]);

/** A backlog-like source over plain rows, shaped like sources.js's. */
function fakeSource(rows, { custom = ['risk', 'team'], history = {} } = {}) {
    const CAT = { done: 'finished', dropped: 'finished', review: 'waiting' };
    const fields = [
        { key: 'type', label: 'Type', type: 'enum', options: [{ value: 'story', label: 'Story' }, { value: 'task', label: 'Task' }], get: (i) => i.type },
        { key: 'status', label: 'Status', type: 'enum', options: ['draft', 'in-progress', 'review', 'done', 'dropped'], get: (i) => i.status },
        { key: 'finished', label: 'Finished', type: 'enum', options: ['no', 'yes'], get: (i) => (CAT[i.status] === 'finished' ? 'yes' : 'no') },
        { key: 'assignee', label: 'Assignee', type: 'enum', options: ['ann', 'bob', 'none'], get: (i) => i.assignee || 'none' },
        { key: 'labels', label: 'Labels', type: 'set', get: (i) => i.labels || [] },
        { key: 'points', label: 'Estimate', type: 'number', get: (i) => i.points },
        { key: 'created', label: 'Created', type: 'date', get: (i) => i.created },
        { key: 'statusCategory', label: 'Status category', type: 'enum', virtual: true,
          options: ['active', 'waiting', 'finished'], get: (i) => CAT[i.status] || 'active' },
    ];
    if (custom.includes('risk')) fields.push({ key: 'cf.risk', label: 'Risk', type: 'number', custom: true, get: (i) => { const n = Number(i.fields?.risk); return Number.isFinite(n) && i.fields?.risk !== '' ? n : null; } });
    if (custom.includes('team')) fields.push({ key: 'cf.team', label: 'Team', type: 'text', custom: true, get: (i) => String(i.fields?.team ?? '') });
    const model = createFilterModel({ fields, noun: 'item' });
    const builtins = [
        { key: 'board', label: 'Backlog', expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'finished', op: 'is', value: 'no' }] } },
        { key: 'all', label: 'Everything', expr: { kind: 'group', op: 'AND', children: [] } },
    ];
    return {
        id: 'backlog', label: 'Backlog', fields, model,
        fieldByKey: (k) => fields.find((f) => f.key === k) || null,
        rows: () => rows,
        types: () => fields[0].options,
        read: (f, r) => (f.key.startsWith('cf.') ? r.fields?.[f.key.slice(3)] : f.get(r)),
        builtinFilters: () => builtins,
        builtinFilter: (k) => builtins.find((b) => b.key === k) || null,
        savedFilters: () => [],
        statusOf: (r) => r.status,
        idOf: (r) => r.id,
        createdOf: (r) => r.created,
        updatedOf: (r) => r.updated,
        isFinished: (_r, s) => CAT[s] === 'finished',
        isFinishedNow: (r) => CAT[r.status] === 'finished',
        history: async () => history,
        listKind: 'backlog',
        listProps: (expr, label) => ({ expr, label, flat: true }),
        parentOf: (r) => (r && Number(r.parent) ? String(Number(r.parent)) : ''),
        phaseOf: (r) => r.phase || '',
        dueOf: (r) => r.due || '',
        pointsOf: (r) => r.points,
    };
}

const ROWS = [
    { id: 1, type: 'story', status: 'draft', assignee: 'ann', labels: ['ui', 'api'], points: '5', created: '2026-09-01', updated: '2026-09-01 10:00', fields: { risk: '3', team: 'red' } },
    { id: 2, type: 'story', status: 'in-progress', assignee: 'bob', labels: ['ui'], points: '3', created: '2026-09-02', updated: '2026-09-20 10:00', fields: { risk: 'high', team: 'blue' } },
    { id: 3, type: 'task', status: 'done', assignee: '', labels: [], points: 'M', created: '2026-09-08', updated: '2026-10-02 09:00', fields: { risk: '1' } },
    { id: 4, type: 'task', status: 'review', assignee: 'ann', labels: ['api'], points: '?', created: '2026-09-15', updated: '2026-09-16 10:00', fields: {} },
    { id: 5, type: 'story', status: 'done', assignee: 'bob', labels: ['ui'], points: '', created: '2026-09-16', updated: '2026-10-05 09:00', fields: { risk: '2' } },
];

t('toNumber is strict: M, ? and blanks are not numbers', () => {
    assert.equal(series.toNumber('5'), 5);
    assert.equal(series.toNumber(' 2.5 '), 2.5);
    assert.equal(series.toNumber(3), 3);
    for (const v of ['M', '?', '', null, undefined, '5pts', NaN]) assert.equal(series.toNumber(v), null, String(v));
});

t('group and count: by an enum in its option order, (none) last', () => {
    const src = fakeSource(ROWS);
    const g = series.groupCount(ROWS, src.fieldByKey('assignee'));
    assert.deepEqual(g.keys, ['ann', 'bob', 'none']);
    assert.deepEqual(g.y, [2, 2, 1]);
});

t('group and count: labels count each label, unlabelled as (none)', () => {
    const g = series.groupCount(ROWS, fakeSource(ROWS).fieldByKey('labels'));
    assert.deepEqual(Object.fromEntries(g.keys.map((k, i) => [k, g.y[i]])), { ui: 3, api: 2, '': 1 });
    assert.equal(g.x.at(-1), '(none)');
});

t('group and count: a custom text field, and a date field by month', () => {
    const src = fakeSource(ROWS);
    const team = series.groupCount(ROWS, src.fieldByKey('cf.team'));
    assert.deepEqual(Object.fromEntries(team.keys.map((k, i) => [k, team.y[i]])), { red: 1, blue: 1, '': 3 });
    const created = series.groupCount(ROWS, src.fieldByKey('created'));
    assert.deepEqual(created.keys, ['2026-09']);
});

t('sum and average per group leave M and ? out and count them', () => {
    const src = fakeSource(ROWS);
    const pts = src.fieldByKey('points');
    const sum = series.aggregate(ROWS, src.fieldByKey('type'), (r) => src.read(pts, r), 'sum');
    assert.deepEqual(sum.keys, ['story'], 'tasks have only M and ?, so no sum');
    assert.deepEqual(sum.y, [8]);
    assert.equal(sum.skipped, 2);
    const avg = series.aggregate(ROWS, src.fieldByKey('type'), (r) => src.read(pts, r), 'avg');
    assert.equal(avg.y[0], 4);
    assert.ok(!avg.keys.includes('task'), 'a group with no numbers has no average');
});

t('a KPI counts, sums and averages; a sum of nothing is 0', () => {
    const src = fakeSource(ROWS);
    const risk = (r) => src.read(src.fieldByKey('cf.risk'), r);
    assert.deepEqual(series.kpi(ROWS, 'count'), { value: 5, skipped: 0 });
    assert.deepEqual(series.kpi(ROWS, 'sum', risk), { value: 6, skipped: 1 });
    assert.deepEqual(series.kpi(ROWS, 'avg', risk), { value: 2, skipped: 1 });
    assert.deepEqual(series.kpi([], 'sum', risk), { value: 0, skipped: 0 });
    assert.equal(series.kpi([], 'avg', risk).value, null);
});

t('weeks start on Monday, and finished is the last move into a finished status', () => {
    assert.equal(series.weekStart('2026-10-14'), '2026-10-12');
    assert.equal(series.weekStart('2026-10-12'), '2026-10-12');
    assert.equal(series.weekStart('2026-10-11'), '2026-10-05');
    const fin = (s) => s === 'done' || s === 'dropped';
    const h = [{ date: '2026-09-03', from: 'draft', to: 'done' }, { date: '2026-09-04', from: 'done', to: 'in-progress' },
        { date: '2026-09-10T10:00Z', from: 'in-progress', to: 'done' }];
    assert.equal(series.finishedDay(h, fin, '2026-10-01 10:00'), '2026-09-10');
    assert.equal(series.finishedDay([], fin, '2026-10-01 10:00'), '2026-10-01', 'no history: the update day');
});

t('drill clauses select one group in the list views\' filter language', () => {
    const src = fakeSource(ROWS);
    const pick = (field, key) => ROWS.filter(src.model.matcherFor(series.andExpr(series.drillClause(src.fieldByKey(field), key)))).map((r) => r.id);
    assert.deepEqual(pick('assignee', 'ann'), [1, 4]);
    assert.deepEqual(pick('labels', 'ui'), [1, 2, 5]);
    assert.deepEqual(pick('labels', ''), [3]);
    assert.deepEqual(pick('cf.team', ''), [3, 4, 5]);
    assert.deepEqual(pick('created', '2026-09'), [1, 2, 3, 4, 5]);
    assert.equal(series.drillClause(src.fieldByKey('points'), 'M'), null, 'a non-number on a number field has no clause');
});

ta('a count tile carries each bar\'s key; a click selects the same records', async () => {
    const src = fakeSource(ROWS);
    const b = { source: 'backlog', types: ['story'], filter: { key: 'all' }, plot: 'count', field: 'assignee' };
    const r = await resolve.resolveTile(src, b);
    assert.deepEqual(r.data.series[0].x, ['ann', 'bob']);
    assert.deepEqual(r.data.series[0].y, [1, 2]);
    assert.deepEqual(r.data.series[0].customdata, ['ann', 'bob']);
    const d = resolve.drillExpr(src, b, 'bob', 'Stories');
    assert.deepEqual(ROWS.filter(src.model.matcherFor(d.expr)).map((x) => x.id), [2, 5]);
    assert.equal(d.label, 'Stories: bob');
});

ta('a status-category bar drills down to the statuses behind it', async () => {
    const src = fakeSource(ROWS);
    const b = { source: 'backlog', plot: 'count', field: 'statusCategory' };
    const r = await resolve.resolveTile(src, b);
    assert.deepEqual(r.data.series[0].customdata, ['active', 'waiting', 'finished']);
    const d = resolve.drillExpr(src, b, 'finished');
    assert.deepEqual(d.expr.children[0], { kind: 'clause', field: 'status', op: 'one_of', value: ['done'] });
});

ta('the filter is the views\' own: a built-in view by key, or a copied expression', async () => {
    const src = fakeSource(ROWS);
    const board = await resolve.resolveTile(src, { source: 'backlog', filter: { key: 'board' }, plot: 'count' }, { kind: 'kpi' });
    assert.equal(board.data.value, 3);
    assert.equal(board.data.label, 'Backlog');
    const saved = { expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'labels', op: 'contains', value: 'api' }] }, label: 'API work' };
    const s = await resolve.resolveTile(src, { source: 'backlog', filter: saved, plot: 'count' }, { kind: 'kpi' });
    assert.equal(s.data.value, 2);
    const gone = await resolve.resolveTile(src, { source: 'backlog', filter: { key: 'nope' }, plot: 'count' }, { kind: 'kpi' });
    assert.match(gone.empty, /filter 'nope' no longer exists/);
});

ta('sum, average and histogram over points and a custom number field note what they left out', async () => {
    const src = fakeSource(ROWS);
    const sum = await resolve.resolveTile(src, { source: 'backlog', plot: 'sum', field: 'type', valueField: 'points' });
    assert.deepEqual(sum.data.series[0].y, [8]);
    assert.equal(sum.data.note, '2 non-numeric Estimate values (like M or ?) left out');
    const avg = await resolve.resolveTile(src, { source: 'backlog', plot: 'avg', field: 'assignee', valueField: 'cf.risk' });
    assert.deepEqual(avg.data.series[0].x, ['ann', 'bob', 'none']);
    assert.deepEqual(avg.data.series[0].y, [3, 2, 1], "bob's 'high' is left out of his average");
    assert.match(avg.data.note, /^1 non-numeric Risk value \(like M or \?\) left out$/);
    const hist = await resolve.resolveTile(src, { source: 'backlog', plot: 'histogram', valueField: 'points' });
    assert.deepEqual(hist.data.series[0].values, [5, 3]);
    assert.match(hist.data.note, /2 non-numeric/);
    const k = await resolve.resolveTile(src, { source: 'backlog', plot: 'avg', valueField: 'points' }, { kind: 'kpi' });
    assert.equal(k.data.value, 4);
    assert.match(k.data.note, /2 non-numeric/);
});

ta('a numeric aggregate over a field that is not a number is refused, not drawn', async () => {
    const src = fakeSource(ROWS);
    const r = await resolve.resolveTile(src, { source: 'backlog', plot: 'sum', field: 'type', valueField: 'cf.team' });
    assert.match(r.empty, /'Team' is not a number field/);
});

ta('created and finished per week over a date range, finished from History', async () => {
    const src = fakeSource(ROWS, { history: { 3: [{ date: '2026-09-09', from: 'draft', to: 'done' }] } });
    const r = await resolve.resolveTile(src, { source: 'backlog', plot: 'perWeek', from: '2026-08-31', to: '2026-10-04' });
    const [created, finished] = r.data.series;
    assert.deepEqual(created.x, ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    assert.deepEqual(created.y, [2, 1, 2, 0, 0]);
    // #3 by its History line (09-09); #5 has none, so its update day — 10-05, after the range.
    assert.deepEqual(finished.y, [0, 1, 0, 0, 0]);
    const bad = await resolve.resolveTile(src, { source: 'backlog', plot: 'perWeek', from: '2026-10-05', to: '2026-10-01' });
    assert.match(bad.empty, /ends before it starts/);
    // A hand-edited range that is not a date is an empty state, not a thrown RangeError.
    for (const range of [{ from: '2026-13-45' }, { to: 'soon' }]) {
        const r2 = await resolve.resolveTile(src, { source: 'backlog', plot: 'perWeek', ...range });
        assert.match(r2.empty, /is not a date/);
    }
});

ta('a tile over a removed field explains itself, naming the field', async () => {
    const src = fakeSource(ROWS, { custom: ['team'] });
    const a = await resolve.resolveTile(src, { source: 'backlog', plot: 'avg', field: 'type', valueField: 'cf.risk' });
    assert.match(a.empty, /The field 'risk' is no longer in this project's schema/);
    const b = await resolve.resolveTile(src, { source: 'backlog', plot: 'count', field: 'cf.risk' });
    assert.match(b.empty, /'risk' is no longer/);
    const expr = { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'cf.risk', op: 'gt', value: 1 }] };
    const c = await resolve.resolveTile(src, { source: 'backlog', plot: 'count', filter: { expr } }, { kind: 'kpi' });
    assert.match(c.empty, /'risk' is no longer/);
});

ta('no settings yet, or a store this project lacks, is an empty state too', async () => {
    assert.match((await resolve.resolveTile(null, null)).empty, /no data settings yet/);
    assert.match((await resolve.resolveTile(null, { source: 'bugs', plot: 'count', field: 'status' })).empty, /no bugs store/);
});


console.log('\ndashboards: lists, people and the board\'s scope (STORY-0047)');

/** fakeSource with what the list and people tiles read (sources.js's backlogSpec). */
function rowsSource(rows) {
    const src = fakeSource(rows);
    const clause = (field, op, value) => ({ kind: 'clause', field, op, value });
    src.fields.push({ key: 'reporter', label: 'Reporter', type: 'enum', options: ['ann', 'bob', 'none'], get: (i) => i.reporter || 'none' });
    src.model = createFilterModel({ fields: src.fields, noun: 'item' });
    return Object.assign(src, {
        scopeClause: (sc) => (sc === 'byme' ? clause('reporter', 'is', 'ann') : sc === 'others' ? clause('assignee', 'none_of', ['none', 'ann']) : null),
        openClause: () => clause('finished', 'is', 'no'),
        assigneeClause: (who) => clause('assignee', 'is', who || 'none'),
        assigneeOf: (r) => r.assignee || '',
        dueStateOf: (r) => r.dueState || 'none',
        listRow: (r) => ({ key: String(r.id), lead: `#${r.id}`, title: r.title || '' }),
    });
}
const LIST_ROWS = [
    { id: 1, type: 'story', status: 'draft', assignee: 'ann', reporter: 'ann', due: '2026-10-20', dueState: 'soon', updated: '2026-10-01', created: '2026-09-01' },
    { id: 2, type: 'story', status: 'draft', assignee: 'bob', reporter: 'ann', due: '2026-10-01', dueState: 'overdue', updated: '2026-10-09', created: '2026-09-03' },
    { id: 3, type: 'task', status: 'done', assignee: 'bob', reporter: 'ann', due: '2026-09-01', dueState: 'done', updated: '2026-10-02', created: '2026-09-02' },
    { id: 4, type: 'task', status: 'draft', assignee: '', reporter: 'bob', due: '', dueState: 'none', updated: '2026-10-05', created: '2026-09-05' },
    { id: 5, type: 'task', status: 'draft', assignee: 'bob', reporter: 'bob', due: '2026-09-28', dueState: 'overdue', updated: '2026-09-28', created: '2026-09-04' },
];
const keys = (r) => r.data.rows.map((x) => x.key);
const listOf = (b, o = {}) => resolve.resolveTile(rowsSource(LIST_ROWS), { source: 'backlog', ...b }, { kind: 'list', today: '2026-10-08', ...o });

ta('a list tile lists open records, the most late first by target date, undated last', async () => {
    assert.deepEqual(keys(await listOf({})), ['5', '2', '1', '4']);
    assert.deepEqual(keys(await listOf({ open: false })), ['3', '5', '2', '1', '4'], 'open: false lists finished ones too');
    const r = await listOf({});
    assert.deepEqual(r.data.action, { label: 'Open as a list', icon: 'list' });
});

ta('a list tile\'s other orders', async () => {
    assert.deepEqual(keys(await listOf({ sort: 'updated' })), ['2', '4', '1', '5']);
    assert.deepEqual(keys(await listOf({ sort: 'created' })), ['4', '5', '2', '1']);
    assert.deepEqual(keys(await listOf({ sort: 'ref' })), ['1', '2', '4', '5']);
});

ta('a list over a store without target dates (bugs) orders "by target date" by last updated', async () => {
    const undated = { ...rowsSource(LIST_ROWS), dueOf: undefined };
    const r = await resolve.resolveTile(undated, { source: 'bugs', sort: 'due' }, { kind: 'list', today: '2026-10-08' });
    assert.deepEqual(keys(r), ['2', '4', '1', '5']);
});

ta('every tile follows the board\'s scope: a list, a KPI and a chart', async () => {
    assert.deepEqual(keys(await listOf({}, { scope: 'byme' })), ['2', '1'], 'Assigned by me reads the reporter');
    assert.deepEqual(keys(await listOf({}, { scope: 'others' })), ['5', '2'], 'Out with others: on somebody else, not on nobody');
    const kpi = await resolve.resolveTile(rowsSource(LIST_ROWS), { source: 'backlog', plot: 'count' }, { kind: 'kpi', scope: 'byme' });
    assert.equal(kpi.data.value, 3);
    const chart = await resolve.resolveTile(rowsSource(LIST_ROWS), { source: 'backlog', plot: 'count', field: 'assignee' }, { scope: 'others' });
    assert.deepEqual(chart.data.series[0].x, ['bob']);
    assert.equal(resolve.scopeOf('nonsense'), 'all');
    assert.deepEqual(resolve.SCOPES.map((x) => x.label), ['Everyone', 'Assigned by me', 'Out with others']);
});

ta('a people tile: open records by assignee, worst first, nobody a row of its own', async () => {
    const r = await resolve.resolveTile(rowsSource(LIST_ROWS), { source: 'backlog' }, { kind: 'people', today: '2026-10-08' });
    assert.deepEqual(r.data.people.map((p) => [p.key, p.name, p.count, p.pills.map((x) => x.text)]), [
        ['bob', 'bob', 2, ['2 overdue']],
        ['', 'Nobody', 1, ['1 undated']],
        ['ann', 'ann', 1, ['next 2026-10-20']],
    ]);
    assert.equal(r.data.people[1].muted, true);
    assert.equal(r.data.people[0].pills[0].tone, 'danger');
});

ta('a click-through carries the tile\'s filter, open records only, and the scope', async () => {
    const src = rowsSource(LIST_ROWS);
    const match = (d) => LIST_ROWS.filter(src.model.matcherFor(d.expr)).map((x) => x.id);
    const b = { source: 'backlog', types: ['story'] };
    assert.deepEqual(match(resolve.listDrill(src, b, 'Stories', 'all')), [1, 2]);
    assert.equal(resolve.listDrill(src, b, 'Stories').label, 'Stories');
    assert.deepEqual(match(resolve.personDrill(src, { source: 'backlog' }, 'bob', 'all')), [2, 5], 'a finished one is on the list');
    assert.deepEqual(match(resolve.personDrill(src, { source: 'backlog' }, '', 'all')), [4]);
    assert.equal(resolve.personDrill(src, { source: 'backlog' }, '', 'all').label, 'Nobody on it');
    assert.deepEqual(match(resolve.personDrill(src, { source: 'backlog' }, 'bob', 'byme')), [2]);
    const chart = { source: 'backlog', plot: 'count', field: 'assignee' };
    assert.deepEqual(match(resolve.drillExpr(src, chart, 'bob', '', 'byme')), [2, 3], 'a chart\'s click carries the scope too');
});

ta('a list or people tile over a store this page lacks says so', async () => {
    const r = await resolve.resolveTile(null, { source: 'bugs' }, { kind: 'list' });
    assert.match(r.empty, /no bugs store/);
});

console.log('\ndashboards: burndown (STORY-0037)');

/** The example backlog's records and their status History, read straight from the .md files. */
function exampleBacklog() {
    const dir = join(ROOT, 'examples', 'backlog');
    const rows = [], history = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
        const text = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
        const fm = Object.fromEntries(text.split('---\n')[1].split('\n').filter((l) => l.includes(':'))
            .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
        const id = Number(fm.id);
        rows.push({ id, type: fm.type, status: fm.status, parent: fm.parent, points: fm.points, created: fm.created, updated: fm.updated, phase: fm.phase, due: fm.due, fields: {} });
        const hist = (text.split('\n## History\n')[1] || '').split('\n## ')[0];
        history[id] = [...hist.matchAll(/^- (\S+) · \S+ · status: (\S+) -> (\S+)$/gm)]
            .map(([, date, from, to]) => ({ date, from: from === '(unset)' ? '' : from, to: to === '(unset)' ? '' : to }));
    }
    return { rows, history };
}

const valuesOn = (r, s = 0) => Object.fromEntries(r.data.series[s].x.map((x, i) => [x, r.data.series[s].y[i]]));

ta('hand count: EPIC-0001 in points and items, day by day, from the example records\' History', async () => {
    const { rows, history } = exampleBacklog();
    const src = fakeSource(rows, { history });
    const b = { source: 'backlog', plot: 'burndown', unit: 'points', scope: { kind: 'epic', id: 1 } };
    const r = await resolve.resolveTile(src, b, { today: '2026-09-12' });
    // Under EPIC-0001: STORY-0002 (5, created 09-01), TASK-0003 (2, 09-02, done 09-09 by History),
    // TASK-0004 (1, 09-02), STORY-0008 (3, 09-04), STORY-0005 (no estimate, 09-05). No due: to = today.
    assert.deepEqual(r.data.series[0].x, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
        '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);
    assert.deepEqual(r.data.series[0].y, [5, 8, 8, 11, 11, 11, 11, 11, 9, 9, 9, 9]);
    assert.equal(r.data.series[0].name, 'Remaining points');
    const items = await resolve.resolveTile(src, { ...b, unit: 'items' }, { today: '2026-09-12' });
    assert.deepEqual(items.data.series[0].y, [1, 3, 3, 4, 5, 5, 5, 5, 4, 4, 4, 4]);
    assert.equal(items.data.series[0].name, 'Remaining items');
});

ta('the step line, the dashed ideal from the starting total to zero at the end, and today', async () => {
    const { rows, history } = exampleBacklog();
    const src = fakeSource(rows, { history });
    const b = { source: 'backlog', plot: 'burndown', unit: 'points', scope: { kind: 'epic', id: 1 }, to: '2026-09-20' };
    const r = await resolve.resolveTile(src, b, { today: '2026-09-12' });
    const [rem, scope, ideal] = r.data.series;
    assert.equal(rem.interpolation, 'step');
    assert.equal(scope.interpolation, 'step');
    assert.deepEqual(ideal, { x: ['2026-09-01', '2026-09-20'], y: [5, 0], name: 'Ideal', lineStyle: 'dashed' });
    assert.equal(rem.x.at(-1), '2026-09-20', 'the chosen end');
    assert.equal(rem.y.at(-1), null, 'a day after today has a value');
    assert.equal(valuesOn(r)['2026-09-12'], 9);
    assert.deepEqual(r.data.markers, [{ x: '2026-09-12', label: 'Today' }]);
    // The epic's own due date is the default end.
    const due = rows.map((x) => (x.id === 1 ? { ...x, due: '2026-09-30' } : x));
    const r2 = await resolve.resolveTile(fakeSource(due, { history }), { ...b, to: undefined, from: '2026-09-05' }, { today: '2026-10-05' });
    assert.deepEqual(r2.data.series[2].x, ['2026-09-05', '2026-09-30']);
    assert.deepEqual(r2.data.series[2].y, [11, 0]);
    assert.deepEqual(r2.data.markers, [], 'today is past the range');
});

ta('an epic due that is not a date falls back to today instead of being the end', async () => {
    const { rows, history } = exampleBacklog();
    const bad = rows.map((x) => (x.id === 1 ? { ...x, due: 'soon' } : x));
    const r = await resolve.resolveTile(fakeSource(bad, { history }), { source: 'backlog', plot: 'burndown', unit: 'items', scope: { kind: 'epic', id: 1 } }, { today: '2026-09-12' });
    assert.equal(r.data.series[0].x.at(-1), '2026-09-12');
});

ta('the footer says points are current estimates', async () => {
    const { rows, history } = exampleBacklog();
    const r = await resolve.resolveTile(fakeSource(rows, { history }), { source: 'backlog', plot: 'burndown', unit: 'points' }, { today: '2026-09-12' });
    assert.match(r.data.note, /Points are current estimates/);
    const i = await resolve.resolveTile(fakeSource(rows, { history }), { source: 'backlog', plot: 'burndown', unit: 'items' }, { today: '2026-09-12' });
    assert.doesNotMatch(i.data.note, /Points are/);
});

// Synthetic: a row per rule, all under epic 10, in phase "p1" unless said otherwise.
const SYN = [
    { id: 10, type: 'epic', status: 'in-progress', points: '', created: '2026-09-01', updated: '2026-09-01', phase: 'p1' },
    { id: 11, type: 'story', parent: 10, status: 'dropped', points: '3', created: '2026-09-01', updated: '2026-09-05', phase: 'p1' },
    { id: 12, type: 'story', parent: 10, status: 'shipped', points: '2', created: '2026-09-01', updated: '2026-09-04', phase: 'p1' },
    { id: 13, type: 'task', parent: 12, status: 'done', points: '1', created: '2026-09-02', updated: '2026-09-06 10:00', phase: 'p1' },
    { id: 14, type: 'task', parent: 12, status: 'draft', points: 'M', created: '2026-09-03', updated: '2026-09-03', phase: 'p1' },
    { id: 15, type: 'story', parent: 10, status: 'in-progress', points: '5', created: '2026-09-04', updated: '2026-09-04', phase: 'p2' },
    { id: 16, type: 'story', status: 'draft', points: '8', created: '2026-09-01', updated: '2026-09-01', phase: 'p2' },
];
const SYN_HIST = {
    11: [{ date: '2026-09-03', from: '', to: 'draft' }, { date: '2026-09-05', from: 'draft', to: 'dropped' }],
    12: [{ date: '2026-09-04', from: 'draft', to: 'shipped' }],
    14: [],
};
/** `shipped` is a custom status of category finished. */
function synSource(rows = SYN) {
    const src = fakeSource(rows, { history: SYN_HIST });
    const fin = (s) => s === 'done' || s === 'dropped' || s === 'shipped';
    return { ...src, isFinished: (_r, s) => fin(s), isFinishedNow: (r) => fin(r.status) };
}
const syn = (b) => resolve.resolveTile(synSource(), { source: 'backlog', plot: 'burndown', from: '2026-09-01', to: '2026-09-07', ...b }, { today: '2026-09-07' });

ta('a dropped item leaves the scope instead of burning down', async () => {
    const r = await syn({ unit: 'points', scope: { kind: 'epic', id: 10 } });
    const rem = r.data.series[0].y, scope = r.data.series[1].y;
    // 09-01: 11(3) + 12(2) = 5 · 09-02: +13(1) = 6 · 09-03: +14(M → 0) · 09-04: 12 shipped −2−… 13 open, +15(5)
    // 09-05: 11 dropped · 09-06: 13 done (no History: its update day).
    assert.deepEqual(rem, [5, 6, 6, 9, 6, 5, 5]);
    assert.deepEqual(scope, [5, 6, 6, 11, 8, 8, 8], 'the drop on 09-05 does not show in the scope');
    assert.equal(scope[3] - scope[4], 3, 'the scope does not fall by the dropped points');
    assert.equal(scope[4], scope[5], 'finishing an item changed the scope');
    assert.match(r.data.note, /1 non-numeric estimate \(like M or \?\) left out/);
});

ta('a custom status in the finished category counts as burned down', async () => {
    const r = await syn({ unit: 'items', scope: { kind: 'epic', id: 10 } });
    // items: 11,12 · +13 · +14 · 12 shipped, +15 · 11 dropped · 13 done
    assert.deepEqual(r.data.series[0].y, [2, 3, 4, 4, 3, 2, 2]);
    assert.deepEqual(r.data.series[1].y, [2, 3, 4, 5, 4, 4, 4]);
});

ta('scopes: epic (all descendants), phase, and all of the backlog', async () => {
    const at = (r) => valuesOn(r)['2026-09-07'];
    assert.equal(at(await syn({ unit: 'items', scope: { kind: 'epic', id: 10 } })), 2, 'epic: 14 and 15');
    assert.equal(at(await syn({ unit: 'items', scope: { kind: 'phase', phase: 'p1' } })), 2, 'p1: 10 and 14');
    assert.equal(at(await syn({ unit: 'items', scope: { kind: 'phase', phase: 'p2' } })), 2, 'p2: 15 and 16');
    assert.equal(at(await syn({ unit: 'items', scope: { kind: 'all' } })), 4, 'all: 10, 14, 15, 16');
    assert.match((await syn({ scope: { kind: 'epic', id: 99 } })).empty, /epic #99 no longer exists/);
    assert.match((await syn({ scope: { kind: 'phase', phase: 'nope' } })).empty, /No records are in this burndown/);
});

ta('an item added mid-range steps the line up on its created day', async () => {
    const r = await syn({ unit: 'points', scope: { kind: 'phase', phase: 'p2' }, from: '2026-09-01' });
    assert.deepEqual(r.data.series[0].y, [8, 8, 8, 13, 13, 13, 13]);
});

t('replaying status: (unset) first, no History, a finished record without History, a hand edit', () => {
    const fin = (s) => s === 'done' || s === 'dropped';
    const h = [{ date: '2026-09-03', from: '', to: 'draft' }, { date: '2026-09-05 10:00', from: 'draft', to: 'review' }];
    assert.equal(series.statusAt(h, '2026-09-02', 'review', '2026-09-05', false), '', 'before its first line');
    assert.equal(series.statusAt(h, '2026-09-04', 'review', '2026-09-05', false), 'draft');
    assert.equal(series.statusAt(h, '2026-09-05', 'review', '2026-09-05', false), 'review');
    assert.equal(series.statusAt([], '2026-09-01', 'review', '2026-09-05', false), 'review', 'no History: its status since created');
    assert.equal(series.statusAt([], '2026-09-04', 'done', '2026-09-05', fin('done')), '', 'finished, no History: open before updated');
    assert.equal(series.statusAt([], '2026-09-05', 'done', '2026-09-05', true), 'done', 'finished at updated');
    assert.equal(series.statusAt(h, '2026-09-06', 'done', '2026-09-07', true), 'review', 'a hand edit holds only from updated');
    assert.equal(series.statusAt(h, '2026-09-07', 'done', '2026-09-07', true), 'done');
});

ta('a bugs burndown is the open-bug count of a filter over a date range', async () => {
    const bugs = [
        { id: 1, type: 'story', status: 'draft', assignee: 'ann', created: '2026-09-01', updated: '2026-09-01' },
        { id: 2, type: 'story', status: 'done', assignee: 'ann', created: '2026-09-02', updated: '2026-09-04' },
        { id: 3, type: 'story', status: 'done', assignee: 'bob', created: '2026-09-01', updated: '2026-09-03' },
    ];
    const base = fakeSource(bugs, { history: { 2: [{ date: '2026-09-03', from: 'draft', to: 'done' }] } });
    const src = { ...base, id: 'bugs', parentOf: undefined, pointsOf: undefined, phaseOf: undefined, dueOf: undefined };
    const ann = { expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'assignee', op: 'is', value: 'ann' }] } };
    const r = await resolve.resolveTile(src, { source: 'bugs', plot: 'burndown', unit: 'points', filter: ann, from: '2026-09-01', to: '2026-09-05' }, { today: '2026-09-05' });
    assert.equal(r.data.series[0].name, 'Remaining open bugs');
    assert.deepEqual(r.data.series[0].y, [1, 2, 1, 1, 1], 'bug 2 closed on 09-03 by History; bob\'s bug 3 is filtered out');
    assert.doesNotMatch(r.data.note, /Points are/, 'a bugs burndown counts bugs, not points');
});

console.log('\ndashboards: tracker records (STORY-0038)');

const sources = await import(join(ROOT, 'ui', 'js', 'dashboards', 'sources.js'));

/** Tracker-shaped records: a project over an epic over tasks, with the dueState the store derived on load. */
const TRK = [
    { id: 1, type: 'project', status: 'in-progress', assignee: 'ann', dueState: 'later', due: '2026-09-30', created: '2026-09-01', updated: '2026-09-01' },
    { id: 2, type: 'epic', parent: 1, status: 'in-progress', assignee: 'ann', dueState: 'overdue', created: '2026-09-01', updated: '2026-09-01' },
    { id: 3, type: 'task', parent: 2, status: 'draft', assignee: 'ann', dueState: 'overdue', created: '2026-09-02', updated: '2026-09-02' },
    { id: 4, type: 'task', parent: 2, status: 'draft', assignee: 'bob', dueState: 'soon', created: '2026-09-02', updated: '2026-09-02' },
    { id: 5, type: 'task', parent: 1, status: 'draft', assignee: 'bob', dueState: 'today', created: '2026-09-03', updated: '2026-09-03' },
    { id: 6, type: 'task', parent: 1, status: 'done', assignee: 'bob', dueState: 'done', created: '2026-09-03', updated: '2026-09-05' },
    { id: 7, type: 'task', status: 'draft', assignee: '', dueState: 'none', created: '2026-09-04', updated: '2026-09-04' },
];
function trackerSource(rows = TRK) {
    const src = fakeSource(rows);
    const fields = [...src.fields,
        { key: 'dueState', label: 'Due', type: 'enum', options: ['overdue', 'today', 'soon', 'later', 'none', 'done'], get: (i) => i.dueState || 'none' },
        sources.dueBucketField()];
    const model = createFilterModel({ fields, noun: 'item' });
    return { ...src, id: 'tracker', label: 'Tracker', fields, model, fieldByKey: (k) => fields.find((f) => f.key === k) || null };
}

t('the due bucket reads the load-time dueState: today and soon are this week', () => {
    assert.deepEqual(['overdue', 'today', 'soon', 'later', 'none', 'done', undefined, 'odd'].map(sources.dueBucketOf),
        ['overdue', 'week', 'week', 'later', 'none', 'done', 'none', 'none']);
});

ta('overdue, due this week and no date per assignee, and a click opens just those records', async () => {
    const src = trackerSource();
    const b = { source: 'tracker', types: ['task'], plot: 'count', field: 'assignee', split: 'dueBucket' };
    const r = await resolve.resolveTile(src, b);
    const by = Object.fromEntries(r.data.series.map((s) => [s.name, s.y]));
    assert.deepEqual(r.data.series[0].x, ['ann', 'bob', 'none']);
    assert.deepEqual(by, { Overdue: [1, 0, 0], 'Due this week': [0, 2, 0], 'No date': [0, 0, 1], Closed: [0, 1, 0] });
    const week = r.data.series.find((s) => s.name === 'Due this week');
    const d = resolve.drillExpr(src, b, week.customdata[1], 'Tasks');
    assert.deepEqual(TRK.filter(src.model.matcherFor(d.expr)).map((x) => x.id), [4, 5], 'the list disagrees with the bar');
    assert.equal(d.label, 'Tasks: bob · Due this week');
    const gone = await resolve.resolveTile(src, { ...b, split: 'cf.gone' });
    assert.match(gone.empty, /'gone' is no longer/);
});

ta('a burndown scopes to a PROJ record and everything under it', async () => {
    const src = trackerSource();
    const r = await resolve.resolveTile(src, { source: 'tracker', plot: 'burndown', unit: 'items', scope: { kind: 'project', id: 1 } }, { today: '2026-09-06' });
    assert.deepEqual(r.data.series[0].x[0], '2026-09-01');
    assert.equal(r.data.series[0].x.at(-1), '2026-09-30', 'the project\'s due date is not the end');
    // 2 · +3,4 · +5,6 · (none) · 6 done → 4; 7 is not under the project.
    assert.deepEqual(r.data.series[0].y.slice(0, 6), [1, 3, 5, 5, 4, 4]);
    assert.match((await resolve.resolveTile(src, { source: 'tracker', plot: 'burndown', scope: { kind: 'project', id: 99 } })).empty, /project #99 no longer exists/);
});

ta('with the tracker unavailable, a tracker tile explains itself instead of failing', async () => {
    const r = await resolve.resolveTile(null, { source: 'tracker', plot: 'count', field: 'assignee' });
    assert.match(r.empty, /tracker is not available here/);
    assert.equal(resolve.drillExpr(null, { source: 'tracker', plot: 'count', field: 'assignee' }, 'ann'), null);
    assert.ok(!sources.availableSources().some((s) => s.id === 'tracker'), 'offered without a tracker');
    assert.equal(sources.getSource('tracker'), null);
    assert.equal(await sources.loadTracker(), false);
});

for (const [name, fn] of pending) {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); fail++; }
}

console.log('\ndashboards: nothing heavy at boot');

t('the page loads FlexDesk tiles and charts only on demand', () => {
    for (const f of ['page.js', 'model.js', 'store.js', 'resolve.js', 'series.js', 'tile_editor.js']) {
        const src = readFileSync(join(ROOT, 'ui', 'js', 'dashboards', f), 'utf8');
        assert.doesNotMatch(src, /^\s*import[^(]*['"]@flexdesk\/(tiles|charts)['"]/m, `${f} imports them statically`);
    }
    const install = readFileSync(join(ROOT, 'ui', 'js', 'tiling', 'install.js'), 'utf8');
    assert.doesNotMatch(install, /^\s*import[^(]*['"]\.\.\/dashboards\//m, 'install.js imports the page statically');
});

t('Plotly is vendored, and only the dashboards page names it', () => {
    const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /plotly/i, 'index.html loads Plotly');
    assert.match(readFileSync(join(ROOT, 'ui', 'vendor', 'plotly', 'LICENSE'), 'utf8'), /MIT/);
    readFileSync(join(ROOT, 'ui', 'vendor', 'plotly', 'plotly-2.35.2.min.js'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
