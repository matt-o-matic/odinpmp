import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { ACCESS_REQUEST_TEMPLATE_ID } from '../mail/access-request.templates.js';
import { renderEmailFromTemplate } from '../mail/mail.service.js';

const COMPANY_SIZES = {
  '1-10': '1 to 10',
  '11-50': '11 to 50',
  '51-200': '51 to 200',
  '201-1000': '201 to 1,000',
  '1000+': 'More than 1,000',
};

function getEmailDomain(email) {
  return String(email ?? '').trim().split('@')[1]?.toLowerCase() ?? '';
}

function logWaitlistFailure({ error, operation, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, extra),
    error,
    level: 'warn',
    message: 'Waitlist operation failed.',
  });
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Subjects are plain-text headers, so the escaping the template needed is undone.
function plainSubject(value) {
  return String(value ?? '').replace(/&(lt|gt|quot|#39|amp);/g, (match, entity) => ({ amp: '&', '#39': "'", gt: '>', lt: '<', quot: '"' })[entity]);
}

// One request is kept per email address. Asking again gets the same answer as asking the first
// time, so the form never reveals whether an address has asked before, and nobody is emailed twice.
export async function createWaitlistSignup(input, repository) {
  if (!repository || typeof repository.findByEmail !== 'function' || typeof repository.create !== 'function') {
    throw new Error('A waitlist repository with findByEmail and create methods is required.');
  }

  const { website: _website, ...fields } = input;
  const normalizedEmail = fields.email.toLowerCase();
  const logExtra = {
    betaInterest: Boolean(fields.betaInterest),
    companyProvided: Boolean(String(fields.company ?? '').trim()),
    emailDomain: getEmailDomain(normalizedEmail),
  };

  let existing;
  try {
    existing = await repository.findByEmail(normalizedEmail);
  } catch (error) {
    logWaitlistFailure({ error, extra: logExtra, operation: 'waitlist.createSignup' });
    throw error;
  }

  if (existing) {
    return { created: false, signup: existing };
  }

  try {
    return { created: true, signup: await repository.create({ ...fields, email: normalizedEmail }) };
  } catch (error) {
    // Two submissions racing for the same address: the other one won.
    if (error?.code === 'ER_DUP_ENTRY') {
      return { created: false, signup: null };
    }
    logWaitlistFailure({ error, extra: logExtra, operation: 'waitlist.createSignup' });
    throw error;
  }
}

// Emails each configured recipient about a new request, with the requester as the reply address.
// The request is already saved, so a mail failure is logged rather than returned to the visitor.
export async function notifyAccessRequest({ mailRepository, recipients = [] }, signup) {
  if (!mailRepository?.queueMail || recipients.length === 0 || !signup) {
    return 0;
  }

  const given = (value) => escapeText(String(value ?? '').trim() || 'Not given');
  const vars = {
    betaInterest: signup.betaInterest ? 'Yes, they want to try new features early' : 'No',
    comments: given(signup.comments).replace(/\r?\n/g, '<br>'),
    company: given(signup.company),
    companySize: given(COMPANY_SIZES[signup.companySize] ?? signup.companySize),
    email: escapeText(signup.email),
    industry: given(signup.industry),
    name: escapeText(signup.name),
  };

  let queued = 0;
  try {
    const rendered = await renderEmailFromTemplate({ mailRepository, templateId: ACCESS_REQUEST_TEMPLATE_ID, vars });
    for (const recipient of recipients) {
      const sent = await mailRepository.queueMail({
        body: rendered.body,
        recipientEmail: recipient,
        // The queue column holds 255 characters; a longer address is still in the email body.
        replyTo: signup.email.length <= 255 ? signup.email : '',
        subject: plainSubject(rendered.subject),
        targetId: `access-request-${signup.id}`,
        templateId: ACCESS_REQUEST_TEMPLATE_ID,
      });
      if (sent) queued += 1;
    }
  } catch (error) {
    logWaitlistFailure({ error, extra: { emailDomain: getEmailDomain(signup.email), queued }, operation: 'waitlist.notifyTeam' });
  }
  return queued;
}
