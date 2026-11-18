// 0099_billing on MySQL: the schema (and over a time entry made before it), the billing repository
// and its transactions, and the claimed-entry lock in the finance repository.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { bootstrapMysqlSchema } from '../src/jobs/bootstrap-schema.lib.js';
import { ensureMysqlBillingSchema } from '../src/modules/billing/billing-schema.js';
import { createMysqlBillingRepository } from '../src/modules/billing/billing.repository.js';
import { getBillableTimeForApplication } from '../src/modules/billing/billing.service.js';
import { listMysqlProjectChanges } from '../src/modules/changes/project-change-log.js';
import { projectItemCreateSchema } from '../src/modules/projects/projects.schema.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlResourceFinanceRepository } from '../src/modules/resource-finance/resource-finance.repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

async function withDatabase(suffix, run) {
  const parsed = new URL(databaseUrl);
  const database = `${decodeURIComponent(parsed.pathname.slice(1)).slice(0, 38)}_${suffix}_${process.pid}`;
  const connectionOptions = { host: parsed.hostname, password: decodeURIComponent(parsed.password), port: Number(parsed.port || 3306), user: decodeURIComponent(parsed.username) };
  const admin = await mysql.createConnection(connectionOptions);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.pathname = `/${database}`;
  const pool = mysql.createPool(isolatedUrl.toString());
  try {
    const importer = await mysql.createConnection({ ...connectionOptions, database, multipleStatements: true });
    try { await importer.query(await readFile(new URL('../db/base-schema.sql', import.meta.url), 'utf8')); }
    finally { await importer.end(); }
    await bootstrapMysqlSchema({ executor: pool });
    await run({ pool });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end();
  }
}

const invoiced = (error) => error?.statusCode === 409 && error.details?.code === 'time_entry_invoiced';

test('MySQL billing: the 0099 schema, links, invoices, all-or-nothing claims, void release, story milestones and the claimed-entry lock', { skip: !databaseUrl, timeout: 560_000 }, async (t) => {
  await withDatabase('billing', async ({ pool }) => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await pool.execute('INSERT INTO tenants (id, name) VALUES (?, ?)', [tenantId, 'Billing Tenant']);
    await pool.execute('INSERT INTO users (id, name, email) VALUES (?, ?, ?)', [userId, 'Pat Manager', `pat-${userId}@example.com`]);
    await pool.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), userId, tenantId, 'admin']);
    const user = { email: 'pat@example.com', id: userId, memberships: [{ role: 'admin', tenantId }], name: 'Pat Manager' };
    const projects = createMysqlProjectsRepository({ fileStorage: { async delete() {}, async read() { return { bytes: Buffer.alloc(0), size: 0 }; }, async write() {} }, pool });
    const finance = createMysqlResourceFinanceRepository({ pool });
    const billing = createMysqlBillingRepository({ pool });
    const project = await projects.createProject({ input: { description: '', endDate: null, name: 'Initech delivery', startDate: null, status: 'In Progress' }, tenantId, user });
    const projectId = project.id;
    const add = async (itemType, name, parentId = null) => {
      await projects.createProjectItem({ input: projectItemCreateSchema.parse({ item: { name }, itemType, parentId }), projectId, tenantId, user });
      const detail = await projects.getProjectDetail({ projectId, tenantId });
      const all = (detail.epics ?? []).flatMap((epic) => [epic, ...(epic.stories ?? []).flatMap((story) => [story, ...(story.tasks ?? [])])]);
      return all.find((item) => item.name === name).id;
    };
    const epicA = await add('epic', 'Discovery');
    const epicB = await add('epic', 'Build');
    const storyA = await add('story', 'Discovery workshop', epicA);
    const taskA = await add('task', 'Prep deck', storyA);
    const storyB = await add('story', 'Data model', epicB);
    const resource = await finance.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', name: 'Carol Member', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId });
    const entry = (overrides = {}) => finance.createTimeEntry({ input: { billable: true, hours: 2, note: 'Logged', periodId: null, projectId, resourceId: resource.id, status: 'approved', workDate: '2026-11-03', workItemId: null, ...overrides }, tenantId });
    const change = (action) => () => [{ action, actorId: 'oauth-application:app-1', detail: { kind: 'test' }, entityId: `billing:${action}`, entityType: 'billing', itemId: null, projectId, tenantId, via: 'api:invoice-gen' }];

    await t.test('0099 adds the tables, the claim columns and their index, and keeps a time entry made before it', async () => {
      const [tables] = await pool.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('project_billing_links', 'project_external_invoices', 'time_entry_invoice_claims', 'story_billing_milestones') ORDER BY TABLE_NAME");
      assert.deepEqual(tables.map((row) => row.name), ['project_billing_links', 'project_external_invoices', 'story_billing_milestones', 'time_entry_invoice_claims']);
      const [index] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_time_entries' AND INDEX_NAME = 'idx_time_project_claim'");
      assert.equal(index[0].cols, 'tenant_id,project_id,invoice_claim_id');
      const [unique] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'time_entry_invoice_claims' AND INDEX_NAME = 'uq_invoice_claims_active'");
      assert.equal(unique[0].cols, 'tenant_id,provider,external_invoice_id,active_marker');
      const [storyKey] = await pool.execute("SELECT GROUP_CONCAT(COLUMN_NAME) AS cols FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story_billing_milestones' AND CONSTRAINT_NAME = 'PRIMARY'");
      assert.equal(storyKey[0].cols, 'story_id', 'a story holds one milestone');

      // As on a database that had time entries before 0099: take its columns off, add a row, run it again.
      await pool.execute('ALTER TABLE project_time_entries DROP INDEX idx_time_project_claim, DROP COLUMN invoice_claim_id, DROP COLUMN invoice_claimed_at');
      const [result] = await pool.execute("INSERT INTO project_time_entries (id, tenant_id, project_id, resource_id, period_id, work_item_id, work_date, hours, billable, status, note, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, '2026-10-01', 1.25, 1, 'approved', 'before 0099', 1, NOW(3), NOW(3))", [randomUUID(), tenantId, projectId, resource.id]);
      assert.equal(result.affectedRows, 1);
      await ensureMysqlBillingSchema(pool);
      await ensureMysqlBillingSchema(pool);
      const [rows] = await pool.execute("SELECT invoice_claim_id, invoice_claimed_at, hours FROM project_time_entries WHERE note = 'before 0099'");
      assert.deepEqual(rows.map((row) => [row.invoice_claim_id, row.invoice_claimed_at, Number(row.hours)]), [[null, null, 1.25]]);
      await pool.execute("DELETE FROM project_time_entries WHERE note = 'before 0099'");
    });

    await t.test('links: upsert, an older send is ignored, delete', async () => {
      const body = { agreement: { id: 41, milestones: [{ hours: 40, id: 101, name: 'Discovery', shortLabel: 'Disc' }, { hours: 80, id: 102, name: 'Build', shortLabel: 'Build' }], status: 'executed', title: 'Phase 2', url: 'https://invoices.example/agreements/41' }, customer: { id: 12, name: 'Initech' }, lineOfBusiness: { id: 3, name: '' }, sourceUpdatedAt: '2026-11-02T15:00:01.000Z' };
      const saved = await billing.putLink({ changeEntries: change('link'), link: body, projectId, tenantId });
      assert.equal(saved.created, true);
      assert.deepEqual(saved.link.customer, { id: 12, name: 'Initech' });
      assert.equal(saved.link.sourceUpdatedAt, '2026-11-02T15:00:01.000Z');
      assert.deepEqual(saved.link.agreement.milestones.map((milestone) => milestone.id), [101, 102]);
      const older = await billing.putLink({ link: { ...body, agreement: null, sourceUpdatedAt: '2026-11-01T00:00:00.000Z' }, projectId, tenantId });
      assert.equal(older.ignored, true);
      assert.equal((await billing.getLink({ projectId, tenantId })).agreement.id, 41);
      assert.equal(await billing.deleteLink({ projectId, tenantId }), true);
      assert.equal(await billing.deleteLink({ projectId, tenantId }), false);
      await billing.putLink({ link: body, projectId, tenantId });
    });

    await t.test('claims are all or nothing; the holder is named; claimed entries are locked; void releases them', async () => {
      const one = await entry({ hours: 2.5, workItemId: taskA });
      const two = await entry({ hours: 3, workItemId: storyB });
      const submitted = await entry({ status: 'submitted' });
      await billing.putInvoice({ externalId: '75', projectId, summary: { currency: 'USD', dueDate: null, hours: 2.5, issueDate: '2026-11-30', number: 'NESLLC-75', overdue: false, paidDate: null, sourceUpdatedAt: '2026-11-30T00:00:00Z', status: 'draft', submittedDate: null, totalCents: 37500, url: 'https://invoices.example/invoices/75' }, tenantId });
      const first = await billing.claimEntries({ add: [one.id], changeEntries: change('claim'), externalInvoiceId: '75', idempotencyKey: 'invoice-75-claim-1', projectId, remove: [], tenantId });
      assert.deepEqual(first, { added: [one.id], entryIds: [one.id], externalInvoiceId: '75', hours: 2.5, removed: [] });

      const blocked = await billing.claimEntries({ add: [two.id, one.id, submitted.id], externalInvoiceId: '77', projectId, remove: [], tenantId });
      assert.deepEqual(blocked.conflicts, [
        { entryId: one.id, externalInvoiceId: '75', invoiceNumber: 'NESLLC-75', reason: 'claimed' },
        { entryId: submitted.id, externalInvoiceId: null, invoiceNumber: null, reason: 'not_approved' },
      ]);
      const [unclaimed] = await pool.execute('SELECT invoice_claim_id FROM project_time_entries WHERE id = ?', [two.id]);
      assert.equal(unclaimed[0].invoice_claim_id, null, 'nothing claimed');

      // Two claims for the same entry at once: one wins, the other names it.
      const [left, right] = await Promise.all([
        billing.claimEntries({ add: [two.id], externalInvoiceId: '80', projectId, remove: [], tenantId }),
        billing.claimEntries({ add: [two.id], externalInvoiceId: '81', projectId, remove: [], tenantId }),
      ]);
      assert.equal([left, right].filter((result) => result.conflicts).length, 1);
      assert.equal([left, right].filter((result) => result.entryIds?.includes(two.id)).length, 1);
      const holder = left.conflicts ? '81' : '80';
      assert.equal(await billing.releaseClaims({ externalInvoiceId: holder, projectId, tenantId }), 1);
      assert.equal(await billing.releaseClaims({ externalInvoiceId: holder, projectId, tenantId }), 0);

      // The finance repository refuses edits and deletes of the claimed entry, and shows its invoice.
      const claimed = (await finance.listSnapshot({ tenantId })).timeEntries.find((row) => row.id === one.id);
      assert.deepEqual(claimed.invoice, { externalInvoiceId: '75', number: 'NESLLC-75', status: 'draft', url: 'https://invoices.example/invoices/75' });
      await assert.rejects(finance.updateTimeEntry({ input: { expectedVersion: claimed.version, hours: 5 }, tenantId, timeEntryId: one.id }), invoiced);
      await assert.rejects(finance.updateTimeEntry({ input: { expectedVersion: claimed.version, status: 'rejected' }, tenantId, timeEntryId: one.id }), invoiced);
      await assert.rejects(finance.deleteTimeEntry({ expectedVersion: claimed.version, tenantId, timeEntryId: one.id }), invoiced);
      await assert.rejects(finance.deleteTimeEntry({ expectedVersion: claimed.version, ownSubmitted: { resourceId: resource.id }, tenantId, timeEntryId: one.id }), invoiced);
      const merged = await finance.updateTimeEntry({ input: { expectedVersion: claimed.version, resourceId: resource.id }, resourceMerge: true, tenantId, timeEntryId: one.id });
      assert.equal(merged.invoiceClaimId !== null, true, 'a profile merge moves it and keeps the claim');

      const listed = await billing.listProjectTimeEntries({ projectId, tenantId });
      assert.deepEqual(listed.find((row) => row.id === one.id).claim.invoiceNumber, 'NESLLC-75');
      assert.equal(listed.find((row) => row.id === one.id).resourceName, 'Carol Member');
      assert.equal(listed.find((row) => row.id === one.id).workDate, '2026-11-03');

      // An older summary is ignored; void releases in the same transaction.
      const older = await billing.putInvoice({ externalId: '75', projectId, summary: { number: 'OLD', sourceUpdatedAt: '2026-11-29T00:00:00Z', status: 'paid' }, tenantId });
      assert.equal(older.ignored, true);
      assert.equal(older.invoice.number, 'NESLLC-75');
      const voided = await billing.putInvoice({ changeEntries: change('void'), externalId: '75', projectId, summary: { currency: 'USD', number: 'NESLLC-75', sourceUpdatedAt: '2026-12-01T00:00:00Z', status: 'void' }, tenantId });
      assert.equal(voided.released, 1);
      const released = (await finance.listSnapshot({ tenantId })).timeEntries.find((row) => row.id === one.id);
      assert.equal(released.invoiceClaimId, null);
      const edited = await finance.updateTimeEntry({ input: { expectedVersion: released.version, hours: 2.75 }, tenantId, timeEntryId: one.id });
      assert.equal(edited.hours, 2.75);
      const [invoices] = await pool.execute('SELECT status, issue_date FROM project_external_invoices WHERE external_id = ?', ['75']);
      assert.equal(invoices[0].status, 'void');

      assert.deepEqual(await billing.deleteInvoice({ externalId: '75', projectId, tenantId }), { deleted: true, released: 0 });
      assert.deepEqual(await billing.deleteInvoice({ externalId: '75', projectId, tenantId }), { deleted: false, released: 0 });
      assert.ok(await billing.lastHeardAt({ projectId, tenantId }));
    });

    await t.test('story milestones: set, move, clear; billable time resolves a task to its story across epics', async () => {
      const set = await billing.setStoryMilestones({ assignments: [{ milestoneId: 101, storyId: storyA }, { milestoneId: 101, storyId: storyB }], changeEntries: change('milestones'), projectId, tenantId, userId });
      assert.equal(set.changed.length, 2);
      const moved = await billing.setStoryMilestones({ assignments: [{ milestoneId: 102, storyId: storyB }, { milestoneId: 101, storyId: storyA }], projectId, tenantId, userId });
      assert.deepEqual(moved.changed, [{ from: 101, storyId: storyB, to: 102 }]);
      const time = await getBillableTimeForApplication({ billingRepository: billing, input: { from: '2026-11-01', to: '2026-11-30' }, projectId, projectRepository: projects, tenantId });
      const byItem = new Map(time.data.entries.map((row) => [row.workItem?.id ?? null, row]));
      assert.deepEqual([byItem.get(taskA).story.id, byItem.get(taskA).milestoneId], [storyA, 101]);
      assert.equal(byItem.get(storyB).milestoneId, 102);
      assert.equal(time.data.lines[0].milestoneId, 101);
      await billing.setStoryMilestones({ assignments: [{ milestoneId: null, storyId: storyB }], projectId, tenantId, userId });
      assert.deepEqual((await billing.listStoryMilestones({ projectId, tenantId })).map((row) => [row.storyId, row.milestoneId]), [[storyA, 101]]);
    });

    await t.test('billing writes add change log rows in their transaction', async () => {
      const log = await listMysqlProjectChanges(pool, { afterSeq: 0, projectId, settleMs: 0, tenantId });
      const billingRows = log.entries.filter((row) => row.entityType === 'billing');
      assert.deepEqual([...new Set(billingRows.map((row) => row.action))].sort(), ['claim', 'link', 'milestones', 'void']);
      assert.ok(billingRows.every((row) => row.via === 'api:invoice-gen'));
    });
  });
});
