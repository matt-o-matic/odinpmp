// Requests to join a workspace (/api/workspace-access) and their review by the workspace's
// admins (/api/tenants/user-requests). `request` is the client's tracked request function.
export function workspaceAccessMethods(request) {
  const segment = (value) => encodeURIComponent(String(value ?? ''));
  return {
    async listWorkspaceAccessRequests(token) {
      return (await request('/api/workspace-access/requests', { token })).data;
    },
    async requestWorkspaceAccess(payload, token) {
      return (await request('/api/workspace-access/requests', { body: payload, method: 'POST', token })).data;
    },
    async resendWorkspaceAccessConfirmation(requestId, token) {
      return (await request(`/api/workspace-access/requests/${segment(requestId)}/resend-confirmation`, { body: {}, method: 'POST', token })).data;
    },
    async cancelWorkspaceAccessRequest(requestId, token) {
      return (await request(`/api/workspace-access/requests/${segment(requestId)}/cancel`, { body: {}, method: 'POST', token })).data;
    },
    // Needs no session: the emailed token is the credential, and it travels in the body.
    async confirmWorkspaceAccessEmail(confirmationToken) {
      return (await request('/api/workspace-access/confirm', { body: { token: confirmationToken }, method: 'POST', skipAuthRedirect: true })).data;
    },
    // An account email change, confirmed from the link sent to the new address (no session needed).
    async confirmEmailChange(confirmationToken) {
      return (await request('/api/account/email-change/confirm', { body: { token: confirmationToken }, method: 'POST', skipAuthRedirect: true })).data;
    },
    async approveTenantUserRequest(requestId, payload, token) {
      return (await request(`/api/tenants/user-requests/${segment(requestId)}/approve`, { body: payload, method: 'POST', token })).data;
    },
    async declineTenantUserRequest(requestId, token) {
      return (await request(`/api/tenants/user-requests/${segment(requestId)}/decline`, { body: {}, method: 'POST', token })).data;
    },
  };
}
