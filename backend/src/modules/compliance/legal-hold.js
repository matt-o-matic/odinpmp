import { HttpError } from '../../lib/errors/http-error.js';

export async function assertRecordsNotHeld({ repository, resources, tenantId }) {
  if (!repository?.getPolicy || !repository?.getActiveLegalHold) return;

  const policy = await repository.getPolicy({ tenantId });
  if (policy.legalHold) {
    throw new HttpError(423, 'Tenant legal hold blocks destructive changes.', {
      details: { code: 'tenant_legal_hold_active' },
    });
  }

  for (const resource of resources) {
    const hold = await repository.getActiveLegalHold({
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      tenantId,
    });
    if (hold) {
      throw new HttpError(423, 'A record-scoped legal hold blocks this change.', {
        details: {
          code: 'record_legal_hold_active',
          holdId: hold.id,
          resourceId: resource.resourceId,
          resourceType: resource.resourceType,
        },
      });
    }
  }
}
