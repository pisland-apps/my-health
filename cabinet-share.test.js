// Node test for the shared-medicine logic in app.js (v74) - run with:  node cabinet-share.test.js
// Pulls the real functions out of app.js and runs them against plain data.
const fs = require('fs');
const vm = require('vm');
const { mergeMembers, freshFieldVersions } = require('./merge-engine.js');
const APP = fs.readFileSync(__dirname + '/app.js', 'utf8');

function grabFn(header) {
  const i = APP.indexOf(header); if (i < 0) throw new Error('not found: ' + header);
  let j = APP.indexOf('{', i), depth = 0;
  for (; j < APP.length; j++) { if (APP[j] === '{') depth++; else if (APP[j] === '}' && --depth === 0) break; }
  return APP.slice(i, j + 1);
}
const grabLine = (start) => { const i = APP.indexOf(start); const j = APP.indexOf('\n', i); return APP.slice(i, j); };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.error('FAIL: ' + name + (detail ? '\n  ' + detail : '')); } };

const ctx = vm.createContext({ console });
vm.runInContext([
  `const CABINET_TYPE = 'Home Medicine';`,
  grabLine('const CAB_DATE_RE'),
  grabFn('function live(arr)'),
  `function escapeHtml(x) { return String(x == null ? '' : x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }`,
  `function localDateStr() { return '2026-11-03'; }`,
  grabFn('function ownCabinetItems'), grabFn('function sharedCabinetFromOthers'), grabFn('function cabinetItems'), grabFn('function cabinetOwnerOf'),
  grabFn('function expiryInfo'), grabFn('function sortedCabinet'), grabFn('function renderCabinet'),
  `let members = [];`
].join('\n'), ctx);
const run = (c) => vm.runInContext(c, ctx);

const T0 = '2026-11-01T00:00:00.000Z';
const med = (id, title, extra) => Object.assign({ id, type: 'Home Medicine', title, date: '2026-11-01', version: 1, updatedAt: T0, deletedAt: null, schemaVersion: 1 }, extra || {});
const mem = (id, name, records) => ({ id, name, version: 1, updatedAt: T0, deletedAt: null, schemaVersion: 1, fieldVersion: freshFieldVersions(), records, customReminders: [], historyEntries: [] });

const data = () => [
  mem('dad', 'Dad', [med('A', 'Dad private'), med('B', 'Panadol', { shared: true, expiry: '2027-05-01' }), { id: 'chk', type: 'Checkup', title: 'Checkup', date: '2026-10-01', version: 1, updatedAt: T0, deletedAt: null }]),
  mem('mom', 'Mom', [med('C', 'Lomide', { shared: true }), med('D', 'Mom private')]),
  mem('kid', 'Kid', [med('E', 'Kid private')])
];
const titles = (id) => run(`cabinetItems(members.find(m => m.id === ${JSON.stringify(id)}))`).map(r => r.title).sort();
const setMembers = (m) => { ctx.__m = m; run('members = __m'); };

// ---- who sees what ----
setMembers(data());
ok('Dad sees own private + own shared + Mom\'s shared', JSON.stringify(titles('dad')) === JSON.stringify(['Dad private', 'Lomide', 'Panadol']), titles('dad').join());
ok('Mom sees own private + shared from Dad', JSON.stringify(titles('mom')) === JSON.stringify(['Lomide', 'Mom private', 'Panadol']), titles('mom').join());
ok('Kid sees only own private + the two shared', JSON.stringify(titles('kid')) === JSON.stringify(['Kid private', 'Lomide', 'Panadol']), titles('kid').join());
ok('private medicine is invisible to others', !titles('mom').includes('Dad private') && !titles('kid').includes('Mom private'));
ok('a shared item is listed once for its owner', titles('dad').filter(t => t === 'Panadol').length === 1);
ok('non-cabinet records never appear', !titles('dad').includes('Checkup'));
ok('owner lookup finds the member that holds the record', run(`cabinetOwnerOf('B').id`) === 'dad' && run(`cabinetOwnerOf('C').id`) === 'mom');
ok('owner lookup ignores non-cabinet records', run(`cabinetOwnerOf('chk')`) === null);

// ---- rendering ----
const html = run(`renderCabinet(members.find(m => m.id === 'mom'))`);
const iShared = html.indexOf('Shared with the whole family'), iPriv = html.indexOf('Only for Mom');
ok('render: shared section comes before the private one', iShared > -1 && iPriv > iShared);
ok('render: item shared by someone else is labelled with the owner', /Shared by Dad/.test(html) && html.indexOf('Panadol') > iShared && html.indexOf('Panadol') < iPriv);
ok('render: own shared item is labelled just "Shared"', /👪 Shared<\/span>/.test(html));
ok('render: own private item sits under "Only for Mom"', html.indexOf('Mom private') > iPriv);
ok('render: other people\'s private medicines are not in the HTML', !/Dad private|Kid private/.test(html));
ok('render: every card has Edit and Delete', (html.match(/data-cab-edit=/g) || []).length === 3 && (html.match(/data-cab-del=/g) || []).length === 3);
const emptyHtml = run(`(members = [${JSON.stringify(mem('solo', 'Solo', []))}], renderCabinet(members[0]))`);
ok('render: empty cabinet shows both hints', /Nothing shared yet/.test(emptyHtml) && /Nothing private here yet/.test(emptyHtml));
ok('render: escapes names (no HTML injection)', !/<script/.test(run(`(members = [${JSON.stringify(mem('x', '<script>alert(1)</script>', [med('Z', '<b>bold</b>', { shared: true })]))}, ${JSON.stringify(mem('y', 'Y', []))}], renderCabinet(members[1]))`)));

// ---- lifecycle ----
let d = data();
d[0].records[1].shared = false;
setMembers(d);
ok('un-sharing removes it from other members', !titles('mom').includes('Panadol') && titles('dad').includes('Panadol'));
d = data(); d[0].records[1].deletedAt = '2026-11-02T00:00:00.000Z';
setMembers(d);
ok('a deleted shared medicine disappears for everyone', !titles('mom').includes('Panadol') && !titles('dad').includes('Panadol'));
d = data(); d[1].deletedAt = '2026-11-02T00:00:00.000Z';
setMembers(d);
ok('deleting a member removes the medicines they shared', !titles('dad').includes('Lomide') && !titles('kid').includes('Lomide'));

// ---- merge/sync carries the flag ----
const A = data(), B = data();
B[0].records[0].shared = true; B[0].records[0].version = 2; B[0].records[0].updatedAt = '2026-11-02T00:00:00.000Z'; // Dad shares "Dad private" on device B
const r1 = mergeMembers(A, B);
ok('sync: turning sharing on propagates to the other device', r1.members[0].records[0].shared === true && r1.conflicts.length === 0);
const C1 = data(), C2 = data();
C1[0].records[1].shared = false; C1[0].records[1].version = 2; C1[0].records[1].updatedAt = '2026-11-02T01:00:00.000Z';
C2[0].records[1].title = 'Panadol (edited)'; C2[0].records[1].version = 2; C2[0].records[1].updatedAt = '2026-11-02T02:00:00.000Z';
const r2 = mergeMembers(C1, C2);
ok('sync: same medicine changed on two devices is reported, not silently lost', r2.conflicts.length >= 1, 'conflicts=' + r2.conflicts.length);
const old = data(), neu = data();
neu[0].records[1].shared = false; neu[0].records[1].version = 2; neu[0].records[1].updatedAt = '2026-11-02T01:00:00.000Z';
ok('sync: a newer "stop sharing" wins over an older copy', mergeMembers(old, neu).members[0].records[1].shared === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
