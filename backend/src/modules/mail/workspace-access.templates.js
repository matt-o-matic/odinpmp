// Emails for requests to join a workspace. Every placeholder is filled with escaped text.

export const JOIN_REQUEST_CONFIRM_TEMPLATE_ID = 'workspace-join-confirm-v1';
export const JOIN_REQUEST_ADMIN_TEMPLATE_ID = 'workspace-join-request-v1';
export const JOIN_REQUEST_APPROVED_TEMPLATE_ID = 'workspace-join-approved-v1';
export const JOIN_REQUEST_DECLINED_TEMPLATE_ID = 'workspace-join-declined-v1';

const STYLES = `
      .muted { color:#6b7280; font-size:13px; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
    `;

export const workspaceAccessTemplates = {
  [JOIN_REQUEST_CONFIRM_TEMPLATE_ID]: {
    name: 'Workspace join request confirmation',
    subject: 'Confirm your request to join {{workspaceName}}',
    styles: STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{requesterName}}</h2>
      <p>You asked to join the OdinPMP workspace {{workspaceName}}. Confirm that this is your email address so its admins can see your request.</p>
      <p><a class="cta" href="{{confirmUrl}}">Confirm my email</a></p>
      <p class="muted">The link works once and expires in 24 hours. If you didn’t ask to join this workspace, ignore this email and nothing happens.</p>
    `,
  },
  [JOIN_REQUEST_ADMIN_TEMPLATE_ID]: {
    name: 'Workspace join request',
    subject: '{{requesterName}} asked to join {{workspaceName}}',
    styles: STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">{{requesterName}} asked to join {{workspaceName}}</h2>
      <p>{{requesterName}} ({{requesterEmail}}) confirmed their email address and is waiting for an admin to approve or decline the request.</p>
      <p><a class="cta" href="{{requestsUrl}}">Review requests to join</a></p>
      <p class="muted">They get no access until an admin approves. You get this email because you are an admin of {{workspaceName}}; turn it off in your profile’s notification settings.</p>
    `,
  },
  [JOIN_REQUEST_APPROVED_TEMPLATE_ID]: {
    name: 'Workspace join request approved',
    subject: 'You can now use {{workspaceName}}',
    styles: STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{requesterName}}</h2>
      <p>An admin approved your request to join {{workspaceName}}. You joined as {{role}}.</p>
      <p><a class="cta" href="{{appUrl}}">Open OdinPMP</a></p>
      <p class="muted">Switch to {{workspaceName}} from the workspace list in your account menu.</p>
    `,
  },
  [JOIN_REQUEST_DECLINED_TEMPLATE_ID]: {
    name: 'Workspace join request declined',
    subject: 'Your request to join {{workspaceName}}',
    styles: STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{requesterName}}</h2>
      <p>An admin of {{workspaceName}} declined your request to join it.</p>
      <p class="muted">If you think this is a mistake, contact someone in that workspace and ask them for an invitation.</p>
    `,
  },
};
