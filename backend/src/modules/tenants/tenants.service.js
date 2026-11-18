import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { WORKSPACE_INVITATION_TEMPLATE_ID } from '../mail/mail.templates.js';
import { ticketConfigRevision } from './ticket-config-revision.js';
import { invitationMailTarget } from './workspace-invitations.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  createDefaultAiConfig,
  normalizeAiCapabilityConfig,
} from '../../lib/ai/ai-capability-config.js';

function resolveDefaultModel(defaultModel = '') {
  const normalized = String(defaultModel ?? '').trim();
  return normalized || 'gpt-6-luna';
}

const CURATED_PLATFORM_MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.5', 'gpt-5.6-luna'];

function buildCuratedModelCatalog(defaultModel = '') {
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  return [...new Set([resolvedDefaultModel, ...CURATED_PLATFORM_MODELS])];
}

function primaryMembership(user) {
  return user?.memberships?.[0] ?? null;
}

function requireTenantId(user) {
  const membership = primaryMembership(user);
  if (!membership?.tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  return membership.tenantId;
}

function requireTenantAdmin(user) {
  const role = primaryMembership(user)?.role ?? 'user';
  if (role !== 'admin') {
    throw new HttpError(403, 'Forbidden');
  }
}

function isModelAllowed(modelId) {
  const badModels = [
    'babbage',
    'davinci',
    'dall-e',
    'moderation',
    'text-embedding',
    'tts',
    'whisper',
  ];
  const text = String(modelId ?? '').toLowerCase();
  return !badModels.some((bad) => text.includes(bad));
}

function getEmailDomain(email) {
  return String(email ?? '').trim().split('@')[1]?.toLowerCase() ?? '';
}

function logTenantOperationFailure({ error, operation, user, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      tenantId: primaryMembership(user)?.tenantId ?? null,
      userId: user?.id ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Tenant operation failed.',
  });
}

export async function getTenantSettingsForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const settings = await repository.getTenantSettings({ tenantId });

  if (!settings) {
    throw new HttpError(404, 'Tenant not found.');
  }

  return {
    ok: true,
    ...settings,
  };
}

export async function updateTenantForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);

  try {
    await repository.updateTenant({
      domains: input.domains ?? [],
      tenantId,
      tenantName: input.tenant_name,
    });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        domainCount: Array.isArray(input.domains) ? input.domains.length : 0,
        tenantName: input.tenant_name ?? null,
      },
      operation: 'tenants.updateTenant',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    message: 'Tenant updated successfully.',
  };
}

export async function updateUsersForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.updateUsers({
      tenantId,
      roleChanges: input.change_role ?? [],
      updates: input.updates ?? [],
    });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        roleChangeCount: Array.isArray(input.change_role) ? input.change_role.length : 0,
        updateCount: Array.isArray(input.updates) ? input.updates.length : 0,
      },
      operation: 'tenants.updateUsers',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

export async function listInvitesForUser(user, repository, { mailRepository } = {}) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const invites = await repository.listInvites({ tenantId });
  const deliveries = new Map();
  if (mailRepository?.listEmailsByTargetIds) {
    for (let index = 0; index < invites.length; index += 200) {
      const rows = await mailRepository.listEmailsByTargetIds({ targetIds: invites.slice(index, index + 200).map(invitationMailTarget) });
      for (const row of rows) deliveries.set(row.targetId, row.status);
    }
  }
  for (const invite of invites) invite.deliveryStatus = deliveries.get(invitationMailTarget(invite)) ?? 'not_queued';

  return {
    ok: true,
    invites,
  };
}

export async function inviteUserForUser(user, input, repository, options = {}) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    await requireInvitationMail(options.mailRepository, input.email);
    result = await repository.inviteUser({
      tenantId,
      email: input.email,
      role: input.role,
    });
    await queueWorkspaceInvitation(result.invitation, repository, options);
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        emailDomain: getEmailDomain(input.email),
        role: input.role ?? null,
      },
      operation: 'tenants.inviteUser',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    message: 'Invitation email queued.',
  };
}

function escapeInvitationText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
async function requireInvitationMail(mailRepository, email) {
  if (!mailRepository?.queueMail) throw new HttpError(503, 'Invitation email is unavailable. Please try again later.');
  if (await mailRepository.isOptedOut?.({ email })) throw new HttpError(409, 'Email delivery to this address is blocked after an opt-out or delivery failure.');
}
async function queueWorkspaceInvitation(invitation, repository, { mailRepository, frontendAppUrl }) {
  const tenant = await repository.getTenantSettings({ tenantId: invitation.tenantId });
  const base = String(frontendAppUrl || 'http://localhost:5173/app').replace(/\/$/, '');
  const rendered = await renderEmailFromTemplate({ mailRepository, templateId: WORKSPACE_INVITATION_TEMPLATE_ID, vars: {
    workspaceName: escapeInvitationText(tenant?.tenant_name || 'your workspace'),
    role: escapeInvitationText(invitation.role), email: escapeInvitationText(invitation.email),
    invitationUrl: escapeInvitationText(`${base}/invites/${invitation.inviteToken}`),
  } });
  try {
    await mailRepository.queueMail({ ...rendered, recipientEmail: invitation.email, templateId: WORKSPACE_INVITATION_TEMPLATE_ID, targetId: invitationMailTarget(invitation) });
  } catch (error) {
    throw new HttpError(503, 'The invitation was saved, but its email could not be queued. Use Resend to try again.');
  }
}
export async function resendInviteForUser(user, input, repository, options = {}) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const existing = await repository.findInviteByToken({ inviteToken: input.invite_token });
  if (!existing || existing.tenantId !== tenantId || existing.accepted) throw new HttpError(404, 'Pending invitation not found.');
  await requireInvitationMail(options.mailRepository, existing.email);
  const { invitation } = await repository.renewInvite({ tenantId, inviteToken: input.invite_token });
  await queueWorkspaceInvitation(invitation, repository, options);
  return { ok: true, message: 'Invitation email queued. The previous link is no longer valid.' };
}

export async function revokeInviteForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.revokeInvite({
      tenantId,
      inviteToken: input.invite_token,
    });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        inviteTokenProvided: Boolean(input.invite_token),
      },
      operation: 'tenants.revokeInvite',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

export async function listExistingUsersForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const users = await repository.listExistingUsers({ tenantId });

  return {
    ok: true,
    users,
  };
}

export async function removeUserFromTenantForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.removeUserFromTenant({
      tenantId,
      userId: input.userId,
    });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        targetUserId: input.userId ?? null,
      },
      operation: 'tenants.removeUserFromTenant',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

export async function listStatusDefinitionsForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const statuses = await repository.listStatusDefinitions({ tenantId });

  return {
    ok: true,
    statuses,
  };
}

export async function saveStatusDefinitionsForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.saveStatusDefinitions({
      tenantId,
      statuses: input.statuses ?? [],
    });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        statusCount: Array.isArray(input.statuses) ? input.statuses.length : 0,
      },
      operation: 'tenants.saveStatusDefinitions',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

export async function resetStatusDefinitionsForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.resetStatusDefinitions({ tenantId });
  } catch (error) {
    logTenantOperationFailure({
      error,
      operation: 'tenants.resetStatusDefinitions',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

// Ticket configuration lists (D-019). AC2.5: contributor-seat users cannot read or write them.
export async function listTicketConfigListForUser(user, kind, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);

  const entries = await repository.listTicketConfigList({ kind, tenantId });

  return {
    entries,
    kind,
    ok: true,
    revision: ticketConfigRevision(entries),
  };
}

export async function saveTicketConfigListForUser(user, kind, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.saveTicketConfigList({ entries: input.entries ?? [], expectedRevision: input.expectedRevision, kind, tenantId });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: { entryCount: Array.isArray(input.entries) ? input.entries.length : 0, kind },
      operation: 'tenants.saveTicketConfigList',
      user,
    });
    throw error;
  }

  return {
    kind,
    ok: true,
    ...result,
    revision: ticketConfigRevision(result.entries ?? []),
  };
}

export async function listTaskTypeDefinitionsForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const task_types = await repository.listTaskTypeDefinitions({ tenantId });

  return {
    ok: true,
    task_types,
  };
}

export async function saveTaskTypeDefinitionsForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.saveTaskTypeDefinitions({
      tenantId,
      taskTypes: input.task_types ?? [],
    });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        taskTypeCount: Array.isArray(input.task_types) ? input.task_types.length : 0,
      },
      operation: 'tenants.saveTaskTypeDefinitions',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

export async function resetTaskTypeDefinitionsForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.resetTaskTypeDefinitions({ tenantId });
  } catch (error) {
    logTenantOperationFailure({
      error,
      operation: 'tenants.resetTaskTypeDefinitions',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    ...result,
  };
}

function emptyOpenAiConfig(defaultModel = '') {
  return createDefaultAiConfig(resolveDefaultModel(defaultModel));
}

export async function getOpenAiConfigForUser(user, repository, { defaultModel = '' } = {}) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  const config = normalizeAiCapabilityConfig(await repository.getOpenAiConfig({
    defaults: emptyOpenAiConfig(resolvedDefaultModel),
    tenantId,
  }), { defaultModel: resolvedDefaultModel });
  const usesTenantOpenAiKey = Boolean(String(config.openai_key ?? '').trim());

  if (!Array.isArray(config.available_models) || config.available_models.length === 0) {
    config.available_models = buildCuratedModelCatalog(resolvedDefaultModel);
  }

  return {
    ok: true,
    openai_config: {
      ...config,
      default_model: resolvedDefaultModel,
      model_catalog_mode: usesTenantOpenAiKey ? 'tenant_key' : 'default_model_only',
      uses_tenant_openai_key: usesTenantOpenAiKey,
    },
  };
}

export async function fetchOpenAiModelsForUser(user, input, { defaultModel = '' } = {}) {
  requireTenantAdmin(user);
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);

  const apiKey = String(input.openai_key ?? '').trim();
  if (!apiKey) {
    throw new HttpError(400, 'OpenAI Key missing');
  }

  const response = await fetch('https://api.openai.com/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new HttpError(502, 'Unable to fetch OpenAI models.');
  }

  const json = await response.json().catch(() => null);
  const models = Array.isArray(json?.data) ? json.data : [];
  const ids = models
    .map((model) => model?.id)
    .filter(Boolean)
    .filter(isModelAllowed)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));

  return {
    ok: true,
    openai_config: {
      ...normalizeAiCapabilityConfig({
        openai_key: apiKey,
        available_models: ids,
        valid_config: true,
      }, { defaultModel: resolvedDefaultModel }),
      default_model: resolvedDefaultModel,
      model_catalog_mode: 'tenant_key',
      uses_tenant_openai_key: true,
    },
  };
}

export async function saveOpenAiConfigForUser(user, input, repository, { defaultModel = '' } = {}) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  const config = normalizeAiCapabilityConfig(input?.openai_config ?? null, { defaultModel: resolvedDefaultModel });

  if (!config) {
    throw new HttpError(400, 'No config data found');
  }

  const availableModels = Array.isArray(config.available_models) && config.available_models.length > 0
    ? config.available_models
    : buildCuratedModelCatalog(resolvedDefaultModel);
  config.available_models = [...new Set([resolvedDefaultModel, ...availableModels])];

  for (const [fn, settings] of Object.entries(config.capabilities ?? {})) {
    const model = String(settings?.model ?? '').trim();
    if (model && !config.available_models.includes(model)) {
      throw new HttpError(400, `Capability ${fn} references an invalid model: ${model}`);
    }
  }

  try {
    await repository.saveOpenAiConfig({ tenantId, config });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        availableModelCount: Array.isArray(config.available_models) ? config.available_models.length : 0,
        capabilityCount: Object.keys(config.capabilities ?? {}).length,
        validConfig: Boolean(config.valid_config),
      },
      operation: 'tenants.saveOpenAiConfig',
      user,
    });
    throw error;
  }

  return {
    ok: true,
    message: 'OpenAI config saved.',
  };
}

export async function deleteOpenAiConfigForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  let result;

  try {
    result = await repository.deleteOpenAiConfig({ tenantId });
  } catch (error) {
    logTenantOperationFailure({
      error,
      operation: 'tenants.deleteOpenAiConfig',
      user,
    });
    throw error;
  }
  return { ok: true, ...result };
}

function isoDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return '';
  }

  return date.toISOString().slice(0, 10);
}

function resolveAuditDates(input) {
  const start = String(input?.start_date ?? '').trim();
  const end = String(input?.end_date ?? '').trim();

  if (start && end) {
    return { endDate: end, startDate: start };
  }

  const now = new Date();
  const endDate = end || isoDateOnly(now);
  const startDateObj = new Date(now.valueOf());
  startDateObj.setUTCDate(startDateObj.getUTCDate() - 30);
  const startDate = start || isoDateOnly(startDateObj);

  return { endDate, startDate };
}

function buildAuditWorkbook(logs) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Audit Logs');

  sheet.columns = [
    { header: 'Date/Time', key: 'date_time', width: 26 },
    { header: 'User', key: 'user_full_name', width: 22 },
    { header: 'Project', key: 'project_name', width: 22 },
    { header: 'Action', key: 'action', width: 24 },
    { header: 'Result', key: 'result', width: 16 },
    { header: 'Detail', key: 'detail', width: 40 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const log of logs) {
    sheet.addRow({
      action: log.action ?? '',
      date_time: log.date_time ?? '',
      detail: log.detail ?? '',
      project_name: log.project_name ?? '',
      result: log.result ?? '',
      user_full_name: log.user_full_name ?? '',
    });
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, logs.length + 1), column: sheet.columns.length },
  };

  return workbook;
}

export async function getAuditLogsForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);
  const outputType = String(input?.output_type ?? 'json').toLowerCase() === 'xlsx' ? 'xlsx' : 'json';
  const searchText = String(input?.search_text ?? '').trim();
  const { startDate, endDate } = resolveAuditDates(input);

  const logs = await repository.listAuditLogs({
    applySearch: outputType === 'xlsx',
    endDate,
    searchText,
    startDate,
    tenantId,
  });

  if (outputType === 'xlsx') {
    const workbook = buildAuditWorkbook(logs);
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `TenantAuditLog_${startDate}_${endDate}.xlsx`;

    return {
      filename,
      ok: true,
      xlsxBase64: Buffer.from(buffer).toString('base64'),
    };
  }

  return {
    logs,
    ok: true,
  };
}

export async function backupTenantForUser(user, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);

  if (!repository.exportTenantBackupData) {
    throw new HttpError(400, 'Tenant backup requires a database.');
  }

  let backupData;

  try {
    backupData = await repository.exportTenantBackupData({ tenantId });
  } catch (error) {
    logTenantOperationFailure({
      error,
      operation: 'tenants.backupTenant',
      user,
    });
    throw error;
  }

  if (!backupData) {
    throw new HttpError(404, 'Tenant not found.');
  }

  const json = JSON.stringify(backupData, null, 2);
  const zip = new JSZip();
  zip.file('backup.json', json);

  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const safeTenantName = String(backupData.tenant?.name ?? 'tenant')
    .replace(/[^A-Za-z0-9_\\-]/g, '_')
    .slice(0, 80);
  const filename = `${safeTenantName}.backup.${isoDateOnly(new Date())}.odin`;

  return {
    base64Odin: Buffer.from(bytes).toString('base64'),
    filename,
    ok: true,
  };
}

export async function restoreTenantForUser(user, input, repository) {
  requireTenantAdmin(user);
  const tenantId = requireTenantId(user);

  if (!repository.restoreTenantFromBackupData) {
    throw new HttpError(400, 'Tenant restore requires a database.');
  }

  const base64 = String(input?.base64Odin ?? '').trim();
  if (!base64) {
    throw new HttpError(400, 'base64Odin is required');
  }

  let backupData = null;

  try {
    const bytes = Buffer.from(base64, 'base64');
    const zip = await JSZip.loadAsync(bytes);
    const jsonFile = zip.file('backup.json');
    if (!jsonFile) {
      throw new Error('backup.json missing from archive');
    }
    const json = await jsonFile.async('string');
    backupData = JSON.parse(json);
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('tenants.restoreFromBackup', {
        archiveLength: base64.length,
        tenantId,
        userId: user?.id ?? null,
      }),
      error,
      level: 'warn',
      message: 'Tenant backup restore payload could not be parsed.',
    });
    throw new HttpError(400, error?.message ?? 'Invalid backup archive.');
  }

  try {
    await repository.restoreTenantFromBackupData({ tenantId, backupData });
  } catch (error) {
    logTenantOperationFailure({
      error,
      extra: {
        archiveLength: base64.length,
      },
      operation: 'tenants.restoreFromBackup',
      user,
    });
    throw error;
  }

  return {
    message: 'Tenant restored.',
    ok: true,
  };
}
