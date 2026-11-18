import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import express from 'express';
import mysql from 'mysql2/promise';
import request from 'supertest';

import { createAuditWriter } from '../src/lib/audit/audit-writer.js';
import { createHttpAuditMiddleware } from '../src/lib/audit/http-audit-middleware.js';
import { recordAuditPolicyDecision } from '../src/lib/audit/audit-context.js';

// Production's audit_log.detail is TEXT, which holds 65,535 bytes.
const DETAIL_LIMIT = 65535;
const MARKER = 'FILE-BYTES-MARKER';
// About 200 KB, like a screenshot; per-byte keys from a body this size overflow the detail column.
const upload = () => Buffer.concat([Buffer.from(MARKER), Buffer.alloc(200 * 1024, 7)]);

// An app with the real body parsers, an authenticated application actor and the audit middleware.
function auditedApp(auditWriter) {
  const app = express();
  app.use((req, _res, next) => { req.auth = { user: { id: 'oauth-application:app-1', tenantId: 'tenant-1' } }; next(); });
  app.use(createHttpAuditMiddleware({ auditWriter }));
  app.put('/files/:name', express.raw({ type: () => true, limit: '1mb' }), (req, res) => res.json({ bytes: req.body.length }));
  app.put('/items/:id', express.json(), (req, res) => res.json({ ok: true }));
  return app;
}

test('HTTP audit middleware appends authenticated mutation outcomes without body values', async () => {
  const events = [];
  const auditWriter = {
    async append(event) {
      events.push(event);
    },
  };
  const request = {
    auth: { user: { id: 'user-1', tenantId: 'tenant-1' } },
    baseUrl: '/api/projects',
    body: { description: 'sensitive body value', name: 'Launch' },
    id: 'request-1',
    ip: '127.0.0.1',
    method: 'PUT',
    originalUrl: '/api/projects/project-1',
    params: { projectId: 'project-1' },
    route: { path: '/:projectId' },
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  let nextCalled = false;

  createHttpAuditMiddleware({ auditWriter })(request, response, () => {
    nextCalled = true;
    recordAuditPolicyDecision({ allowed: true, capability: 'project.plan.edit', projectId: 'project-1', projectRole: 'editor', tenantRole: 'user' });
  });
  response.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(nextCalled, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    action: 'http.put./api/projects/:projectId',
    detail: {
      actor: { actorId: 'user-1', effectiveUserId: 'user-1', impersonationGrantId: null },
      breakGlass: null,
      after: null,
      before: null,
      bodyKeys: ['description', 'name'],
      dataClassification: 'internal',
      method: 'PUT',
      policyDecisions: [{ capability: 'project.plan.edit', decision: 'allow', projectId: 'project-1', projectRole: 'editor', tenantRole: 'user' }],
      requestId: 'request-1',
      route: '/api/projects/project-1',
      source: 'http',
      statusCode: 200,
      traceId: 'request-1',
    },
    ipAddress: '127.0.0.1',
    projectId: 'project-1',
    result: 'success:200',
    tenantId: 'tenant-1',
    userId: 'user-1',
  });
  assert.equal(JSON.stringify(events[0]).includes('sensitive body value'), false);
});

test('HTTP audit middleware attributes impersonated mutations to the real actor and effective user', async () => {
  const events = [];
  const request = {
    auth: {
      actor: { id: 'support-admin' },
      impersonation: { grantId: 'grant-1' },
      user: { id: 'target-user', tenantId: 'tenant-1' },
    },
    baseUrl: '/api/projects',
    body: {},
    id: 'request-2',
    ip: '127.0.0.1',
    method: 'PATCH',
    originalUrl: '/api/projects/project-1',
    params: { projectId: 'project-1' },
    route: { path: '/:projectId' },
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  createHttpAuditMiddleware({ auditWriter: { append: async (event) => events.push(event) } })(request, response, () => {});
  response.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events[0].userId, 'support-admin');
  assert.deepEqual(events[0].detail.actor, {
    actorId: 'support-admin',
    effectiveUserId: 'target-user',
    impersonationGrantId: 'grant-1',
  });
});

test('HTTP audit middleware ignores reads and unauthenticated mutations', async () => {
  const events = [];
  const middleware = createHttpAuditMiddleware({
    auditWriter: { append: async (event) => events.push(event) },
  });

  for (const request of [
    { auth: { user: { id: 'user-1' } }, method: 'GET' },
    { method: 'POST' },
  ]) {
    const response = new EventEmitter();
    response.statusCode = 200;
    middleware(request, response, () => {});
    response.emit('finish');
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, []);
});

test('HTTP audit middleware lists no keys for binary bodies and still lists form keys', async () => {
  const events = [];
  const middleware = createHttpAuditMiddleware({ auditWriter: { append: async (event) => events.push(event) } });
  const form = Object.assign(Object.create(null), { title: 'Bug', priority: 'High' });
  for (const body of [upload(), new Uint8Array(upload()), form]) {
    const response = new EventEmitter();
    response.statusCode = 200;
    middleware({ auth: { user: { id: 'user-1' } }, body, ip: '127.0.0.1', method: 'PUT', originalUrl: '/upload' }, response, () => {});
    response.emit('finish');
  }
  await new Promise((resolve) => setImmediate(resolve));

  // Counts first, so a regression fails quickly instead of diffing a key per byte.
  assert.deepEqual(events.map((event) => event.detail.bodyKeys.length), [0, 0, 2]);
  assert.deepEqual(events[2].detail.bodyKeys, ['priority', 'title']);
  for (const event of events) assert.equal(JSON.stringify(event).includes(MARKER), false);
});

test('HTTP audit middleware records raw uploads without their bytes and JSON bodies by key', async () => {
  const events = [];
  const app = auditedApp({ append: async (event) => events.push(event) });

  const uploaded = await request(app).put('/files/shot.png').set('Content-Type', 'image/png').send(upload());
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.bytes, upload().length);
  const edited = await request(app).put('/items/item-1').send({ title: 'Renamed', priority: 2 });
  assert.equal(edited.status, 200);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.map((event) => [event.result, event.detail.bodyKeys.length]), [['success:200', 0], ['success:200', 2]]);
  assert.deepEqual(events[1].detail.bodyKeys, ['priority', 'title']);
  const detail = JSON.stringify(events[0].detail);
  assert.ok(Buffer.byteLength(detail) < 2000, `audit detail is ${Buffer.byteLength(detail)} bytes`);
  assert.equal(detail.includes(MARKER), false);
});

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
test('MySQL audit log stores a raw upload event within the detail column', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `odin_http_audit_${process.pid}`;
  const admin = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  parsed.pathname = `/${database}`;
  const pool = mysql.createPool(parsed.toString());
  try {
    // Production's audit_log definition.
    await pool.query("CREATE TABLE tenants (id char(36) NOT NULL PRIMARY KEY)");
    await pool.query("CREATE TABLE projects (id char(36) NOT NULL PRIMARY KEY)");
    await pool.query(`CREATE TABLE audit_log (id char(36) NOT NULL DEFAULT (uuid()), dt_stamp timestamp NULL DEFAULT CURRENT_TIMESTAMP, user_id varchar(255) NOT NULL,
      tenant_id char(36) DEFAULT NULL, project_id char(36) DEFAULT NULL, ip_addr varchar(100) NOT NULL, action varchar(100) NOT NULL, result varchar(200) NOT NULL, detail text,
      PRIMARY KEY (id), FOREIGN KEY (tenant_id) REFERENCES tenants (id), FOREIGN KEY (project_id) REFERENCES projects (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await pool.query("INSERT INTO tenants VALUES ('tenant-1')");
    const failures = [];
    const writer = createAuditWriter({ executor: pool });
    const app = auditedApp({ append: (event) => writer.append(event).catch((error) => { failures.push(error); throw error; }) });

    assert.equal((await request(app).put('/files/shot.png').set('Content-Type', 'image/png').send(upload())).status, 200);
    let rows = [];
    for (let attempt = 0; attempt < 50 && !rows.length && !failures.length; attempt++) {
      [rows] = await pool.query('SELECT user_id AS userId, action, result, detail FROM audit_log');
      if (!rows.length) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(failures, []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'oauth-application:app-1');
    assert.equal(rows[0].result, 'success:200');
    assert.ok(Buffer.byteLength(rows[0].detail) < DETAIL_LIMIT);
    assert.deepEqual(JSON.parse(rows[0].detail).bodyKeys, []);
    assert.equal(rows[0].detail.includes(MARKER), false);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
