import { sanitizeRichHtml } from '../../lib/content/html-content.js';
import {
  CLARIFICATION_DIGEST_TEMPLATE_ID,
  REQUIREMENTS_MENTION_DIGEST_TEMPLATE_ID,
  CLARIFICATION_INVITATION_TEMPLATE_ID,
  GOAL_ATTENTION_TEMPLATE_ID,
  MENTION_TEMPLATE_ID,
  LINK_REQUEST_TEMPLATE_ID,
  REQUIREMENTS_LINK_TEMPLATE_ID,
  REVIEW_ROUND_INVITATION_TEMPLATE_ID,
  TASK_ACCESS_LINK_TEMPLATE_ID,
  TICKET_INTAKE_ACKNOWLEDGEMENT_TEMPLATE_ID,
  TICKET_INTAKE_INVITATION_TEMPLATE_ID,
  TICKET_INTAKE_STATUS_TEMPLATE_ID,
  builtInTemplates,
} from './mail.templates.js';

function resolveTemplate(templateRow, templateId) {
  const normalizedTemplateId = String(templateId ?? '').trim() || MENTION_TEMPLATE_ID;
  const fallback = builtInTemplates[normalizedTemplateId] ?? builtInTemplates[MENTION_TEMPLATE_ID];

  if (templateRow?.contents || templateRow?.styles || templateRow?.subject) {
    return {
      contents: templateRow.contents || fallback.contents,
      styles: templateRow.styles || fallback.styles,
      subject: templateRow.subject || fallback.subject,
    };
  }

  return {
    contents: fallback.contents,
    styles: fallback.styles,
    subject: fallback.subject,
  };
}

function interpolate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      return match;
    }

    return String(vars[key] ?? '');
  });
}

export async function renderEmailFromTemplate({ mailRepository, templateId, vars }) {
  const templateRow = typeof mailRepository?.getTemplate === 'function'
    ? await mailRepository.getTemplate({ templateId })
    : null;
  const template = resolveTemplate(templateRow, templateId);

  const subject = interpolate(template.subject || 'OdinPMP Notification', vars);
  const bodyInner = interpolate(template.contents, vars);
  const styles = interpolate(template.styles, vars);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>OdinPMP</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; padding: 0px; margin: 0px; }
    a { color: #1a73e8; text-decoration: none; }
    img { max-width: 150px; }
    .email-container { width: 100%; padding: 20px 0px; margin: 0px; background: #EEE; }
    .email-body { width: 95%; max-width: 700px; padding: 15px; border-radius: 10px; margin: 0px auto; background-color: #fff; border: 2px solid #D8D8D8; }
    ${styles}
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-body">
      ${bodyInner}
    </div>
  </div>
</body>
</html>
  `.trim();

  return {
    body: html,
    subject,
  };
}

export async function queueMentionEmail({
  mailRepository,
  mention,
  templateId = MENTION_TEMPLATE_ID,
  targetId,
} = {}) {
  if (!mailRepository || typeof mailRepository.queueMail !== 'function') {
    return false;
  }

  const recipientEmail = mention?.userEmail ?? '';

  if (!recipientEmail) {
    return false;
  }

  const vars = {
    ...mention,
    commentExcerpt: sanitizeRichHtml(String(mention?.commentExcerpt ?? '')),
  };

  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId,
    vars,
  });

  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: rendered.subject,
    targetId,
    templateId,
  });
}

export async function queueGoalAttentionEmail({ attention, goal, mailRepository, recipientEmail, url }) {
  if (!mailRepository?.queueMail || !recipientEmail || !attention?.id) return false;
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: GOAL_ATTENTION_TEMPLATE_ID,
    vars: {
      attentionMessage: sanitizeRichHtml(String(attention.message ?? '')),
      attentionTitle: String(attention.title ?? 'Odin goal needs attention'),
      attentionUrl: String(url ?? ''),
      goalTitle: String(goal?.title ?? 'Project goal'),
      severity: String(attention.severity ?? 'warning'),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: rendered.subject,
    targetId: attention.id,
    templateId: GOAL_ATTENTION_TEMPLATE_ID,
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Subjects are plain text headers: undo escapeHtml after the template fills them in.
function unescapeHtml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Review round invitation or reminder (requirements rounds). Every value except the URL is
 * plain text and is escaped; the URL is built by Odin. Resolves to queueMail's result.
 */
export async function queueReviewRoundEmail({
  accessLine = '',
  dueLine = '',
  inviterName = '',
  mailRepository,
  note = '',
  packageTitle = '',
  projectName = '',
  recipientEmail,
  reviewerName = '',
  reviewUrl,
  roundNumber,
  targetId,
  templateId = REVIEW_ROUND_INVITATION_TEMPLATE_ID,
} = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId,
    vars: {
      accessLine: escapeHtml(accessLine),
      dueLine: escapeHtml(dueLine),
      inviterName: escapeHtml(inviterName || 'The project team'),
      noteBlock: String(note ?? '').trim() ? `<div class="note">${escapeHtml(String(note).trim())}</div>` : '',
      packageTitle: escapeHtml(packageTitle || 'a review package'),
      projectName: escapeHtml(projectName || 'your project'),
      reviewerName: escapeHtml(reviewerName || 'there'),
      reviewUrl: escapeHtml(reviewUrl),
      roundNumber: escapeHtml(roundNumber),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: unescapeHtml(rendered.subject),
    targetId,
    templateId,
  });
}

/**
 * Tells a project admin or manager that a stakeholder asked for a new requirements link.
 * Every value except the URL is plain text and is escaped.
 */
export async function queueLinkRequestEmail({
  linksUrl,
  mailRepository,
  projectName = '',
  recipientEmail,
  stakeholderDetail = '',
  stakeholderName = '',
  targetId,
} = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: LINK_REQUEST_TEMPLATE_ID,
    vars: {
      linksUrl: escapeHtml(linksUrl),
      projectName: escapeHtml(projectName || 'your project'),
      stakeholderDetail: stakeholderDetail ? ` (${escapeHtml(stakeholderDetail)})` : '',
      stakeholderName: escapeHtml(stakeholderName || 'A stakeholder'),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: unescapeHtml(rendered.subject),
    targetId,
    templateId: LINK_REQUEST_TEMPLATE_ID,
  });
}

/**
 * Sends a stakeholder their requirements portal link. Every value except the URL is plain
 * text and is escaped; the URL is built by Odin. Resolves to queueMail's result.
 */
export async function queueRequirementsLinkEmail({
  mailRepository,
  portalUrl,
  projectName = '',
  recipientEmail,
  senderName = '',
  stakeholderName = '',
  targetId,
} = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: REQUIREMENTS_LINK_TEMPLATE_ID,
    vars: {
      portalUrl: escapeHtml(portalUrl),
      projectName: escapeHtml(projectName || 'your project'),
      senderName: escapeHtml(senderName || 'The project team'),
      stakeholderName: escapeHtml(stakeholderName || 'there'),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: unescapeHtml(rendered.subject),
    targetId,
    templateId: REQUIREMENTS_LINK_TEMPLATE_ID,
  });
}

/**
 * Sends someone without a login their access link: who sent it, the workspace, the projects it
 * opens, and the link. Every value except the URL is plain text and is escaped; the URL is built
 * by Odin. Resolves to queueMail's result.
 */
export async function queueTaskAccessLinkEmail({
  accessUrl,
  mailRepository,
  projectNames = [],
  recipientEmail,
  recipientName = '',
  senderName = '',
  targetId,
  workspaceName = '',
} = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const names = projectNames.map((name) => String(name ?? '').trim()).filter(Boolean);
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: TASK_ACCESS_LINK_TEMPLATE_ID,
    vars: {
      accessUrl: escapeHtml(accessUrl),
      projectList: names.length ? `<p>It opens:</p><ul>${names.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>` : '',
      recipientName: escapeHtml(recipientName || 'there'),
      senderName: escapeHtml(senderName || 'The project team'),
      workspaceName: escapeHtml(workspaceName || 'Odin'),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: unescapeHtml(rendered.subject),
    targetId,
    templateId: TASK_ACCESS_LINK_TEMPLATE_ID,
  });
}

/**
 * Signature request emails (docs/document-signing). `vars` are plain text and are escaped, except
 * keys ending in Url, which Odin builds, and `messageBlock`, which is built here from `message`.
 * Resolves to queueMail's result.
 */
export async function queueSigningEmail({ mailRepository, message = '', recipientEmail, targetId, templateId, vars = {} } = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const escaped = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, escapeHtml(value)]));
  const note = String(message ?? '').trim();
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId,
    vars: {
      ...escaped,
      messageBlock: note ? `<blockquote style="margin:12px 0; padding:8px 12px; border-left:3px solid #D8D8D8; white-space:pre-wrap;">${escapeHtml(note)}</blockquote>` : '',
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: unescapeHtml(rendered.subject),
    targetId,
    templateId,
  });
}

export async function queueClarificationInvitationEmail({
  invitation,
  mailRepository,
  replyTo = '',
  targetId,
  templateId = CLARIFICATION_INVITATION_TEMPLATE_ID,
} = {}) {
  if (!mailRepository || typeof mailRepository.queueMail !== 'function') {
    return false;
  }

  const recipientEmail = String(invitation?.stakeholderEmail ?? '').trim();
  if (!recipientEmail) {
    return false;
  }

  const vars = {
    clarificationPrompt: sanitizeRichHtml(String(invitation?.clarificationPrompt ?? '')),
    clarificationRationale: sanitizeRichHtml(String(invitation?.clarificationRationale ?? '')),
    clarificationUrl: String(invitation?.clarificationUrl ?? '').trim(),
    odinLogo: '<img src="https://odinpmp.com/app/brand/odin-mark-email.png" alt="OdinPMP" width="72" style="display:block; width:72px; max-width:72px; height:auto; border:0; margin-left:auto;" />',
    projectName: sanitizeRichHtml(String(invitation?.projectName ?? 'Project')),
    replyAddress: sanitizeRichHtml(String(invitation?.replyAddress ?? '')),
    stakeholderName: sanitizeRichHtml(String(invitation?.stakeholderName ?? 'Stakeholder')),
  };

  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId,
    vars,
  });

  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    replyTo: String(replyTo ?? '').trim() || undefined,
    subject: rendered.subject,
    targetId,
    templateId,
  });
}

function ticketReplyBlock(replyAddress) {
  const address = String(replyAddress ?? '').trim();
  return address
    ? `<div class="reply-box">To add detail, reply to this email. Your reply is added to your report.<br />Reply address: <strong>${escapeHtml(address)}</strong></div>`
    : '';
}

/**
 * Sends an external reporter their ticket intake link. Every value except the URL is plain
 * text and is escaped; the URL is built by Odin. Resolves to queueMail's result.
 */
export async function queueTicketIntakeInvitationEmail({
  expiryLine = '',
  mailRepository,
  projectName = '',
  recipientEmail,
  reporterName = '',
  reportUrl,
  senderName = '',
  targetId,
} = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: TICKET_INTAKE_INVITATION_TEMPLATE_ID,
    vars: {
      expiryLine: expiryLine ? ` ${escapeHtml(expiryLine)}` : '',
      projectName: escapeHtml(projectName || 'the project'),
      reportUrl: escapeHtml(reportUrl),
      reporterName: escapeHtml(reporterName || 'there'),
      senderName: escapeHtml(senderName || 'The project team'),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    subject: unescapeHtml(rendered.subject),
    targetId,
    templateId: TICKET_INTAKE_INVITATION_TEMPLATE_ID,
  });
}

/**
 * Acknowledges an external ticket submission, or, with `previousStatusLabel`, tells the
 * reporter its status changed. Plain-text values are escaped; URLs are built by Odin.
 */
export async function queueTicketReporterEmail({
  mailRepository,
  previousStatusLabel = '',
  projectName = '',
  recipientEmail,
  replyTo = '',
  reportUrl = '',
  reporterName = '',
  statusLabel = '',
  targetId,
  ticketName = '',
  ticketReference = '',
} = {}) {
  if (!mailRepository?.queueMail || !String(recipientEmail ?? '').trim()) return false;
  const templateId = previousStatusLabel ? TICKET_INTAKE_STATUS_TEMPLATE_ID : TICKET_INTAKE_ACKNOWLEDGEMENT_TEMPLATE_ID;
  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId,
    vars: {
      linkBlock: reportUrl ? `<p style="margin-top:14px"><a class="cta" href="${escapeHtml(reportUrl)}">View your reports</a></p>` : '',
      previousStatusLabel: escapeHtml(previousStatusLabel),
      projectName: escapeHtml(projectName || 'the project'),
      replyBlock: ticketReplyBlock(replyTo),
      reporterName: escapeHtml(reporterName || 'there'),
      statusLabel: escapeHtml(statusLabel),
      ticketName: escapeHtml(ticketName),
      ticketReference: escapeHtml(ticketReference),
    },
  });
  return mailRepository.queueMail({
    body: rendered.body,
    recipientEmail,
    replyTo: String(replyTo ?? '').trim() || undefined,
    // mail_queue.subject is VARCHAR(255) and a ticket name can be up to 200 characters.
    subject: unescapeHtml(rendered.subject).slice(0, 255),
    targetId,
    templateId,
  });
}

const ODIN_EMAIL_LOGO = '<img src="https://odinpmp.com/app/brand/odin-mark-email.png" alt="OdinPMP" width="72" style="display:block; width:72px; max-width:72px; height:auto; border:0; margin-left:auto;" />';

/**
 * Renders one stakeholder's clarification digest at send time. A single topic reads like the single
 * invitation, with its reply address as Reply-To. Several topics are listed, each with its
 * own reply address, and no Reply-To, since a reply must reach exactly one clarification.
 * Prompts and rationales are sanitized rich text; names, links and addresses are escaped.
 */
/**
 * One email for every mention and topic reply waiting for a recipient in one project.
 * `digest.mentions`: `[{ authorName, commentHtml, excerpt, relation, url, where }]`.
 * `relation` is 'tagged' for a mention, and 'owner' or 'contributor' for a new comment on a
 * topic the recipient owns or commented on. `commentHtml` is the whole comment as sanitized
 * HTML (lib/content/email-markdown.js) and is used when present; the rest is plain text.
 */
function mentionDigestSubject({ firstAuthor, projectName, replies, single, tagged }) {
  if (single) return tagged ? `${firstAuthor} mentioned you in ${projectName}` : `${firstAuthor} replied on a topic in ${projectName}`;
  if (!replies) return `You were mentioned ${tagged} times in ${projectName}`;
  if (!tagged) return `${replies} new replies on your topics in ${projectName}`;
  return `${tagged + replies} new comments for you in ${projectName}`;
}

function mentionDigestHeadline({ action, firstAuthor, projectName, replies, single, tagged }) {
  const project = `<strong>${escapeHtml(projectName)}</strong>`;
  const newReplies = replies === 1 ? 'is 1 new reply' : `are ${replies} new replies`;
  if (single) return `${escapeHtml(firstAuthor)} ${action} in ${project}.`;
  if (!replies) return `You were mentioned ${tagged} times in ${project}.`;
  if (!tagged) return `There ${newReplies} on topics you own or commented on in ${project}.`;
  return `You were mentioned ${tagged === 1 ? 'once' : `${tagged} times`}, and there ${newReplies} on topics you own or commented on, in ${project}.`;
}

export async function renderMentionDigestEmail({ digest, mailRepository } = {}) {
  const recipientEmail = String(digest?.recipientEmail ?? '').trim();
  const mentions = Array.isArray(digest?.mentions) ? digest.mentions : [];
  if (!recipientEmail || !mentions.length) return null;

  const projectName = String(digest?.projectName ?? '').trim() || 'Project';
  const single = mentions.length === 1;
  const firstAuthor = String(mentions[0].authorName ?? '').trim() || 'Someone';
  const isReply = (mention) => mention.relation === 'owner' || mention.relation === 'contributor';
  const action = (mention) => (!isReply(mention) ? 'mentioned you'
    : mention.relation === 'owner' ? 'replied on a topic you own' : 'replied on a topic you commented on');
  const replies = mentions.filter(isReply).length;
  const tagged = mentions.length - replies;
  const mentionsHtml = mentions.map((mention) => `
      <div class="mention">
        <h3>${escapeHtml(String(mention.authorName ?? '').trim() || 'Someone')} ${action(mention)}</h3>
        <div class="muted">${escapeHtml(String(mention.where ?? ''))}</div>
        ${mention.commentHtml ? `<div class="comment">${mention.commentHtml}</div>` : `<blockquote>${escapeHtml(String(mention.excerpt ?? ''))}</blockquote>`}
        ${mention.url ? `<div style="margin-top:12px"><a class="cta" href="${escapeHtml(mention.url)}">Open the discussion</a></div>` : ''}
      </div>`).join('');

  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: REQUIREMENTS_MENTION_DIGEST_TEMPLATE_ID,
    vars: {
      digestSubject: mentionDigestSubject({ firstAuthor, projectName, replies, single, tagged }),
      headline: mentionDigestHeadline({ action: action(mentions[0]), firstAuthor, projectName, replies, single, tagged }),
      mentionsHtml,
      odinLogo: ODIN_EMAIL_LOGO,
      recipientName: escapeHtml(String(digest?.recipientName ?? '').trim() || 'there'),
    },
  });
  return { html: rendered.body, subject: rendered.subject, to: recipientEmail };
}

export async function renderClarificationDigestEmail({ digest, mailRepository } = {}) {
  const recipientEmail = String(digest?.stakeholderEmail ?? '').trim();
  const topics = Array.isArray(digest?.topics) ? digest.topics : [];
  if (!recipientEmail || !topics.length) return null;

  const single = topics.length === 1;
  const projectName = String(digest?.projectName ?? '').trim() || 'Project';
  const sharedUrl = topics.every((topic) => topic.url === topics[0].url) ? String(topics[0].url ?? '') : '';
  const replyLine = (address) => (address ? `<div class="muted" style="margin-top:8px">Reply address: <code>${escapeHtml(address)}</code></div>` : '');
  const topicsHtml = topics.map((topic) => `
      <div class="prompt">
        <h3>${sanitizeRichHtml(String(topic.prompt ?? ''))}</h3>
        <div>${sanitizeRichHtml(String(topic.rationale ?? ''))}</div>${single ? '' : `
        ${!sharedUrl && topic.url ? `<div style="margin-top:10px"><a href="${escapeHtml(topic.url)}">Open this clarification</a></div>` : ''}${replyLine(topic.replyAddress)}`}
      </div>`).join('');
  const ctaHtml = sharedUrl
    ? `<div style="margin-top:14px"><a class="cta" href="${escapeHtml(sharedUrl)}">${single ? 'Open clarification queue' : 'Open your clarifications'}</a></div>`
    : '';
  const replyHtml = single
    ? `<div class="reply-box">You can also reply directly to this email with text and attachments.<br />Reply address: <code>${escapeHtml(topics[0].replyAddress ?? '')}</code></div>`
    : topics.some((topic) => topic.replyAddress)
      ? '<div class="reply-box">You can also answer by email, with text and attachments: write to the reply address under a clarification. Each address goes to that clarification only.</div>'
      : '';

  const rendered = await renderEmailFromTemplate({
    mailRepository,
    templateId: CLARIFICATION_DIGEST_TEMPLATE_ID,
    vars: {
      ctaHtml,
      digestSubject: single ? `Clarification needed for ${projectName}` : `${topics.length} clarifications need your input in ${projectName}`,
      headline: single
        ? `A single clarification in <strong>${escapeHtml(projectName)}</strong> needs your input.`
        : `${topics.length} clarifications in <strong>${escapeHtml(projectName)}</strong> need your input.`,
      odinLogo: ODIN_EMAIL_LOGO,
      replyHtml,
      stakeholderName: escapeHtml(String(digest?.stakeholderName ?? '').trim() || 'Stakeholder'),
      topicsHtml,
    },
  });

  const replyTo = single ? String(topics[0].replyAddress ?? '').trim() : '';
  return { html: rendered.body, replyTo: replyTo || undefined, subject: rendered.subject, to: recipientEmail };
}
