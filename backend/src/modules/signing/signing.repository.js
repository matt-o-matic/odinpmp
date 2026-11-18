import { randomUUID } from 'node:crypto';

import { appendMysqlProjectChanges } from '../changes/project-change-log.js';

// Storage for signature requests (docs/document-signing/plan.md): the request with its frozen
// package, the document versions it pins, its signers, their sealed signatures, and its audit
// trail. Migration 0094 (signing-schema.js) creates the tables.
//
// Every change to a request goes through withRequest: the request is locked (a row lock in
// MySQL, a queue per request in memory), its current state is read, and the caller's function
// returns the changes to make, which are applied in the same transaction. The service holds the
// rules; the repository only reads, locks and writes.

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const iso = (value) => (value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const asDate = (value) => (value == null ? null : new Date(value));

const REQUEST_FIELDS = {
  createdAt: 'created_at', createdBy: 'created_by', endReason: 'end_reason', endedAt: 'ended_at', endedBy: 'ended_by', id: 'id', kind: 'kind',
  manifestHash: 'manifest_hash', manifestJson: 'manifest_json', message: 'message', packageHash: 'package_hash', packageJson: 'package_json',
  projectId: 'project_id', seal: 'seal', sealKeyId: 'seal_key_id', statement: 'statement', status: 'status', subjectId: 'subject_id',
  subjectType: 'subject_type', tenantId: 'tenant_id', title: 'title', updatedAt: 'updated_at',
};
const DOCUMENT_FIELDS = {
  contentType: 'content_type', fileId: 'file_id', fileName: 'file_name', fileSize: 'file_size', id: 'id', position: 'position',
  projectId: 'project_id', requestId: 'request_id', sha256: 'sha256', storageKey: 'storage_key', tenantId: 'tenant_id', version: 'version_number',
};
const SIGNER_FIELDS = {
  codeAttempts: 'code_attempts', codeHash: 'code_hash', codeSentAt: 'code_sent_at', declineReason: 'decline_reason', declinedAt: 'declined_at',
  email: 'assigned_email', id: 'id', mailReason: 'mail_reason', mailStatus: 'mail_status', name: 'assigned_name', position: 'position',
  projectId: 'project_id', remindedAt: 'reminded_at', removalReason: 'removal_reason', removedAt: 'removed_at', removedBy: 'removed_by',
  requestId: 'request_id', signedAt: 'signed_at', signedName: 'signed_name', signedOrganization: 'signed_organization', signedTitle: 'signed_title',
  stakeholderId: 'stakeholder_id', status: 'status', tenantId: 'tenant_id',
};
const SIGNATURE_FIELDS = {
  evidenceHash: 'evidence_hash', evidenceJson: 'evidence_json', id: 'id', projectId: 'project_id', requestId: 'request_id', seal: 'seal',
  sealKeyId: 'seal_key_id', signedAt: 'signed_at', signerId: 'signer_id', tenantId: 'tenant_id',
};
const EVENT_FIELDS = {
  action: 'action', actor: 'actor', createdAt: 'created_at', detail: 'detail_json', id: 'id', projectId: 'project_id', requestId: 'request_id',
  signerId: 'signer_id', tenantId: 'tenant_id',
};
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'endedAt', 'codeSentAt', 'signedAt', 'declinedAt', 'removedAt', 'remindedAt']);
const NUMBER_FIELDS = new Set(['position', 'version', 'fileSize', 'codeAttempts']);

function fromRow(row, fields) {
  const record = {};
  for (const [key, column] of Object.entries(fields)) {
    let value = row[column];
    if (DATE_FIELDS.has(key)) value = iso(value);
    else if (NUMBER_FIELDS.has(key)) value = value == null ? null : Number(value);
    else if (key === 'detail') value = value == null ? null : typeof value === 'string' ? JSON.parse(value) : value;
    else if (value === undefined) value = null;
    record[key] = value;
  }
  return record;
}

function toColumns(record, fields) {
  const columns = [];
  const values = [];
  for (const [key, value] of Object.entries(record)) {
    const column = fields[key];
    if (!column) throw new Error(`Unknown signing field ${key}.`);
    columns.push(column);
    if (DATE_FIELDS.has(key)) values.push(asDate(value));
    else if (key === 'detail') values.push(value == null ? null : JSON.stringify(value));
    else values.push(value ?? null);
  }
  return { columns, values };
}

/** A request as read: the request, its documents and signers in order, its signatures and events. */
function assemble({ documents, events, request, signatures, signers }) {
  return {
    documents: [...documents].sort((left, right) => left.position - right.position),
    events: [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    request,
    signatures,
    signers: [...signers].sort((left, right) => left.position - right.position),
  };
}

export function createInMemorySigningRepository({ requirementsRepository = null } = {}) {
  const state = { documents: [], events: [], requests: [], signatures: [], signers: [] };
  const queues = new Map();

  function read(requestId) {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) return null;
    return clone(assemble({
      documents: state.documents.filter((item) => item.requestId === requestId),
      events: state.events.filter((item) => item.requestId === requestId),
      request,
      signatures: state.signatures.filter((item) => item.requestId === requestId),
      signers: state.signers.filter((item) => item.requestId === requestId),
    }));
  }

  function apply(current, changes = {}) {
    const { request, signers = [], signature = null, events = [] } = changes;
    if (request) Object.assign(state.requests.find((item) => item.id === current.request.id), clone(request));
    for (const { id, ...fields } of signers) Object.assign(state.signers.find((item) => item.id === id), clone(fields));
    if (signature) state.signatures.push(clone({ id: randomUUID(), ...signature }));
    for (const event of events) state.events.push(clone({ id: randomUUID(), detail: null, signerId: null, ...event }));
  }

  // Signer involvement for the stakeholder's portal link (computeLinkStatus).
  async function involvement({ projectId, stakeholderId, tenantId }) {
    return state.signers
      .filter((signer) => signer.tenantId === tenantId && signer.projectId === projectId && signer.stakeholderId === stakeholderId)
      .map((signer) => {
        const request = state.requests.find((item) => item.id === signer.requestId);
        const open = signer.status === 'pending' && request?.status === 'pending';
        return { endedAt: open ? null : signer.signedAt ?? signer.declinedAt ?? signer.removedAt ?? request?.endedAt ?? request?.updatedAt ?? null, requestId: signer.requestId };
      });
  }
  requirementsRepository?.setSigningInvolvementSource?.(involvement);

  return {
    state,
    async createRequest({ documents, events = [], request, signers }) {
      state.requests.push(clone(request));
      for (const document of documents) state.documents.push(clone(document));
      for (const signer of signers) state.signers.push(clone(signer));
      for (const event of events) state.events.push(clone({ id: randomUUID(), detail: null, signerId: null, ...event }));
      return read(request.id);
    },
    async getRequest({ projectId, requestId, tenantId }) {
      const found = state.requests.find((item) => item.id === requestId && item.projectId === projectId && item.tenantId === tenantId);
      return found ? read(found.id) : null;
    },
    async listRequests({ fileId = null, projectId, status = null, tenantId }) {
      const withFile = fileId ? new Set(state.documents.filter((item) => item.fileId === fileId).map((item) => item.requestId)) : null;
      return state.requests
        .filter((item) => item.projectId === projectId && item.tenantId === tenantId && (!status || item.status === status) && (!withFile || withFile.has(item.id) || (item.subjectType === 'file' && item.subjectId === fileId)))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((item) => read(item.id));
    },
    /** File ids in a pending or completed request: they cannot be deleted or made internal. */
    async listProtectedFileIds({ fileIds, tenantId }) {
      const wanted = new Set(fileIds);
      const live = new Set(state.requests.filter((item) => item.tenantId === tenantId && (item.status === 'pending' || item.status === 'completed')).map((item) => item.id));
      return [...new Set(state.documents.filter((item) => wanted.has(item.fileId) && live.has(item.requestId)).map((item) => item.fileId))];
    },
    // The versions of a file, and the storage objects, that pending or completed requests froze.
    async listFileVersionPins({ fileId, tenantId }) {
      const live = new Set(state.requests.filter((item) => item.tenantId === tenantId && (item.status === 'pending' || item.status === 'completed')).map((item) => item.id));
      return state.documents.filter((item) => item.fileId === fileId && live.has(item.requestId)).map((item) => ({ storageKey: item.storageKey, version: item.version }));
    },
    async isStorageKeyPinned({ storageKey, tenantId }) {
      const live = new Set(state.requests.filter((item) => item.tenantId === tenantId && (item.status === 'pending' || item.status === 'completed')).map((item) => item.id));
      return state.documents.some((item) => item.storageKey === storageKey && live.has(item.requestId));
    },
    async withRequest({ projectId, requestId, tenantId }, change) {
      const previous = queues.get(requestId) ?? Promise.resolve();
      let release;
      const turn = new Promise((resolve) => { release = resolve; });
      const chained = previous.then(() => turn);
      queues.set(requestId, chained);
      await previous;
      try {
        const found = state.requests.find((item) => item.id === requestId && item.projectId === projectId && item.tenantId === tenantId);
        if (!found) return { current: null, result: await change(null) };
        const current = read(requestId);
        const outcome = await change(current);
        if (outcome?.changes) apply(current, outcome.changes);
        return { current: read(requestId), result: outcome?.result };
      } finally {
        release();
        if (queues.get(requestId) === chained) queues.delete(requestId);
      }
    },
  };
}

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function createMysqlSigningRepository({ pool, appendProjectChanges = appendMysqlProjectChanges }) {
  async function readRequest(executor, requestId, { lock = false } = {}) {
    const [requests] = await executor.execute(`SELECT * FROM signing_requests WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [requestId]);
    if (!requests[0]) return null;
    const [documents] = await executor.execute('SELECT * FROM signing_request_documents WHERE request_id = ?', [requestId]);
    const [signers] = await executor.execute(`SELECT * FROM signing_signers WHERE request_id = ?${lock ? ' FOR UPDATE' : ''}`, [requestId]);
    const [signatures] = await executor.execute('SELECT * FROM signing_signatures WHERE request_id = ?', [requestId]);
    const [events] = await executor.execute('SELECT * FROM signing_events WHERE request_id = ?', [requestId]);
    return assemble({
      documents: documents.map((row) => fromRow(row, DOCUMENT_FIELDS)),
      events: events.map((row) => fromRow(row, EVENT_FIELDS)),
      request: fromRow(requests[0], REQUEST_FIELDS),
      signatures: signatures.map((row) => fromRow(row, SIGNATURE_FIELDS)),
      signers: signers.map((row) => fromRow(row, SIGNER_FIELDS)),
    });
  }

  async function insert(executor, table, fields, record) {
    const { columns, values } = toColumns(record, fields);
    await executor.execute(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
  }

  async function update(executor, table, fields, id, record) {
    const { columns, values } = toColumns(record, fields);
    if (!columns.length) return;
    await executor.execute(`UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
  }

  async function writeEvents(executor, events) {
    for (const event of events) await insert(executor, 'signing_events', EVENT_FIELDS, { id: randomUUID(), detail: null, signerId: null, ...event });
  }

  return {
    async createRequest({ changes = [], documents, events = [], request, signers }) {
      return withTransaction(pool, async (connection) => {
        await insert(connection, 'signing_requests', REQUEST_FIELDS, request);
        for (const document of documents) await insert(connection, 'signing_request_documents', DOCUMENT_FIELDS, document);
        for (const signer of signers) await insert(connection, 'signing_signers', SIGNER_FIELDS, signer);
        await writeEvents(connection, events);
        if (appendProjectChanges && changes.length) await appendProjectChanges(connection, changes);
        return readRequest(connection, request.id);
      });
    },
    async getRequest({ projectId, requestId, tenantId }) {
      const found = await readRequest(pool, requestId);
      return found && found.request.projectId === projectId && found.request.tenantId === tenantId ? found : null;
    },
    async listRequests({ fileId = null, projectId, status = null, tenantId }) {
      const filters = ['r.tenant_id = ?', 'r.project_id = ?'];
      const values = [tenantId, projectId];
      if (status) {
        filters.push('r.status = ?');
        values.push(status);
      }
      if (fileId) {
        filters.push("(EXISTS (SELECT 1 FROM signing_request_documents d WHERE d.request_id = r.id AND d.file_id = ?) OR (r.subject_type = 'file' AND r.subject_id = ?))");
        values.push(fileId, fileId);
      }
      const [rows] = await pool.execute(`SELECT r.id FROM signing_requests r WHERE ${filters.join(' AND ')} ORDER BY r.created_at DESC LIMIT 500`, values);
      const found = [];
      for (const row of rows) found.push(await readRequest(pool, row.id));
      return found.filter(Boolean);
    },
    // The versions of a file, and the storage objects, that pending or completed requests froze.
    async listFileVersionPins({ fileId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT d.version_number AS version, d.storage_key AS storageKey FROM signing_request_documents d JOIN signing_requests r ON r.id = d.request_id
         WHERE d.tenant_id = ? AND d.file_id = ? AND r.status IN ('pending', 'completed')`,
        [tenantId, fileId],
      );
      return rows.map((row) => ({ storageKey: row.storageKey, version: Number(row.version) }));
    },
    async isStorageKeyPinned({ storageKey, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT 1 FROM signing_request_documents d JOIN signing_requests r ON r.id = d.request_id
         WHERE d.tenant_id = ? AND d.storage_key = ? AND r.status IN ('pending', 'completed') LIMIT 1`,
        [tenantId, storageKey],
      );
      return rows.length > 0;
    },
    async listProtectedFileIds({ fileIds, tenantId }) {
      const ids = [...new Set(fileIds)].filter(Boolean);
      if (!ids.length) return [];
      const [rows] = await pool.execute(
        `SELECT DISTINCT d.file_id AS fileId FROM signing_request_documents d JOIN signing_requests r ON r.id = d.request_id
         WHERE d.tenant_id = ? AND d.file_id IN (${ids.map(() => '?').join(', ')}) AND r.status IN ('pending', 'completed')`,
        [tenantId, ...ids],
      );
      return rows.map((row) => row.fileId);
    },
    async withRequest({ projectId, requestId, tenantId }, change) {
      return withTransaction(pool, async (connection) => {
        const found = await readRequest(connection, requestId, { lock: true });
        const current = found && found.request.projectId === projectId && found.request.tenantId === tenantId ? found : null;
        const outcome = await change(current);
        if (!current || !outcome?.changes) return { current, result: outcome?.result };
        const { events = [], projectChanges = [], request, signature = null, signers = [] } = outcome.changes;
        if (request) await update(connection, 'signing_requests', REQUEST_FIELDS, requestId, request);
        for (const { id, ...fields } of signers) await update(connection, 'signing_signers', SIGNER_FIELDS, id, fields);
        if (signature) await insert(connection, 'signing_signatures', SIGNATURE_FIELDS, { id: randomUUID(), ...signature });
        await writeEvents(connection, events);
        if (appendProjectChanges && projectChanges.length) await appendProjectChanges(connection, projectChanges);
        return { current: await readRequest(connection, requestId), result: outcome.result };
      });
    },
  };
}
