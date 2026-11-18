import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { createMysqlSigningRepository } from '../src/modules/signing/signing.repository.js';

// Document signing on MySQL (docs/document-signing, AC-09 and AC-10), from a database built like
// production's: the legacy schema plus every migration. document-signing.test.js covers the
// routes on the in-memory repositories.

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

function memoryStorage() {
  const objects = new Map();
  return {
    async delete(id) { objects.delete(id); },
    async read(id) {
      if (!objects.has(id)) throw new Error(`No object ${id}`);
      return { bytes: objects.get(id), size: objects.get(id).length };
    },
    async write(id, bytes) { objects.set(id, Buffer.from(bytes)); },
  };
}

test('MySQL stores file audience and signature requests, protects signed files, and lets one of two racing changes win', { skip: !databaseUrl, timeout: 400_000 }, async () => {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_sign_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool({ uri: isolatedUrl.toString(), connectionLimit: 5 });
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });
    // The migration is additive and safe to run again.
    const { ensureMysqlDocumentSigningSchema } = await import('../src/modules/signing/signing-schema.js');
    await ensureMysqlDocumentSigningSchema(pool);

    const tenantId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const user = { id: userId, name: 'Pia Manager' };
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Signing Tenant']);
    await pool.execute('INSERT INTO users (id, name, email, authentication_method_id) VALUES (?, ?, ?, 1)', [userId, user.name, `${userId}@acme.test`]);
    const [statuses] = await pool.execute('SELECT id FROM project_statuses ORDER BY id LIMIT 1');
    await pool.execute('INSERT INTO projects (id, tenant_id, name, description, project_status, deleted) VALUES (?, ?, ?, ?, ?, 0)', [projectId, tenantId, 'Signing', '', statuses[0].id]);
    const projects = createMysqlProjectsRepository({ fileStorage: memoryStorage(), pool });

    // A file starts internal, can be shared, and its version source pins the stored bytes.
    const saved = await projects.saveFile({ fileContentsBase64: Buffer.from('contract v1').toString('base64'), fileDescription: '', fileName: 'contract.pdf', fileType: 'application/pdf', projectId, targetId: projectId, targetType: 'project', tenantId, user });
    assert.equal(saved.audience, 'internal');
    const shared = await projects.setFileAudience({ audience: 'external', fileId: saved.id, projectId, tenantId, user });
    assert.deepEqual([shared.changed, shared.file.audience], [true, 'external']);
    assert.equal((await projects.setFileAudience({ audience: 'external', fileId: saved.id, projectId, tenantId, user })).changed, false);
    const source = await projects.getFileVersionSource({ fileId: saved.id, tenantId });
    assert.equal(source.bytes.toString(), 'contract v1');
    await projects.saveFileVersion({ expectedVersion: 1, fileContentsBase64: Buffer.from('contract v2').toString('base64'), fileId: saved.id, projectId, tenantId, user });
    assert.equal((await projects.readStoredObject(source.storageKey)).toString(), 'contract v1', 'the pinned object outlives a new version');
    assert.equal((await projects.getFileVersionSource({ fileId: saved.id, tenantId, version: 1 })).storageKey, source.storageKey);
    const [changes] = await pool.execute("SELECT action, detail_json FROM project_change_log WHERE entity_id = ? AND action = 'audience'", [saved.id]);
    assert.equal(changes.length, 1);

    const signing = createMysqlSigningRepository({ pool });
    const stakeholderId = randomUUID();
    const at = new Date().toISOString();
    const newRequest = async () => {
      const requestId = randomUUID();
      await signing.createRequest({
        changes: [{ action: 'create', actorId: userId, detail: { kind: 'acceptance' }, entityId: requestId, entityType: 'signing', itemId: null, projectId, tenantId }],
        documents: [{ contentType: 'application/pdf', fileId: saved.id, fileName: 'contract.pdf', fileSize: 11, id: randomUUID(), position: 0, projectId, requestId, sha256: 'a'.repeat(64), storageKey: source.storageKey, tenantId, version: 1 }],
        events: [{ action: 'requested', actor: `user:${userId}`, createdAt: at, detail: { documents: 1 }, projectId, requestId, tenantId }],
        request: { createdAt: at, createdBy: `user:${userId}`, endReason: null, endedAt: null, endedBy: null, id: requestId, kind: 'acceptance', manifestHash: null, manifestJson: null, message: '', packageHash: 'b'.repeat(64), packageJson: '{}', projectId, seal: null, sealKeyId: null, statement: 'I accept.', status: 'pending', subjectId: saved.id, subjectType: 'file', tenantId, title: 'Contract', updatedAt: at },
        signers: [{ codeAttempts: 0, email: 'jamie@client.example', id: randomUUID(), mailStatus: null, name: 'Jamie', position: 0, projectId, requestId, stakeholderId, status: 'pending', tenantId }],
      });
      return requestId;
    };
    const requestId = await newRequest();
    const detail = await signing.getRequest({ projectId, requestId, tenantId });
    assert.equal(detail.request.status, 'pending');
    assert.equal(detail.documents[0].version, 1);
    assert.equal(detail.events[0].detail.documents, 1);
    assert.equal(await signing.getRequest({ projectId: randomUUID(), requestId, tenantId }), null, 'another project cannot read it');
    assert.deepEqual(await signing.listProtectedFileIds({ fileIds: [saved.id, randomUUID()], tenantId }), [saved.id]);
    assert.deepEqual((await signing.listRequests({ fileId: saved.id, projectId, tenantId })).map((entry) => entry.request.id), [requestId]);

    // The stakeholder's link stays alive while they are asked to sign.
    const requirements = createMysqlRequirementsRepository({ pool });
    const involved = await requirements.listStakeholderInvolvement({ projectId, stakeholderId, tenantId });
    assert.deepEqual(involved.signings.map((entry) => entry.endedAt), [null]);

    // A signature and a cancellation race: exactly one wins, the other sees the request ended.
    const signerId = detail.signers[0].id;
    const sign = signing.withRequest({ projectId, requestId, tenantId }, async (latest) => {
      if (latest.request.status !== 'pending') throw new Error('not pending');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const signedAt = new Date().toISOString();
      return {
        changes: {
          events: [{ action: 'signed', actor: `stakeholder:${stakeholderId}`, createdAt: signedAt, projectId, requestId, signerId, tenantId }],
          request: { endedAt: signedAt, endedBy: 'system', manifestHash: 'c'.repeat(64), manifestJson: '{}', seal: 'seal', sealKeyId: 'dev-1', status: 'completed', updatedAt: signedAt },
          signature: { evidenceHash: 'd'.repeat(64), evidenceJson: '{}', projectId, requestId, seal: 'seal', sealKeyId: 'dev-1', signedAt, signerId, tenantId },
          signers: [{ id: signerId, signedAt, signedName: 'Jamie Ortiz', status: 'signed' }],
        },
      };
    });
    const cancel = signing.withRequest({ projectId, requestId, tenantId }, async (latest) => {
      if (latest.request.status !== 'pending') throw new Error('not pending');
      const endedAt = new Date().toISOString();
      return { changes: { request: { endedAt, endedBy: `user:${userId}`, status: 'cancelled', updatedAt: endedAt } } };
    });
    const outcomes = await Promise.allSettled([sign, cancel]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1, JSON.stringify(outcomes.map((outcome) => outcome.reason?.message ?? 'ok')));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason.message === 'not pending').length, 1);
    const settled = await signing.getRequest({ projectId, requestId, tenantId });
    assert.ok(['completed', 'cancelled'].includes(settled.request.status));
    assert.equal(settled.signatures.length, settled.request.status === 'completed' ? 1 : 0);
    const after = await requirements.listStakeholderInvolvement({ projectId, stakeholderId, tenantId });
    assert.notEqual(after.signings[0].endedAt, null);
    // A completed request keeps protecting its file; a cancelled one does not.
    assert.deepEqual(await signing.listProtectedFileIds({ fileIds: [saved.id], tenantId }), settled.request.status === 'completed' ? [saved.id] : []);
    const [logged] = await pool.execute("SELECT action FROM project_change_log WHERE entity_type = 'signing' AND entity_id = ?", [requestId]);
    assert.deepEqual(logged.map((row) => row.action), ['create']);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});
