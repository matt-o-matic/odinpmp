import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Odin proper's top bar: Home, Work, Chat, Plan, Insights, search with Ctrl+K, the bell's slot,
// AI Workspace and the account menu. Every page the old top bar linked must still be linked from
// it, by route name or path, and each must exist.

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
const nav = appSource.slice(appSource.indexOf('<nav v-if="showChrome"'), appSource.indexOf('</nav>'));

// The old top bar's links, by route name and path: its 11 items, New project and the recent
// projects, search, and the account menu.
const FORMER_TOP_LEVEL = [
  ['home', '/'],
  ['leaderboard', '/leaderboard'],
  ['ranking', '/ranking'],
  ['portfolio', '/portfolio'],
  ['resources', '/resources'],
  ['finance', '/finance'],
  ['workflows', '/workflows'],
  ['tickets', '/tickets'],
  ['reporting', '/reports'],
  ['engagements', '/engagements'],
  ['projects', '/projects'],
  ['project-detail', '/projects/:projectId'],
  ['search', '/search'],
];
const ACCOUNT_MENU = ['/user', '/ai-memory', '/workspace-access', '/admin', '/admin/compliance', '/admin/ticketing', '/admin/identity', '/admin/integrations'];

const linked = (name, path) => nav.includes(`{ name: '${name}'`) || nav.includes(`to="${path}"`);

test('every page the old top bar linked is still linked from it, and still routed', () => {
  for (const [name, path] of FORMER_TOP_LEVEL) {
    assert.ok(routerSource.includes(`name: '${name}'`), `route ${name} exists`);
    assert.ok(routerSource.includes(`path: '${path}'`), `path ${path} exists`);
    if (name === 'search') assert.match(nav, /router\.push\(\{ name: 'search'|@submit\.prevent="submitNavbarSearch"/);
    else assert.ok(linked(name, path), `${name} (${path}) is linked from the top bar`);
  }
  assert.match(nav, /:to="\{ name: 'projects', query: \{ new: 'project' \} \}"/, 'New project');
  for (const path of ACCOUNT_MENU) assert.ok(nav.includes(`to="${path}"`), `${path} stays in the account menu`);
  assert.match(nav, /AI Workspace/);
});

test('the bar groups pages into Home, Work, Chat, Plan and Insights, with the rest after search', () => {
  const order = ['>Home<', 'id="workMenu"', 'data-testid="topbar-chat"', 'id="planMenu"', 'id="insightsMenu"', 'role="search"', 'data-slot="notifications-bell"', 'AI Workspace', 'aria-label="Account menu"'];
  let at = -1;
  for (const marker of order) {
    const found = nav.indexOf(marker, at + 1);
    assert.ok(found > at, `${JSON.stringify(marker)} comes next`);
    at = found;
  }
  const menu = (id) => nav.slice(nav.indexOf(`aria-labelledby="${id}"`), nav.indexOf('</ul>', nav.indexOf(`aria-labelledby="${id}"`)));
  // Work is three columns (projects, engagements, tickets), each with its page, New and recent.
  const work = nav.slice(nav.indexOf('aria-labelledby="workMenu"'), nav.indexOf("name: 'chat-home'"));
  assert.deepEqual([...work.matchAll(/name: '([a-z-]+)'/g)].map((match) => match[1]), ['projects', 'projects', 'project-detail', 'engagements', 'engagements', 'engagement-detail', 'tickets', 'tickets']);
  assert.match(work, /:to="\{ name: 'engagements', query: \{ new: 'engagement' \} \}"/, 'New engagement');
  assert.match(work, /:to="\{ name: 'tickets', query: \{ new: 'ticket' \} \}"/, 'New ticket');
  assert.match(work, /:to="ticketMenuLocation\(ticket\)"/, 'Recent tickets');
  assert.deepEqual([...menu('planMenu').matchAll(/name: '([a-z-]+)'/g)].map((match) => match[1]), ['portfolio', 'ranking', 'resources', 'finance', 'workflows']);
  assert.deepEqual([...menu('insightsMenu').matchAll(/name: '([a-z-]+)'/g)].map((match) => match[1]), ['reporting', 'leaderboard']);
  assert.match(nav, /<section v-if="showEngagements" class="app-work-menu__column"/, 'Engagements only with the Consulting module');
  assert.match(nav, /:to="\{ name: 'chat-home' \}"[^>]*data-testid="topbar-chat"/, 'Chat opens Odin Chat');
  assert.match(appSource, /event\.key\.toLowerCase\(\) !== 'k'/, 'Ctrl+K goes to search');
});

test('Odin Chat and the guest view have their own layout, without the top bar', () => {
  assert.match(appSource, /&& !isChatLayout\.value;/);
  assert.match(appSource, /<RouterView v-if="isChatLayout" \/>/);
  assert.match(appSource, /v-if="!isChatLayout && \(assistantRouteState\.open/);
  for (const name of ['chat-home', 'chat-mentions', 'chat-threads', 'chat-search', 'chat-odin', 'chat-direct', 'chat-channel', 'guest-home', 'guest-channel']) {
    assert.match(routerSource, new RegExp(`name: '${name}', component: \\w+, meta: \\{ chatLayout: true`), `${name} uses the Chat layout`);
  }
});
