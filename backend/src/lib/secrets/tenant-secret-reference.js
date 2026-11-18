import { HttpError } from '../errors/http-error.js';

// A workspace admin points SSO or a connector at a secret by reference: env:NAME, an
// environment variable the operator sets on the server. A workspace may name only
// variables under its own prefix, ODIN_TENANT_<tenant id without dashes>_. Without the
// prefix, a workspace admin could make Odin send JWT_SECRET, DATABASE_URL or another
// workspace's secret to an identity provider or API host that the admin controls.

const REFERENCE = /^env:([A-Z][A-Z0-9_]{2,127})$/;

export function tenantSecretPrefix(tenantId) {
  const key = String(tenantId ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key) throw new HttpError(503, 'A secret reference needs a workspace.');
  return `ODIN_TENANT_${key}_`;
}

function scopedName(reference, tenantId) {
  const prefix = tenantSecretPrefix(tenantId);
  const name = String(reference ?? '').trim().match(REFERENCE)?.[1];
  return name && name.startsWith(prefix) && name.length > prefix.length ? name : null;
}

function hasReference(reference) {
  return String(reference ?? '').trim() !== '';
}

/** Rejects a reference a workspace may not use. An empty reference is allowed. */
export function assertTenantSecretReference(reference, { field = 'Secret reference', tenantId }) {
  if (hasReference(reference) && !scopedName(reference, tenantId)) {
    throw new HttpError(400, `${field} must be env:${tenantSecretPrefix(tenantId)}<NAME>, an environment variable set on the server for this workspace.`);
  }
}

/** The secret a workspace's reference names, or '' when the reference is empty or the variable is unset. */
export function resolveTenantSecretReference(reference, { env = process.env, tenantId }) {
  if (!hasReference(reference)) return '';
  const name = scopedName(reference, tenantId);
  if (!name) throw new HttpError(503, `Secret reference must be env:${tenantSecretPrefix(tenantId)}<NAME>.`);
  return env[name] ?? '';
}
