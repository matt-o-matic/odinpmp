import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  accessNoticeMessage,
  canManageIdentity,
  canManageIntegrations,
  canRankProjects,
  canViewAgentMemory,
  deniedAccessFor,
  isWorkspaceAdmin,
} from '../src/lib/auth/access.js';

const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../src/views/HomeView.vue', import.meta.url), 'utf8');
const userSource = readFileSync(new URL('../src/views/UserView.vue', import.meta.url), 'utf8');

const admin = { capabilities: [], role: 'admin' };
const manager = { capabilities: [], role: 'manager' };
const member = { capabilities: [], role: 'user' };

test('ranking is limited to workspace admins and managers, matching the ranking service', () => {
  assert.equal(canRankProjects(admin), true);
  assert.equal(canRankProjects(manager), true);
  assert.equal(canRankProjects(member), false);
  assert.equal(canRankProjects({ role: 'member' }), false);
  assert.equal(canRankProjects(null), false);
});

test('admin and capability checks keep their existing rules', () => {
  assert.equal(isWorkspaceAdmin(admin), true);
  assert.equal(isWorkspaceAdmin(manager), false);
  assert.equal(canManageIdentity(admin), true);
  assert.equal(canManageIdentity({ capabilities: ['identity.manage'], role: 'user' }), true);
  assert.equal(canManageIdentity(member), false);
  assert.equal(canManageIntegrations({ capabilities: ['integrations.manage'], role: 'user' }), true);
  assert.equal(canManageIntegrations(manager), false);
});

test('route guards report a notice code for denied routes and nothing for allowed ones', () => {
  assert.equal(deniedAccessFor({ requiresAuth: true }, member), null);
  assert.equal(deniedAccessFor({ requiredAccess: 'rankProjects' }, member), 'rankProjects');
  assert.equal(deniedAccessFor({ requiredAccess: 'rankProjects' }, manager), null);
  assert.equal(deniedAccessFor({ requiresAdmin: true }, manager), 'admin');
  assert.equal(deniedAccessFor({ requiredCapability: 'identity.manage' }, { capabilities: ['identity.manage'], role: 'user' }), null);
  assert.equal(deniedAccessFor({ requiredCapability: 'reports.export' }, { capabilities: ['reports.export'], role: 'user' }), null);
  assert.equal(deniedAccessFor({ requiredCapability: 'reports.export' }, member), 'reports.export');
  assert.match(accessNoticeMessage('rankProjects'), /admins and managers/);
  assert.match(accessNoticeMessage('anything-else'), /don’t have access/);
  assert.equal(accessNoticeMessage(undefined), '');
});

test('the router guards ranking, adds the search route and redirects the old settings page', () => {
  assert.match(routerSource, /path: '\/ranking',[\s\S]*?meta: \{ requiresAuth: true, requiredAccess: 'rankProjects' \}/);
  assert.match(routerSource, /path: '\/search',\s*name: 'search',\s*component: SearchView,\s*meta: \{ requiresAuth: true \}/);
  assert.match(routerSource, /path: '\/settings',\s*redirect: \{ name: 'user', query: \{ tab: 'security' \} \}/);
  assert.match(routerSource, /deniedAccessFor\(to\.meta, authSession\.state\.currentUser\)/);
  assert.match(routerSource, /return \{ name: 'home', query: \{ notice: denied \} \}/);
  assert.equal(existsSync(new URL('../src/views/SettingsView.vue', import.meta.url)), false);
});

test('the shell hides Rank Projects from other roles and shows access notices', () => {
  // In the Plan menu (layout A, docs/odin-chat/plan.md).
  assert.match(appSource, /<li v-if="canRankProjects"><RouterLink class="dropdown-item" :to="\{ name: 'ranking' \}"/);
  assert.match(appSource, /from '\.\/lib\/auth\/access\.js'/);
  assert.doesNotMatch(appSource, /currentUser\.value\?\.role === 'admin'/);
  assert.match(appSource, /v-if="showChrome && accessNotice"/);
});

test('the navbar search submits to the search results page', () => {
  assert.match(appSource, /role="search"[^>]*@submit\.prevent="submitNavbarSearch"/);
  assert.match(appSource, /<input[^>]*v-model="navbarQuery"[^>]*type="search"/);
  assert.match(appSource, /router\.push\(\{ name: 'search', query: \{ q \} \}\)/);
});

test('security links point at the profile Security tab, which hosts two-factor setup', () => {
  assert.doesNotMatch(homeSource, /to="\/settings"/);
  assert.match(homeSource, /:to="\{ name: 'user', query: \{ tab: 'security' \} \}"/);
  assert.doesNotMatch(userSource, /to="\/settings"/);
  assert.match(userSource, /<TwoFactorSettings \/>/);
  assert.match(userSource, /tabFromQuery\(route\.query\.tab\)/);
});

test('the AI memory screen is open to workspace members and linked from the account menu', () => {
  assert.equal(canViewAgentMemory(member), true);
  assert.equal(canViewAgentMemory({ role: 'viewer' }), true);
  assert.equal(canViewAgentMemory({ capabilities: [] }), false);
  assert.equal(deniedAccessFor({ requiredAccess: 'agentMemory' }, member), null);
  assert.equal(deniedAccessFor({ requiredAccess: 'agentMemory' }, null), 'agentMemory');
  assert.match(accessNoticeMessage('agentMemory'), /workspace members/);
  assert.match(routerSource, /path: '\/ai-memory',\s*name: 'agent-memory',\s*component: AgentMemoryView,\s*meta: \{ requiresAuth: true, requiredAccess: 'agentMemory' \}/);
  assert.match(appSource, /<li v-if="canViewAgentMemory">\s*<RouterLink class="dropdown-item" to="\/ai-memory">What the AI remembers<\/RouterLink>/);
});
