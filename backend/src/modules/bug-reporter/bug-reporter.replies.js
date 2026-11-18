import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/errors/http-error.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { normalizeInboundReplyBody as normalizeInboundClarificationReplyBody } from '../../lib/content/email-replies.js';
import { REPLY_NOT_ADDED_TEMPLATE_ID } from './bug-reporter.replies-repository.js';

export const REPLY_TEXT_LIMIT = 10000;
export const REPLY_FILE_LIMIT = 20;
export const REPLY_FILE_BYTES = 10 * 1024 * 1024;
// The file types Bug Reporter accepts on a report.
const EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONS = ['report_deleted', 'addition_limit', 'reporter_mismatch', 'invalid'];
const NOTICE = {
  report_deleted: 'The report has been deleted.',
  addition_limit: 'The report cannot take any more additions. Contact your project team if you have more to add.',
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = value => String(value ?? '').trim().toLowerCase();

export function extractBugReportToken({ toEmail, mailReplyDomain }) {
  const match = /^bugreport\+([0-9a-f]{32,64})@(.+)$/.exec(lower(toEmail));
  return match && match[2] === lower(mailReplyDomain) ? match[1] : '';
}

// Verdicts come from the headers SES adds on receipt; the Lambda forwards them lowercased.
export function passesSenderChecks(verdicts = {}) {
  const value = key => lower(verdicts?.[key]);
  return value('spam') === 'pass' && value('virus') === 'pass' && (value('spf') === 'pass' || value('dkim') === 'pass') && value('dmarc') !== 'fail';
}

export function isAutomaticReply(headers = {}) {
  const autoSubmitted = lower(headers?.autoSubmitted), precedence = lower(headers?.precedence);
  return Boolean((autoSubmitted && autoSubmitted !== 'no') || ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence) || lower(headers?.xAutoreply));
}

export function acceptedFiles(attachments = []) {
  const files = [];
  let bytes = 0;
  for (const attachment of attachments) {
    const name = String(attachment?.fileName ?? '').trim();
    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
    if (!extension || !EXTENSIONS.has(extension) || /[\\/\u0000-\u001f]/.test(name) || name.length > 255) continue;
    const data = Buffer.from(String(attachment.contentBase64 ?? ''), 'base64');
    if (!data.length || files.length >= REPLY_FILE_LIMIT || bytes + data.length > REPLY_FILE_BYTES) continue;
    bytes += data.length;
    files.push({ name, data });
  }
  return files;
}

async function currentEmail({ token, assistantRepository, authRepository }) {
  if (token.reporterKind === 'internal') return (await authRepository?.findUserById?.(token.reporterId))?.email ?? '';
  return (await assistantRepository?.findProjectStakeholderById?.({ projectId: token.projectId, stakeholderId: token.reporterId, tenantId: token.tenantId }))?.email ?? '';
}

// Accepts a reply to a Bug Reporter email, or logs why it was dropped. Dropped replies
// get no response email, and the webhook still answers 2xx so the Lambda does not retry.
export async function ingestBugReporterReply({ input, mailRepository, assistantRepository, authRepository, mailReplyDomain = '', emailReplies = false, logger = console }) {
  const messageHash = createHash('sha256').update(String(input?.messageId ?? '')).digest('hex').slice(0, 16);
  const drop = reason => { logger.warn?.(`Bug Reporter email reply dropped: ${reason} (message ${messageHash}).`); return { ok: true, matched: false }; };
  if (!emailReplies || !mailRepository?.findReplyToken) return drop('email replies are off');
  const replyToken = extractBugReportToken({ toEmail: input.toEmail, mailReplyDomain });
  const token = replyToken ? await mailRepository.findReplyToken({ token: replyToken }) : null;
  if (!token) return drop('unknown reply address');
  if (lower(input.fromEmail) !== lower(token.recipientEmail)) return drop('sender is not the notified reporter');
  if (lower(await currentEmail({ token, assistantRepository, authRepository })) !== lower(token.recipientEmail)) return drop('reporter email changed in Odin');
  if (!passesSenderChecks(input.verdicts)) return drop('sender checks failed');
  if (isAutomaticReply(input.autoReplyHeaders)) return drop('automatic reply');
  const text = normalizeInboundClarificationReplyBody({ htmlBody: input.htmlBody, textBody: input.textBody }).slice(0, REPLY_TEXT_LIMIT);
  const files = acceptedFiles(input.attachments);
  if (!text.trim() && !files.length) return drop('no text or accepted files');
  const saved = await mailRepository.saveReply({ token: replyToken, messageId: input.messageId, text, files });
  if (saved.duplicate) return drop('message already received');
  return { ok: true, matched: true };
}

export function registerReportingReplies({ router, oauth, wrap, mailRepository, projectRepository }) {
  const base = '/projects/:projectId/replies';
  async function context(req) {
    if (!mailRepository?.listPendingReplies) throw new HttpError(503, 'Odin reporting mail is not configured.');
    const { application, token } = req.oauthAuth, { projectId, replyId } = req.params;
    if (token.userId) throw new HttpError(403, 'Email replies require an application token.');
    if (!application.projectIds.includes(projectId) || (replyId !== undefined && !UUID.test(replyId))) throw new HttpError(404, 'Reply not found.');
    const project = await projectRepository.getProjectAccess({ projectId, tenantId: application.tenantId, userId: '' });
    if (!project?.exists) throw new HttpError(404, 'Reply not found.');
    return { applicationId: application.id, tenantId: application.tenantId, projectId };
  }
  router.get(base, oauth, wrap(async (req, res) => {
    const scope = await context(req);
    const raw = req.query.limit ?? '10';
    if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw) || Number(raw) < 1) throw new HttpError(400, 'Invalid reply limit.');
    res.json({ replies: await mailRepository.listPendingReplies({ ...scope, limit: Math.min(Number(raw), 10) }) });
  }));
  router.post(base + '/:replyId/outcome', oauth, wrap(async (req, res) => {
    const scope = await context(req);
    const body = req.body ?? {}, { outcome, reason } = body;
    const valid = outcome === 'added' ? Object.keys(body).every(key => key === 'outcome')
      : outcome === 'rejected' && REASONS.includes(reason) && Object.keys(body).every(key => ['outcome', 'reason'].includes(key));
    if (!valid) throw new HttpError(400, 'Invalid reply outcome.');
    const result = await mailRepository.settleReply({ ...scope, replyId: req.params.replyId, outcome, reason: reason ?? null });
    if (result.missing) throw new HttpError(404, 'Reply not found.');
    if (result.conflict) throw new HttpError(409, 'This reply already has a different outcome.');
    if (result.settled && NOTICE[reason]) {
      const rendered = await renderEmailFromTemplate({ mailRepository, templateId: REPLY_NOT_ADDED_TEMPLATE_ID, vars: { reportTitle: escape(result.reply.reportTitle), reason: NOTICE[reason] } });
      await mailRepository.queueMail({ ...rendered, recipientEmail: result.reply.recipientEmail, templateId: REPLY_NOT_ADDED_TEMPLATE_ID, targetId: 'bugreply:' + req.params.replyId });
    }
    res.json({ outcome, ...(reason ? { reason } : {}) });
  }));
}
