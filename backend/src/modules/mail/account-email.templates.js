// Emails for changing an account's email address (users/email-change.js). Every placeholder is
// filled with escaped text, and the subjects have none.

export const EMAIL_CHANGE_CONFIRM_TEMPLATE_ID = 'account-email-change-confirm-v1';
export const EMAIL_CHANGE_NOTICE_TEMPLATE_ID = 'account-email-change-notice-v1';

const STYLES = `
      .muted { color:#6b7280; font-size:13px; }
      .cta { display:inline-block; padding:10px 14px; border-radius:10px; background:#0d6efd; color:#fff !important; text-decoration:none; font-weight:600; }
    `;

export const accountEmailTemplates = {
  [EMAIL_CHANGE_CONFIRM_TEMPLATE_ID]: {
    name: 'Confirm a new account email address',
    subject: 'Confirm your new OdinPMP email address',
    styles: STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{name}}</h2>
      <p>You asked to use {{newEmail}} for your OdinPMP account. Confirm that this is your address to make the change.</p>
      <p><a class="cta" href="{{confirmUrl}}">Confirm my new email</a></p>
      <p class="muted">The link works once and expires in 24 hours. Until you open it, your account keeps its current address. If you didn’t ask for this, ignore this email and nothing changes.</p>
    `,
  },
  [EMAIL_CHANGE_NOTICE_TEMPLATE_ID]: {
    name: 'Account email change requested',
    subject: 'Someone asked to change your OdinPMP email address',
    styles: STYLES,
    contents: `
      <h2 style="margin:0 0 6px; font-size:20px;">Hello {{name}}</h2>
      <p>Someone signed in to your OdinPMP account asked to change its email address to {{newEmail}}. Your account keeps this address until the change is confirmed from that inbox.</p>
      <p>If this was you, there’s nothing more to do here.</p>
      <p class="muted">If it wasn’t you, <a href="{{profileUrl}}">open your profile</a>, change your password and sign out your other sessions.</p>
    `,
  },
};
