import { createHash, randomBytes } from 'node:crypto';
import { commentToEmailHtml } from '../../lib/content/email-markdown.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { ASSIGNEE_NOTICE_TEMPLATE_ID, REPLY_TEMPLATE_IDS, REPORTING_UPDATE_TEMPLATE_ID } from './bug-reporter.mail-repository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = ['New', 'Triaged', 'In progress', 'Resolved', 'Closed'];
const FIELDS = ['reporterKind', 'reporterId', 'reportId', 'reportUrl', 'title', 'status', 'comment', 'priority', 'updateType', 'retryVersion'];
// These two types email a bug's assignee, given as an internal reporter, about something its
// reporter (authorName) did. Every other type emails the reporter.
const NOTICES = {
  addition: { subject: title => `New information on a bug assigned to you: ${title}`, introduction: author => `${author} added information to a bug assigned to you.` },
  reopening: { subject: title => `A bug assigned to you was reopened: ${title}`, introduction: author => `${author} reopened a bug assigned to you.` },
};
export function registerReportingUpdates({ router, oauth, wrap, internal, assigned, authRepository, assistantRepository, projectRepository, mailRepository, mailReplyDomain = '', emailReplies = false }) {
  const replyDomain = String(mailReplyDomain ?? '').trim().toLowerCase();
  const replies = Boolean(emailReplies && replyDomain && mailRepository?.ensureReplyToken);
  const path = '/projects/:projectId/report-updates/:notificationId';
  async function context(req) {
    if (!mailRepository?.queueReportingMail) throw new HttpError(503, 'Odin reporting mail is not configured.');
    const { application, token } = req.oauthAuth, { projectId, notificationId } = req.params;
    if (!application.projectIds.includes(projectId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(notificationId)) throw new HttpError(404, 'Report update not found.');
    if (token.userId) await internal(req);
    const project = await projectRepository.getProjectAccess({ projectId, tenantId: application.tenantId, userId: token.userId ?? '' });
    if (!project?.exists) throw new HttpError(404, 'Report update not found.');
    return { application, projectId, targetId: 'reportupdate:' + hash(JSON.stringify([application.id, application.tenantId, projectId, notificationId])) };
  }
  router.get(path, oauth, wrap(async (req, res) => {
    const { targetId } = await context(req);
    const delivery = await mailRepository.getReportingMail({ targetId });
    if (!delivery) throw new HttpError(404, 'Report update not found.');
    res.json({ delivery });
  }));
  router.post(path, oauth, wrap(async (req, res) => {
    const { application, projectId, targetId } = await context(req);
    const body = req.body ?? {}, { reporterKind, reporterId, reportId, reportUrl, title, status, comment = '', priority, updateType = 'status', authorName, fileCount, retryVersion = 0 } = body;
    const notice = Object.hasOwn(NOTICES, updateType) ? NOTICES[updateType] : null;
    if (Object.keys(body).some(key => !FIELDS.includes(key) && !(notice && ['authorName', 'fileCount'].includes(key))) ||
      !(notice ? ['internal'] : ['internal', 'collaborator']).includes(reporterKind) || typeof reporterId !== 'string' || reporterId.length > 200 ||
      typeof reportId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(reportId) ||
      typeof title !== 'string' || !title.trim() || title.length > 300 || /[\r\n]/.test(title) ||
      !['status', 'manual', 'addition', 'reopening'].includes(updateType) || !(updateType === 'status' ? ['Resolved', 'Closed'] : STATUSES).includes(status) || (priority !== undefined || updateType !== 'status') && !['Low', 'Normal', 'High', 'Urgent'].includes(priority) || updateType === 'manual' && (typeof comment !== 'string' || !comment.trim()) || typeof comment !== 'string' || comment.length > 20000 ||
      notice && (typeof authorName !== 'string' || authorName.length > 200 || !Number.isSafeInteger(fileCount) || fileCount < 0) ||
      !Number.isSafeInteger(retryVersion) || retryVersion < 0) throw new HttpError(400, 'Invalid report update.');
    let url;
    try { url = new URL(reportUrl); } catch { throw new HttpError(400, 'Invalid report link.'); }
    if (typeof reportUrl !== 'string' || reportUrl.length > 2048 || url.username || url.password || url.hash || url.pathname !== '/' || url.searchParams.get('reportId') !== reportId || !application.redirectUris.some(uri => new URL(uri).origin === url.origin)) throw new HttpError(403, 'Report link is not registered for this application.');
    let person;
    if (reporterKind === 'internal') {
      person = await authRepository.findUserById(reporterId);
      if (!await assigned(person, projectId, application.tenantId)) person = null;
    } else {
      person = (await assistantRepository.listProjectStakeholders({ projectId, tenantId: application.tenantId })).find(value => value.id === reporterId);
    }
    const role = notice ? 'assignee' : 'reporter';
    if (!person) throw new HttpError(404, `The ${role} is no longer assigned to this project.`);
    if (typeof person.email !== 'string' || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(person.email)) throw new HttpError(409, `Correct the ${role} email in Odin before retrying.`);
    const baseTemplateId = body.priority === undefined && body.updateType === undefined ? 'bug-reporter-update-v1' : REPORTING_UPDATE_TEMPLATE_ID;
    // A reply from the assignee is not information from the reporter, so notices get no reply address.
    const withReply = replies && !notice;
    const templateId = notice ? ASSIGNEE_NOTICE_TEMPLATE_ID : withReply ? REPLY_TEMPLATE_IDS[baseTemplateId] : baseTemplateId;
    // Each notification gets one reply token. Retries find the stored token, and the first
    // writer wins when two copies of the same notification arrive together.
    const replyFields = { applicationId: application.id, tenantId: application.tenantId, projectId, reportId, reporterKind, reporterId, recipientEmail: person.email.trim().toLowerCase(), reportTitle: title };
    const replyToken = withReply ? await mailRepository.ensureReplyToken({ targetId, token: randomBytes(20).toString('hex'), ...replyFields }) : null;
    // Markdown from Bug Reporter is sent formatted; plain text keeps its line breaks.
    const rendered = await renderEmailFromTemplate({ mailRepository, templateId, vars: notice ? {
      assigneeName: escape(person.name || 'there'), introduction: escape(notice.introduction(authorName.trim() || 'The reporter')), reportTitle: escape(title),
      reporterComment: comment.trim() ? '<div class="comment">' + commentToEmailHtml(comment) + '</div>' : '',
      fileSummary: fileCount ? `<p>${fileCount} ${fileCount === 1 ? 'file' : 'files'} added.</p>` : '',
      reportUrl: escape(url.href),
    } : {
      reporterName: escape(person.name || 'Tester'), priority: escape(priority || 'Not supplied'), statusLabel: escape(status), introduction: updateType === 'manual' ? 'There is an update on your bug report.' : `Your bug report has been ${status.toLowerCase()}.`, reportTitle: escape(title), status: status.toLowerCase(),
      customerComment: comment.trim() ? '<h3>Message from the team</h3>' + commentToEmailHtml(comment) : '',
      reportUrl: escape(url.href),
    } });
    rendered.subject = notice ? notice.subject(title) : updateType === 'manual' ? `Update on your bug report: ${title}` : `Your bug report has been ${status.toLowerCase()}: ${title}`;
    const requestHash = hash(JSON.stringify([reporterKind, reporterId, reportId, url.href, title, status, comment, person.email.trim().toLowerCase(), ...(body.priority === undefined && body.updateType === undefined ? [] : [priority ?? null, updateType]), ...(notice ? [authorName, fileCount] : [])]));
    const replyTo = replyToken ? `bugreport+${replyToken}@${replyDomain}` : '';
    const delivery = await mailRepository.queueReportingMail({ ...rendered, recipientEmail: person.email, replyTo, templateId, targetId, requestHash, retryVersion });
    if (delivery.conflict) throw new HttpError(409, 'This notification identifier was already used for different report data.');
    // The queued email matches this request, so the token describes it. This also repairs a
    // token left by an attempt that failed before its email was queued.
    if (replyToken) await mailRepository.updateReplyToken({ targetId, ...replyFields });
    res.status(delivery.status === 'queued' ? 202 : 200).json({ delivery });
  }));
}
