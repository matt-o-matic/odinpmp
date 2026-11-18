import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/errors/http-error.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';
import { REPORTING_KEY_TEMPLATE_ID } from './bug-reporter.mail-repository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

export function registerReportingMail({ router, oauth, wrap, internal, assistantRepository, projectRepository, mailRepository }) {
  const path = '/projects/:projectId/collaborators/:stakeholderId/key-deliveries/:keyId';
  async function context(req) {
    if (!mailRepository?.queueReportingMail || !mailRepository?.getReportingMail) throw new HttpError(503, 'Odin reporting mail is not configured.');
    const { application, token } = req.oauthAuth, { projectId, stakeholderId, keyId } = req.params;
    if (!application.projectIds.includes(projectId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(keyId)) throw new HttpError(404, 'Reporting delivery not found.');
    if (token.userId) await internal(req);
    const project = await projectRepository.getProjectAccess({ projectId, tenantId: application.tenantId, userId: token.userId ?? '' });
    if (!project?.exists) throw new HttpError(404, 'Reporting delivery not found.');
    const values = await assistantRepository.listProjectStakeholders({ projectId, tenantId: application.tenantId });
    const collaborator = values.find(value => value.id === stakeholderId);
    if (!collaborator) throw new HttpError(404, 'Reporting delivery not found.');
    const targetId = 'bugreporter:' + hash(JSON.stringify([application.id, application.tenantId, projectId, stakeholderId, keyId]));
    return { application, collaborator, targetId };
  }
  router.get(path, oauth, wrap(async (req, res) => {
    const { targetId } = await context(req);
    const delivery = await mailRepository.getReportingMail({ targetId });
    if (!delivery) throw new HttpError(404, 'Reporting delivery not found.');
    res.json({ delivery });
  }));
  router.post(path, oauth, wrap(async (req, res) => {
    const { application, collaborator, targetId } = await context(req);
    const { key, expiresAt, reporterOrigin, websiteUrls = [], retryVersion = 0 } = req.body ?? {};
    if (Object.keys(req.body ?? {}).some(field => !['key','expiresAt','reporterOrigin','websiteUrls','retryVersion'].includes(field))) throw new HttpError(400, 'Unexpected reporting mail field.');
    const expiry = Date.parse(expiresAt);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 7*86400000 + 60000 || !Number.isSafeInteger(retryVersion) || retryVersion < 0) throw new HttpError(400, 'Invalid reporting key delivery.');
    let origin; try { origin = new URL(reporterOrigin).origin; } catch { throw new HttpError(400, 'Invalid reporting origin.'); }
    if (origin !== reporterOrigin || !application.redirectUris.some(uri => new URL(uri).origin === origin)) throw new HttpError(403, 'Reporting origin is not registered for this application.');
    if (typeof collaborator.email !== 'string' || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(collaborator.email)) throw new HttpError(409, 'Correct the collaborator email in Odin before issuing a key.');
    if (!Array.isArray(websiteUrls) || websiteUrls.length > 20 || websiteUrls.some(value => {
      try { const url = new URL(value); return typeof value !== 'string' || value.length > 2048 || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))); }
      catch { return true; }
    })) throw new HttpError(400, 'Invalid testing website links.');
    const websiteLinks = websiteUrls.length ? '<ul>' + websiteUrls.map(url => '<li><a href="' + escape(url) + '">' + escape(url) + '</a></li>').join('') + '</ul>' : '<p>Open the website provided by your project team. You can also find its link in Bug Reporter after signing in.</p>';
    const rendered = await renderEmailFromTemplate({ mailRepository, templateId: REPORTING_KEY_TEMPLATE_ID, vars: { stakeholderName: escape(collaborator.name ?? 'Tester'), reportingKey: key, expiresAt: escape(new Date(expiry).toISOString()), reporterUrl: escape(origin), websiteLinks, applicationName: escape(application.name) } });
    const requestHash = hash(JSON.stringify([key, new Date(expiry).toISOString(), origin, collaborator.email.trim().toLowerCase()]));
    const delivery = await mailRepository.queueReportingMail({ ...rendered, recipientEmail: collaborator.email, templateId: REPORTING_KEY_TEMPLATE_ID, targetId, requestHash, retryVersion });
    if (delivery.conflict) throw new HttpError(409, 'This delivery identifier was already used for different key data or a different retry.');
    res.status(delivery.status === 'queued' ? 202 : 200).json({ delivery });
  }));
}
