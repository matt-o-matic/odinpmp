import { accessRequestTemplates } from './access-request.templates.js';
import { accountEmailTemplates } from './account-email.templates.js';
import { workspaceAccessTemplates } from './workspace-access.templates.js';

export const MENTION_TEMPLATE_ID = '0f8e1ca0-c732-11ef-b0f9-080027889936';
export const CLARIFICATION_INVITATION_TEMPLATE_ID = '6a4ed9ab-18e8-4d73-a754-9f9c1b70bc1e';
export const CLARIFICATION_DIGEST_TEMPLATE_ID = 'clarification-invitation-digest-v1';
export const REQUIREMENTS_MENTION_DIGEST_TEMPLATE_ID = 'requirements-mention-digest-v1';
export const GOAL_ATTENTION_TEMPLATE_ID = 'goal-attention-v1';

export const WORKSPACE_INVITATION_TEMPLATE_ID = 'workspace-invitation-v1';
export const SIGNUP_VERIFICATION_TEMPLATE_ID = 'signup-verification-v1';
export const REVIEW_ROUND_INVITATION_TEMPLATE_ID = 'requirements-round-invitation-v1';
export const REVIEW_ROUND_REMINDER_TEMPLATE_ID = 'requirements-round-reminder-v1';
export const LINK_REQUEST_TEMPLATE_ID = 'requirements-link-request-v1';
export const REQUIREMENTS_LINK_TEMPLATE_ID = 'requirements-link-v1';
export const TASK_ACCESS_LINK_TEMPLATE_ID = 'task-access-link-v1';
export const TICKET_INTAKE_INVITATION_TEMPLATE_ID = 'ticket-intake-invitation-v1';
export const TICKET_INTAKE_ACKNOWLEDGEMENT_TEMPLATE_ID = 'ticket-intake-acknowledgement-v1';
export const TICKET_INTAKE_STATUS_TEMPLATE_ID = 'ticket-intake-status-v1';
// Signature requests (docs/document-signing): asking for a signature or reminding, the one-time
// code a signer enters, and news of a request (signed by everyone, declined or withdrawn).
export const SIGNING_REQUEST_TEMPLATE_ID = 'signing-request-v1';
export const SIGNING_CODE_TEMPLATE_ID = 'signing-code-v1';
export const SIGNING_UPDATE_TEMPLATE_ID = 'signing-update-v1';
// A file someone uploaded had a virus in it, and was removed (docs/engagements/plan.md, Upload).
export const FILE_INFECTED_TEMPLATE_ID = 'file-infected-v1';
// The rolled-up chat email: notifications a person has not seen in Odin (docs/odin-chat/plan.md,
// Email; modules/notifications/chat-digest.service.js).
export const CHAT_DIGEST_TEMPLATE_ID = 'chat-digest-v1';
// Channel guests (docs/engagements/plan.md, Guests): the invitation, and the code that signs them in.
export const GUEST_INVITATION_TEMPLATE_ID = 'guest-invitation-v1';
export const GUEST_SIGN_IN_CODE_TEMPLATE_ID = 'guest-sign-in-code-v1';

const REVIEW_ROUND_STYLES = `
      .muted { color:#6b7280; font-size:13px; }
      .note { margin-top:14px; padding:14px; border:1px solid #e5e7eb; border-radius:12px; background:#f8fafc; white-space:pre-wrap; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
    `;

const TICKET_INTAKE_STYLES = `${REVIEW_ROUND_STYLES}
      .reply-box { margin-top:14px; padding:12px; border-radius:10px; background:#f4f7fb; border:1px dashed #cbd5e1; }
    `;

export const builtInTemplates = {
  ...accessRequestTemplates,
  ...workspaceAccessTemplates,
  ...accountEmailTemplates,
  // The reply variants add one line; Odin uses them only when the email has a reply address.
  ['bug-reporter-update-reply-v1']: {
    name: 'Bug report update with status, priority and reply address',
    subject: 'Update on your bug report: {{reportTitle}}',
    styles: 'p { overflow-wrap:anywhere; }',
    contents: '<h2>Hello {{reporterName}}</h2><p>{{introduction}}</p><h3>{{reportTitle}}</h3><p><strong>Status:</strong> {{statusLabel}}<br><strong>Priority:</strong> {{priority}}</p>{{customerComment}}<p><a href="{{reportUrl}}">View your report</a> in Bug Reporter.</p><p>Reply to this email to add information to your report.</p>',
  },
  ['bug-reporter-status-reply-v1']: {
    name: 'Bug report status update with reply address',
    subject: 'Your bug report has been {{status}}: {{reportTitle}}',
    styles: 'p { overflow-wrap:anywhere; }',
    contents: '<h2>Hello {{reporterName}}</h2><p>Your bug report <strong>{{reportTitle}}</strong> has been {{status}}.</p>{{customerComment}}<p><a href="{{reportUrl}}">View your report</a> in Bug Reporter.</p><p>Reply to this email to add information to your report.</p>',
  },
  // Tells a bug's assignee that its reporter added information or reopened it. It has no reply line.
  ['bug-reporter-assignee-v1']: {
    name: 'Bug report notice to the assignee',
    subject: 'A bug assigned to you has changed: {{reportTitle}}',
    styles: 'p { overflow-wrap:anywhere; } .comment { margin:14px 0; padding:2px 14px; border-left:3px solid #d0d7de; }',
    contents: '<h2>Hello {{assigneeName}}</h2><p>{{introduction}}</p><h3>{{reportTitle}}</h3>{{reporterComment}}{{fileSummary}}<p><a href="{{reportUrl}}">Open the report</a> in Bug Reporter.</p>',
  },
  ['bug-reporter-reply-not-added-v1']: {
    name: 'Bug report reply could not be added',
    subject: 'Your reply could not be added to your bug report',
    styles: 'p { overflow-wrap:anywhere; }',
    contents: '<p>Your email reply to the bug report <strong>{{reportTitle}}</strong> could not be added. {{reason}}</p>',
  },
  ['bug-reporter-update-v2']: {
    name: 'Bug report update with status and priority',
    subject: 'Update on your bug report: {{reportTitle}}',
    styles: 'p { overflow-wrap:anywhere; }',
    contents: '<h2>Hello {{reporterName}}</h2><p>{{introduction}}</p><h3>{{reportTitle}}</h3><p><strong>Status:</strong> {{statusLabel}}<br><strong>Priority:</strong> {{priority}}</p>{{customerComment}}<p><a href="{{reportUrl}}">View your report</a> in Bug Reporter.</p>',
  },
  ['bug-reporter-update-v1']: {
    name: 'Bug report status update',
    subject: 'Your bug report has been {{status}}: {{reportTitle}}',
    styles: 'p { overflow-wrap:anywhere; }',
    contents: '<h2>Hello {{reporterName}}</h2><p>Your bug report <strong>{{reportTitle}}</strong> has been {{status}}.</p>{{customerComment}}<p><a href="{{reportUrl}}">View your report</a> in Bug Reporter.</p>',
  },
  ['bug-reporter-key-v2']: {
    name: 'Bug reporting access',
    subject: 'Your bug reporting key',
    styles: 'code { font-size:16px; overflow-wrap:anywhere; }',
    contents: '<h2>Hello {{stakeholderName}}</h2><p>You have been invited to report website issues through {{applicationName}}.</p><p>Your one-time reporting key is:</p><p><code>{{reportingKey}}</code></p><p>Start on the website you are testing:</p>{{websiteLinks}}<p>Click the bug icon, choose Connect and enable, and enter your key in the access window. Complete the connection and return to the website. Click the bug icon and choose Report a bug when you find an issue.</p><p>Review your submitted reports at <a href="{{reporterUrl}}">Bug Reporter</a>.</p><p>This unused key expires {{expiresAt}}. After redemption, access expires after 30 days of inactivity.</p>',
  },
  ['bug-reporter-key-v1']: {
    name: 'Bug reporting access',
    subject: 'Your bug reporting key',
    styles: 'code { font-size:16px; overflow-wrap:anywhere; }',
    contents: '<h2>Hello {{stakeholderName}}</h2><p>You have been invited to report website issues through {{applicationName}}.</p><p>Your one-time reporting key is:</p><p><code>{{reportingKey}}</code></p><p>Enter it at <a href="{{reporterUrl}}">{{reporterUrl}}</a>. This unused key expires {{expiresAt}}. After redemption, access expires after 30 days of inactivity.</p>',
  },
  [WORKSPACE_INVITATION_TEMPLATE_ID]: {
    name: 'Workspace invitation',
    subject: 'Your OdinPMP workspace invitation',
    styles: '.cta { display: inline-block; padding: 10px 14px; background: #0d6efd; color: #fff !important; border-radius: 6px; }',
    contents: `<h2>You’re invited to {{workspaceName}}</h2>
      <p>You’ve been invited to join this workspace as {{role}}.</p>
      <p><a class="cta" href="{{invitationUrl}}">Accept invitation</a></p>
      <p>Sign in with {{email}}, or create an account using this link. The invitation expires in 30 days.</p>
      <p>If you weren’t expecting this invitation, you can ignore it.</p>`,
  },
  [SIGNUP_VERIFICATION_TEMPLATE_ID]: {
    name: 'Sign-up email confirmation',
    subject: 'Confirm your email to finish signing up for OdinPMP',
    styles: '.cta { display: inline-block; padding: 10px 14px; background: #0d6efd; color: #fff !important; border-radius: 6px; }',
    contents: `<h2>Hello {{name}}</h2>
      <p>Confirm your email address to finish creating the {{workspaceName}} workspace on OdinPMP.</p>
      <p><a class="cta" href="{{verificationUrl}}">Confirm email and create workspace</a></p>
      <p>The link works once and expires in 24 hours.</p>
      <p>If you didn’t sign up, ignore this email. Nothing is created until the link is used.</p>`,
  },
  [MENTION_TEMPLATE_ID]: {
    name: 'Mention notification',
    subject: 'You were mentioned in {{projectName}}{{extendedName}}',
    styles: `
      .pill { display:inline-block; padding:3px 10px; border-radius:999px; background:#eef2f7; font-size:12px; color:#334; }
      .excerpt { padding:12px; border:1px solid #e5e7eb; border-radius:10px; background:#f8fafc; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
      .muted { color:#6b7280; font-size:12px; }
    `,
    contents: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <tr>
          <td valign="middle" style="padding-right:12px; vertical-align:middle;">
            <div>
              <h2 style="margin:0; font-size:18px;">Hello {{userName}}</h2>
              <div class="muted">You were mentioned by <strong>{{commenterName}}</strong> in <span class="pill">{{projectName}}{{extendedName}}</span></div>
            </div>
          </td>
          <td align="right" valign="middle" style="width:84px; text-align:right; vertical-align:middle;">
            {{odinLogo}}
          </td>
        </tr>
      </table>
      <div style="margin-top:14px" class="excerpt">
        {{commentExcerpt}}
      </div>
      <div style="margin-top:14px">
        <a class="cta" href="{{url}}">Open in OdinPMP</a>
      </div>
      <div style="margin-top:12px" class="muted">
        {{commentDate}} ({{userTimeZone}})
      </div>
    `,
  },
  [CLARIFICATION_INVITATION_TEMPLATE_ID]: {
    name: 'Clarification invitation',
    subject: 'Clarification needed for {{projectName}}',
    styles: `
      .muted { color:#6b7280; font-size:13px; }
      .prompt { margin-top:14px; padding:14px; border:1px solid #e5e7eb; border-radius:12px; background:#f8fafc; }
      .prompt h3 { margin:0 0 8px; font-size:16px; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
      .reply-box { margin-top:14px; padding:12px; border-radius:10px; background:#f4f7fb; border:1px dashed #cbd5e1; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    `,
    contents: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <tr>
          <td valign="top" style="padding-right:12px; vertical-align:top;">
            <div>
              <h2 style="margin:0; font-size:20px;">Hello {{stakeholderName}}</h2>
              <div class="muted">A single clarification in <strong>{{projectName}}</strong> needs your input.</div>
            </div>
          </td>
          <td align="right" valign="top" style="width:84px; text-align:right; vertical-align:top;">
            {{odinLogo}}
          </td>
        </tr>
      </table>
      <div class="prompt">
        <h3>{{clarificationPrompt}}</h3>
        <div>{{clarificationRationale}}</div>
      </div>
      <div style="margin-top:14px">
        <a class="cta" href="{{clarificationUrl}}">Open clarification queue</a>
      </div>
      <div class="reply-box">
        You can also reply directly to this email with text and attachments.<br />
        Reply address: <code>{{replyAddress}}</code>
      </div>
    `,
  },
  // One email per stakeholder and project for every clarification they were assigned to
  // since the last one (clarification-invitation-digest.service.js). The sections are built
  // and escaped by queueClarificationDigestEmail; one topic reads like the single invitation.
  [CLARIFICATION_DIGEST_TEMPLATE_ID]: {
    name: 'Clarification invitation digest',
    subject: '{{digestSubject}}',
    styles: `
      .muted { color:#6b7280; font-size:13px; }
      .prompt { margin-top:14px; padding:14px; border:1px solid #e5e7eb; border-radius:12px; background:#f8fafc; }
      .prompt h3 { margin:0 0 8px; font-size:16px; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
      .reply-box { margin-top:14px; padding:12px; border-radius:10px; background:#f4f7fb; border:1px dashed #cbd5e1; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    `,
    contents: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <tr>
          <td valign="top" style="padding-right:12px; vertical-align:top;">
            <div>
              <h2 style="margin:0; font-size:20px;">Hello {{stakeholderName}}</h2>
              <div class="muted">{{headline}}</div>
            </div>
          </td>
          <td align="right" valign="top" style="width:84px; text-align:right; vertical-align:top;">
            {{odinLogo}}
          </td>
        </tr>
      </table>
      {{topicsHtml}}
      {{ctaHtml}}
      {{replyHtml}}
    `,
  },
  [REQUIREMENTS_MENTION_DIGEST_TEMPLATE_ID]: {
    name: 'Requirements mention digest',
    subject: '{{digestSubject}}',
    styles: `
      .muted { color:#6b7280; font-size:13px; }
      .mention { margin-top:14px; padding:14px; border:1px solid #e5e7eb; border-radius:12px; background:#f8fafc; }
      .mention h3 { margin:0 0 4px; font-size:15px; }
      .mention blockquote { margin:10px 0 0; padding:0 0 0 12px; border-left:3px solid #cbd5e1; color:#374151; white-space:pre-wrap; overflow-wrap:anywhere; }
      .mention .comment { margin-top:10px; padding-left:12px; border-left:3px solid #cbd5e1; color:#374151; overflow-wrap:anywhere; }
      .mention .comment p, .mention .comment ul, .mention .comment ol, .mention .comment pre { margin:0 0 8px; }
      .mention .comment blockquote { white-space:normal; }
      .mention .comment pre { padding:8px; border-radius:6px; background:#eef2f7; white-space:pre-wrap; }
      .mention .comment h1, .mention .comment h2, .mention .comment h3 { margin:8px 0 4px; font-size:15px; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
    `,
    contents: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <tr>
          <td valign="top" style="padding-right:12px; vertical-align:top;">
            <div>
              <h2 style="margin:0; font-size:20px;">Hello {{recipientName}}</h2>
              <div class="muted">{{headline}}</div>
            </div>
          </td>
          <td align="right" valign="top" style="width:84px; text-align:right; vertical-align:top;">
            {{odinLogo}}
          </td>
        </tr>
      </table>
      {{mentionsHtml}}
    `,
  },
  [REVIEW_ROUND_INVITATION_TEMPLATE_ID]: {
    name: 'Review round invitation',
    subject: 'Review round {{roundNumber}} for {{projectName}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{reviewerName}}</h2>
      <p>{{inviterName}} asked you to review <strong>{{packageTitle}}</strong>, round {{roundNumber}} in {{projectName}}.</p>
      {{noteBlock}}
      <p>{{dueLine}}</p>
      <p><a class="cta" href="{{reviewUrl}}">Open the review</a></p>
      <p class="muted">{{accessLine}}</p>
    `,
  },
  [REVIEW_ROUND_REMINDER_TEMPLATE_ID]: {
    name: 'Review round reminder',
    subject: 'Reminder: round {{roundNumber}} review for {{projectName}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{reviewerName}}</h2>
      <p>Your review of <strong>{{packageTitle}}</strong>, round {{roundNumber}} in {{projectName}}, is not submitted yet.</p>
      <p>{{dueLine}}</p>
      <p><a class="cta" href="{{reviewUrl}}">Continue the review</a></p>
      <p class="muted">{{accessLine}}</p>
    `,
  },
  [REQUIREMENTS_LINK_TEMPLATE_ID]: {
    name: 'Requirements link',
    subject: '{{senderName}} invited you to {{projectName}} requirements',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{stakeholderName}}</h2>
      <p>{{senderName}} invited you to answer questions and review work for {{projectName}}.</p>
      <p><a class="cta" href="{{portalUrl}}">Open your requirements page</a></p>
      <p class="muted">This link is for you alone, so please do not forward it. No account or password is needed.</p>
    `,
  },
  // A person without a login gets one link per workspace for their tasks and requirements.
  [TASK_ACCESS_LINK_TEMPLATE_ID]: {
    name: 'Task access link',
    subject: '{{senderName}} sent you a link to your work in {{workspaceName}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{recipientName}}</h2>
      <p>{{senderName}} sent you a link to your work in {{workspaceName}}.</p>
      {{projectList}}
      <p><a class="cta" href="{{accessUrl}}">Open your work</a></p>
      <p class="muted">This link is for you alone, so please do not forward it. No account or password is needed.</p>
    `,
  },
  [SIGNING_REQUEST_TEMPLATE_ID]: {
    name: 'Signature request',
    subject: '{{subjectPrefix}}{{title}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{recipientName}}</h2>
      <p>{{intro}}</p>
      {{messageBlock}}
      <p><a class="cta" href="{{signingUrl}}">Review and sign</a></p>
      <p class="muted">You will be asked for a one-time code, which we email to this address when you choose to sign. This link is for you alone, so please do not forward it. No account or password is needed.</p>
    `,
  },
  [SIGNING_CODE_TEMPLATE_ID]: {
    name: 'Signing code',
    subject: 'Your signing code: {{code}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Your signing code</h2>
      <p>Enter this code to sign "{{title}}":</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:6px; margin:12px 0;">{{code}}</p>
      <p class="muted">It works for 15 minutes. If you did not ask to sign, ignore this email: nothing is signed without the code.</p>
    `,
  },
  [SIGNING_UPDATE_TEMPLATE_ID]: {
    name: 'Signature request update',
    subject: '{{headline}}: {{title}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">{{headline}}</h2>
      <p>{{body}}</p>
      <p><a class="cta" href="{{linkUrl}}">{{linkLabel}}</a></p>
    `,
  },
  [CHAT_DIGEST_TEMPLATE_ID]: {
    name: 'Chat email digest',
    subject: '{{digestSubject}}',
    styles: `
      .muted { color:#6b7280; font-size:13px; }
      .item { margin-top:12px; padding:14px; border:1px solid #e5e7eb; border-radius:12px; background:#f8fafc; }
      .item h3 { margin:0 0 4px; font-size:15px; }
      .item blockquote { margin:8px 0 0; padding-left:12px; border-left:3px solid #cbd5e1; color:#374151; overflow-wrap:anywhere; }
    `,
    contents: `
      {{preheaderHtml}}
      <div style="text-align:right">{{odinLogo}}</div>
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{recipientName}}</h2>
      <p>{{headline}}</p>
      {{itemsHtml}}
      <p class="muted" style="margin-top:18px;">Odin emails what you have not seen in Odin within 10 minutes, rolled into one email. {{settingsHtml}}</p>
    `,
  },
  [GUEST_INVITATION_TEMPLATE_ID]: {
    name: 'Channel guest invitation',
    subject: '{{senderName}} invited you to {{channelName}} in {{projectName}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{recipientName}}</h2>
      <p>{{senderName}} invited you to the {{channelName}} channel of {{projectName}} in {{workspaceName}}. You can read and post messages, and share files there.</p>
      <p><a class="cta" href="{{channelUrl}}">Open the channel</a></p>
      <p class="muted">To sign in, enter this email address. We email you a code. No account or password is needed.</p>
    `,
  },
  [GUEST_SIGN_IN_CODE_TEMPLATE_ID]: {
    name: 'Guest sign-in code',
    subject: 'Your sign-in code: {{code}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Your sign-in code</h2>
      <p>Enter this code to sign in to {{workspaceName}}:</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:6px; margin:12px 0;">{{code}}</p>
      <p class="muted">It works for 15 minutes. If you did not ask to sign in, ignore this email: nobody can sign in without the code.</p>
    `,
  },
  [FILE_INFECTED_TEMPLATE_ID]: {
    name: 'Virus found in an uploaded file',
    subject: 'A virus was found in {{fileName}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{recipientName}}</h2>
      <p>The virus scanner found a virus in {{fileName}} (version {{version}}), which you uploaded to {{projectName}}. Odin removed the file's contents, so nobody can download it.</p>
      <p>Check the copy on your computer before you upload it again.</p>
      <p><a class="cta" href="{{fileUrl}}">Open the project's files</a></p>
    `,
  },
  [TICKET_INTAKE_INVITATION_TEMPLATE_ID]: {
    name: 'Ticket intake link',
    subject: 'Report issues for {{projectName}}',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{reporterName}}</h2>
      <p>{{senderName}} invited you to report issues for {{projectName}}.</p>
      <p><a class="cta" href="{{reportUrl}}">Report an issue</a></p>
      <p>The same page lists what you have reported and where each report stands.</p>
      <p class="muted">This link is for you alone, so please do not forward it. No account or password is needed.{{expiryLine}}</p>
    `,
  },
  [TICKET_INTAKE_ACKNOWLEDGEMENT_TEMPLATE_ID]: {
    name: 'Ticket intake acknowledgement',
    subject: 'We received your report: {{ticketName}} [Ref {{ticketReference}}]',
    styles: TICKET_INTAKE_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{reporterName}}</h2>
      <p>Thank you. The {{projectName}} team received your report.</p>
      <div class="note"><strong>{{ticketName}}</strong><br />Reference: {{ticketReference}}<br />Status: {{statusLabel}}</div>
      {{linkBlock}}
      {{replyBlock}}
    `,
  },
  [TICKET_INTAKE_STATUS_TEMPLATE_ID]: {
    name: 'Ticket intake status update',
    subject: 'Update on your report: {{ticketName}} [Ref {{ticketReference}}]',
    styles: TICKET_INTAKE_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{reporterName}}</h2>
      <p>Your report to {{projectName}} moved from <strong>{{previousStatusLabel}}</strong> to <strong>{{statusLabel}}</strong>.</p>
      <div class="note"><strong>{{ticketName}}</strong><br />Reference: {{ticketReference}}</div>
      {{linkBlock}}
      {{replyBlock}}
    `,
  },
  [LINK_REQUEST_TEMPLATE_ID]: {
    name: 'Requirements link request',
    subject: '{{stakeholderName}} asked for a new link to {{projectName}} requirements',
    styles: REVIEW_ROUND_STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">{{stakeholderName}} asked for a new link</h2>
      <p>{{stakeholderName}}{{stakeholderDetail}} asked for a new link to {{projectName}} requirements. Their link has expired.</p>
      <p><a class="cta" href="{{linksUrl}}">Open stakeholder links</a></p>
      <p class="muted">You get this email because you manage stakeholder links in this project.</p>
    `,
  },
  [GOAL_ATTENTION_TEMPLATE_ID]: {
    name: 'Goal attention',
    subject: '{{attentionTitle}}',
    styles: `
      .severity { display:inline-block; padding:3px 10px; border-radius:999px; background:#fee2e2; color:#991b1b; font-size:12px; font-weight:700; text-transform:uppercase; }
      .message { margin-top:14px; padding:14px; border:1px solid #fecaca; border-radius:12px; background:#fff7f7; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
      .muted { color:#6b7280; font-size:13px; }
    `,
    contents: `
      <h2 style="margin:0 0 6px;">{{goalTitle}}</h2>
      <div class="severity">{{severity}}</div>
      <div class="message">{{attentionMessage}}</div>
      <div style="margin-top:14px"><a class="cta" href="{{attentionUrl}}">Review goal attention</a></div>
      <div style="margin-top:12px" class="muted">This notification was generated by an enabled Odin goal escalation policy.</div>
    `,
  },
};
