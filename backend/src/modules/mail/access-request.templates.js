// The email the team gets when someone asks for access on the marketing site.
// Every placeholder is filled with escaped text.

export const ACCESS_REQUEST_TEMPLATE_ID = 'access-request-v1';

export const accessRequestTemplates = {
  [ACCESS_REQUEST_TEMPLATE_ID]: {
    name: 'Access request from the marketing site',
    subject: 'Odin access request from {{name}}',
    styles: `
      .muted { color:#6b7280; font-size:13px; }
      .facts td { padding:4px 14px 4px 0; vertical-align:top; }
      .facts td:first-child { color:#6b7280; white-space:nowrap; }
      .note { margin:6px 0 14px; padding:8px 14px; border-left:3px solid #d0d7de; overflow-wrap:anywhere; }
    `,
    contents: `
      <h2 style="margin:0 0 10px; font-size:20px;">{{name}} asked for access to Odin</h2>
      <table class="facts" role="presentation">
        <tr><td>Email</td><td><a href="mailto:{{email}}">{{email}}</a></td></tr>
        <tr><td>Company</td><td>{{company}}</td></tr>
        <tr><td>Company size</td><td>{{companySize}}</td></tr>
        <tr><td>What they build</td><td>{{industry}}</td></tr>
        <tr><td>Early features</td><td>{{betaInterest}}</td></tr>
      </table>
      <h3 style="margin:16px 0 0; font-size:15px;">The project they'd bring</h3>
      <div class="note">{{comments}}</div>
      <p class="muted">Reply to this email to answer {{name}} directly.</p>
    `,
  },
};
