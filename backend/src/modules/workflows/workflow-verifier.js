function flatten(project) {
  const records = [{ item: project, itemId: project.id, itemType: 'project' }];
  for (const epic of project.epics ?? []) { records.push({ item: epic, itemId: epic.id, itemType: 'epic' }); for (const story of epic.stories ?? []) { records.push({ item: story, itemId: story.id, itemType: 'story' }); for (const task of story.tasks ?? []) records.push({ item: task, itemId: task.id, itemType: 'task' }); } }
  return records;
}
function present(value) { return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0); }
function valueFor(snapshot, record, field, projectId) {
  if (Object.hasOwn(record.item, field)) return record.item[field];
  const definition = snapshot.customFields.find((candidate) => candidate.status === 'active' && candidate.scope === record.itemType && (candidate.id === field || candidate.name === field));
  return definition ? snapshot.customValues.find((candidate) => candidate.projectId === projectId && candidate.itemId === record.itemId && candidate.fieldId === definition.id)?.value : undefined;
}

export function verifyWorkflow({ now = new Date(), project, snapshot }) {
  const records = flatten(project); const byKey = new Map(records.map((record) => [`${record.itemType}:${record.itemId}`, record]));
  const bindings = snapshot.bindings.filter((record) => record.projectId === project.id);
  const workflowFor = (itemType) => { const binding = bindings.find((record) => record.itemType === itemType); return snapshot.workflows.find((record) => record.id === binding?.workflowId && record.status === 'active'); };
  const latestHistory = new Map();
  for (const history of snapshot.histories.filter((record) => record.projectId === project.id).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) latestHistory.set(`${history.itemType}:${history.itemId}`, history);
  const overdue = [...latestHistory.entries()].filter(([key, history]) => history.slaDueAt && Date.parse(history.slaDueAt) < now.getTime() && byKey.get(key)?.item.status === history.toState).map(([, history]) => history.itemId);
  const missing = [];
  for (const record of records) {
    const workflow = workflowFor(record.itemType); const state = workflow?.states.find((candidate) => candidate.key === record.item.status);
    const required = new Set(state?.requiredFields ?? []);
    for (const field of snapshot.customFields.filter((candidate) => candidate.status === 'active' && candidate.required && candidate.scope === record.itemType)) required.add(field.id);
    const fields = [...required].filter((field) => !present(valueFor(snapshot, record, field, project.id)));
    if (fields.length) missing.push({ fields, itemId: record.itemId, itemType: record.itemType });
  }
  const pending = snapshot.approvals.filter((record) => record.projectId === project.id && record.status === 'pending');
  const checks = [
    { evidence: { approvalIds: pending.map((record) => record.id) }, id: 'workflow.no_pending_approvals', passed: pending.length === 0 },
    { evidence: { itemIds: overdue }, id: 'workflow.no_overdue_sla', passed: overdue.length === 0 },
    { evidence: { missing }, id: 'workflow.required_fields_complete', passed: missing.length === 0 },
  ];
  return { checks, failedCheckIds: checks.filter((check) => !check.passed).map((check) => check.id), passed: checks.every((check) => check.passed), verifier: 'workflow.v1' };
}
