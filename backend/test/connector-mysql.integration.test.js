import assert from 'node:assert/strict';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { processConnectorInboundBatch } from '../src/modules/connectors/connector-inbound-worker.js';
import { createMysqlConnectorRepository } from '../src/modules/connectors/connector.repository.js';
import { applyMysqlMigrations } from './helpers/mysql-migrations.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();
const MIGRATIONS = [
  '0031_connector_platform',
  '0036_connector_inbound_worker',
  '0038_connector_marketplace_governance',
  '0042_connector_erp_posting',
  '0043_connector_sync_worker',
  '0045_connector_provider_erasure',
  '0046_connector_oauth',
];

test(
  'MySQL connector repository persists secure connections, mappings, events, and idempotent runs',
  { skip: !databaseUrl, timeout: 10_000 },
  async () => {
    const pool = mysql.createPool(databaseUrl);
    try {
      await applyMysqlMigrations(pool, MIGRATIONS);
      const repository = createMysqlConnectorRepository({ pool });
      const tenantId = `tenant-connectors-${process.pid}`;
      const connection = await repository.createConnection({
        inboundSecretHash: 'a'.repeat(64),
        input: {
          authType: 'webhook',
          conflictPolicy: 'manual',
          name: 'GitHub engineering',
          projectIds: ['project-1'],
          provider: 'github',
          scopes: ['issues:read'],
          secretReference: 'vault://connectors/github',
          settings: { organization: 'new-era' },
          status: 'active',
          syncDirection: 'bidirectional',
        },
        tenantId,
        userId: 'admin-1',
      });
      assert.equal(connection.inboundSecretHash, undefined);
      assert.equal(
        (
          await repository.authenticateInbound({
            connectionId: connection.id,
            secretHash: 'a'.repeat(64),
          })
        ).id,
        connection.id,
      );
      assert.equal(
        await repository.authenticateInbound({
          connectionId: connection.id,
          secretHash: 'b'.repeat(64),
        }),
        null,
      );

      const mapping = await repository.createMapping({
        input: {
          connectionId: connection.id,
          externalId: 'issue-100',
          objectType: 'issue',
          odinId: 'task-100',
          projectId: 'project-1',
        },
        tenantId,
      });
      assert.equal(mapping.externalId, 'issue-100');
      await assert.rejects(
        repository.createMapping({
          input: {
            connectionId: connection.id,
            externalId: 'issue-100',
            objectType: 'issue',
            odinId: 'task-other',
            projectId: 'project-1',
          },
          tenantId,
        }),
        (error) => error.statusCode === 409,
      );
      const conflict = await repository.createConflict({
        input: {
          connectionId: connection.id,
          externalPayloadHash: 'd'.repeat(64),
          mappingId: mapping.id,
          note: 'Both records changed.',
          objectType: 'issue',
          odinPayloadHash: 'e'.repeat(64),
        },
        tenantId,
      });
      assert.equal(
        (
          await repository.resolveConflict({
            conflictId: conflict.id,
            input: {
              expectedVersion: 1,
              note: 'Keep source.',
              resolution: 'source_wins',
            },
            tenantId,
            userId: 'admin-1',
          })
        ).status,
        'resolved',
      );

      const eventInput = {
        connection,
        eventId: 'event-100',
        eventType: 'issues.updated',
        payload: { issue: 100 },
        payloadHash: 'c'.repeat(64),
      };
      const recordedEvent = await repository.recordInboundEvent(eventInput);
      assert.equal(recordedEvent.duplicate, false);
      assert.equal(
        (await repository.recordInboundEvent(eventInput)).duplicate,
        true,
      );
      assert.equal((await repository.completeInboundEvent({ eventId: recordedEvent.event.id, expectedVersion: 1, tenantId })).status, 'processed');
      await repository.recordInboundEvent({ connection, eventId: 'event-worker-101', eventType: 'issues.updated', payload: { externalId: 'issue-101', fields: { title: 'Worker projection' }, kind: 'source_work', schemaVersion: 'odin.connector-object.v1' }, payloadHash: 'f'.repeat(64) });
      const workerResult = await processConnectorInboundBatch({ now: new Date('2030-01-01T00:00:00Z'), repository, workerId: 'mysql-worker' });
      assert.equal(workerResult[0].status, 'processed');
      const [projected] = await repository.listConnectorObjects({ tenantId }); assert.equal(projected.externalId, 'issue-101'); assert.equal(projected.projectId, 'project-1');
      const runInput = {
        connectionId: connection.id,
        direction: 'inbound',
        idempotencyKey: 'sync-run-100',
        tenantId,
      };
      assert.equal((await repository.createSyncRun(runInput)).duplicate, false);
      assert.equal((await repository.createSyncRun(runInput)).duplicate, true);

      const updated = await repository.updateConnection({
        connectionId: connection.id,
        input: { expectedVersion: 1, status: 'paused' },
        tenantId,
      });
      assert.equal(updated.version, 2);
      await assert.rejects(
        repository.updateConnection({
          connectionId: connection.id,
          input: { expectedVersion: 1, status: 'active' },
          tenantId,
        }),
        (error) => error.statusCode === 409,
      );

      const policy = await repository.createProviderPolicy({
        input: {
          allowedAuthTypes: ['webhook'],
          allowedDirections: ['inbound'],
          allowedScopes: ['issues:read'],
          approvalRequired: true,
          dataClassification: 'restricted',
          enabled: true,
          maxProjects: 1,
          outboundEnabled: false,
          provider: 'github',
        },
        tenantId,
        userId: 'admin-1',
      });
      assert.equal(policy.version, 1);
      const reviewedConnection = await repository.createConnection({
        inboundSecretHash: 'f'.repeat(64),
        input: {
          authType: 'webhook',
          conflictPolicy: 'manual',
          name: 'Reviewed GitHub',
          projectIds: ['project-1'],
          provider: 'github',
          scopes: ['issues:read'],
          secretReference: 'vault://connectors/github-reviewed',
          settings: {},
          status: 'draft',
          syncDirection: 'inbound',
        },
        tenantId,
        userId: 'admin-1',
      });
      await assert.rejects(
        repository.approveConnection({
          approvedBy: 'admin-1',
          connectionId: reviewedConnection.id,
          expectedVersion: 1,
          tenantId,
        }),
        (error) => error.statusCode === 403,
      );
      const approved = await repository.approveConnection({
        approvedBy: 'admin-2',
        connectionId: reviewedConnection.id,
        expectedVersion: 1,
        tenantId,
      });
      assert.equal(approved.status, 'active');
      assert.equal(approved.approvedBy, 'admin-2');
      assert.equal(
        (
          await repository.authenticateInbound({
            connectionId: reviewedConnection.id,
            secretHash: 'f'.repeat(64),
          })
        ).id,
        reviewedConnection.id,
      );

      const erpConnection = await repository.createConnection({ inboundSecretHash: '9'.repeat(64), input: { authType: 'oauth2', conflictPolicy: 'manual', name: 'SAP Finance', projectIds: ['project-1'], provider: 'sap_s4hana', scopes: ['journal_entries'], secretReference: 'env:SAP_TOKEN', settings: { baseUrl: 'https://acme.s4hana.ondemand.com' }, status: 'active', syncDirection: 'outbound' }, tenantId, userId: 'admin-1' });
      const postingInput = { connectionId: erpConnection.id, financialEntry: { id: 'entry-1', version: 3 }, idempotencyKey: 'posting-entry-1', tenantId, userId: 'admin-1' };
      assert.equal((await repository.createErpPosting(postingInput)).duplicate, false); assert.equal((await repository.createErpPosting(postingInput)).duplicate, true);
      const claimedPostings = await repository.claimErpPostings({ now: new Date('2030-01-01T00:00:00Z'), workerId: 'erp-worker' }); assert.equal(claimedPostings.length, 1); assert.equal((await repository.claimErpPostings({ now: new Date('2030-01-01T00:00:01Z'), workerId: 'other-worker' })).length, 0);
      assert.equal(await repository.completeErpPosting({ externalId: 'SAP-100', leaseToken: claimedPostings[0].posting.leaseToken, now: new Date('2030-01-01T00:00:02Z'), postingId: claimedPostings[0].posting.id, reconciliation: { matched: true, providerStatus: 'posted' }, workerId: 'erp-worker' }), true);
      const syncConnection = await repository.createConnection({ inboundSecretHash: '8'.repeat(64), input: { authType: 'pat', conflictPolicy: 'manual', name: 'GitLab delivery', projectIds: ['project-1'], provider: 'gitlab', scopes: ['issues'], secretReference: 'env:GITLAB_TOKEN', settings: { projectId: '1' }, status: 'active', syncDirection: 'bidirectional' }, tenantId, userId: 'admin-1' });
      await repository.createSyncRun({ connectionId: syncConnection.id, direction: 'inbound', idempotencyKey: 'polled-run-1', tenantId }); const syncClaims = await repository.claimSyncRuns({ now: new Date('2030-01-01T00:00:00Z'), workerId: 'sync-worker' }); assert.equal(syncClaims.length, 1); assert.equal((await repository.claimSyncRuns({ now: new Date('2030-01-01T00:00:01Z'), workerId: 'other-worker' })).length, 0); assert.equal(await repository.completeSyncRun({ counts: { accepted: 1 }, cursorAfter: 'page-2', leaseToken: syncClaims[0].run.leaseToken, now: new Date('2030-01-01T00:00:02Z'), runId: syncClaims[0].run.id, workerId: 'sync-worker' }), true);
      await repository.enqueueProviderErasure({ connectionId: syncConnection.id, externalSubjectId: 'gitlab-user-1', subjectHash: '7'.repeat(64), tenantId }); const erasureClaims = await repository.claimProviderErasures({ now: new Date('2030-01-01T00:00:00Z'), workerId: 'erasure-worker' }); assert.equal(erasureClaims.length, 1); assert.equal(await repository.completeProviderErasure({ evidence: { providerStatus: 'accepted' }, jobId: erasureClaims[0].job.id, leaseToken: erasureClaims[0].job.leaseToken, workerId: 'erasure-worker' }), true);
      await repository.createOAuthTransaction({ input: { codeVerifier: 'v'.repeat(64), connectionId: syncConnection.id, expiresAt: '2030-01-01T00:10:00Z', redirectUri: 'https://odin.example/api/connectors/oauth/callback', stateHash: '6'.repeat(64) }, tenantId, userId: 'admin-1' }); assert.equal((await repository.consumeOAuthTransaction({ stateHash: '6'.repeat(64) })).connectionId, syncConnection.id); assert.equal(await repository.consumeOAuthTransaction({ stateHash: '6'.repeat(64) }), null); await repository.storeOAuthCredential({ connectionId: syncConnection.id, encryptedCredential: 'iv.tag.ciphertext', expiresAt: '2030-01-01T01:00:00Z', tenantId }); assert.equal((await repository.getOAuthCredential({ connectionId: syncConnection.id, tenantId })).encryptedCredential, 'iv.tag.ciphertext');

      const snapshot = await repository.listSnapshot({ tenantId });
      assert.equal(snapshot.connections.length, 4);
      assert.equal(snapshot.connections[0].inboundSecretHash, undefined);
      assert.equal(snapshot.mappings.length, 1);
      assert.equal(snapshot.conflicts[0].status, 'resolved');
      assert.equal(snapshot.events.length, 2);
      assert.ok(snapshot.events.every((item) => item.status === 'processed'));
      assert.equal(snapshot.policies.length, 1);
      assert.equal(snapshot.runs.length, 2);
      assert.equal(snapshot.runs.find((item) => item.idempotencyKey === 'polled-run-1').status, 'completed');
      assert.equal(snapshot.postings[0].status, 'reconciled');
      assert.equal(snapshot.erasures[0].status, 'completed');
    } finally {
      await pool.end();
    }
  },
);
