function normalizeString(value) {
  return String(value ?? '').trim();
}

function compareLabels(left, right) {
  return normalizeString(left).localeCompare(normalizeString(right), undefined, {
    sensitivity: 'base',
  });
}

function createStakeholderSummary(stakeholder = {}) {
  return {
    accessToken: normalizeString(stakeholder.accessToken),
    assignedClarificationCount: 0,
    email: normalizeString(stakeholder.email),
    id: normalizeString(stakeholder.id),
    invitations: [],
    name: normalizeString(stakeholder.name),
    reviews: [],
    roleTitle: normalizeString(stakeholder.roleTitle),
  };
}

function ensureStakeholderSummary(summaryById, stakeholder = {}) {
  const stakeholderId = normalizeString(stakeholder.id);
  if (!stakeholderId) {
    return null;
  }

  if (!summaryById.has(stakeholderId)) {
    summaryById.set(stakeholderId, createStakeholderSummary(stakeholder));
  }

  const summary = summaryById.get(stakeholderId);
  summary.accessToken = normalizeString(summary.accessToken || stakeholder.accessToken);
  summary.email = normalizeString(summary.email || stakeholder.email);
  summary.name = normalizeString(summary.name || stakeholder.name);
  summary.roleTitle = normalizeString(summary.roleTitle || stakeholder.roleTitle);
  return summary;
}

/**
 * Each stakeholder with the clarifications they were invited to and the review rounds they
 * review. `rounds` is the Requirements rounds list, each with its active `reviewers`.
 */
export function buildProjectStakeholderInvitationSummaries({
  clarifications = [],
  rounds = [],
  stakeholders = [],
} = {}) {
  const summaryById = new Map();

  for (const stakeholder of stakeholders ?? []) {
    ensureStakeholderSummary(summaryById, stakeholder);
  }

  for (const clarification of clarifications ?? []) {
    const countedStakeholderIds = new Set();

    for (const assignment of clarification?.assignments ?? []) {
      if (assignment?.actorType !== 'stakeholder') {
        continue;
      }

      const stakeholderId = normalizeString(assignment.actorId);
      if (!stakeholderId) {
        continue;
      }

      const summary = ensureStakeholderSummary(summaryById, {
        accessToken: assignment.accessToken,
        id: stakeholderId,
        name: assignment.label,
      });
      if (!summary) {
        continue;
      }

      if (!countedStakeholderIds.has(stakeholderId)) {
        countedStakeholderIds.add(stakeholderId);
        summary.assignedClarificationCount += 1;
      }

      if (!normalizeString(assignment.invitationToken)) {
        continue;
      }

      summary.invitations.push({
        accessToken: normalizeString(assignment.accessToken),
        clarificationId: normalizeString(clarification.id),
        invitationToken: normalizeString(assignment.invitationToken),
        lastInboundAt: assignment.lastInboundAt ?? null,
        mailStatus: normalizeString(assignment.mailStatus),
        prompt: normalizeString(clarification.prompt) || 'Clarification',
        queuedAt: assignment.queuedAt ?? null,
        replyToken: normalizeString(assignment.replyToken),
        sentAt: assignment.sentAt ?? null,
      });
    }
  }

  for (const round of rounds ?? []) {
    for (const reviewer of round?.reviewers ?? []) {
      if (reviewer?.actorType !== 'stakeholder') continue;
      const summary = summaryById.get(normalizeString(reviewer.actorId));
      if (!summary) continue;
      summary.reviews.push({
        dueAt: round.dueAt ?? null,
        invitedAt: reviewer.invitedAt ?? null,
        mailStatus: normalizeString(reviewer.mailStatus),
        number: Number(round.number) || null,
        required: Boolean(reviewer.required),
        roundId: normalizeString(round.id),
        roundStatus: normalizeString(round.status),
        submittedAt: reviewer.submittedAt ?? null,
        title: normalizeString(round.title),
        track: normalizeString(round.track),
      });
    }
  }

  return [...summaryById.values()]
    .map((summary) => ({
      ...summary,
      invitations: [...summary.invitations].sort((left, right) => compareLabels(left.prompt, right.prompt)),
      // Open rounds first, then the newest.
      reviews: [...summary.reviews].sort((left, right) => (left.roundStatus === 'open' ? 0 : 1) - (right.roundStatus === 'open' ? 0 : 1)
        || compareLabels(left.track, right.track) || (right.number ?? 0) - (left.number ?? 0)),
    }))
    .sort((left, right) => {
      const leftLabel = left.name || left.email || left.id;
      const rightLabel = right.name || right.email || right.id;
      return compareLabels(leftLabel, rightLabel);
    });
}
