// Labels and list handling for requests to join a workspace, shared by the requester's page
// and the admins' Requests to join tab.

export const JOIN_REQUEST_ROLES = Object.freeze([
  { label: 'User', value: 'user' },
  { label: 'Manager', value: 'manager' },
  { label: 'Admin', value: 'admin' },
]);

export const ADMIN_REQUESTS_PAGE_SIZE = 10;

export function requesterStatus(request) {
  if (request?.status === 'pending') {
    return request.emailConfirmed
      ? { label: 'Waiting for an admin', tone: 'info' }
      : { label: 'Confirm your email', tone: 'warning' };
  }
  return ({
    approved: { label: 'Approved', tone: 'success' },
    cancelled: { label: 'Cancelled', tone: 'secondary' },
    declined: { label: 'Declined', tone: 'secondary' },
  })[request?.status] ?? { label: 'Unknown', tone: 'secondary' };
}

export function verificationLabel(request) {
  if (!request?.emailVerifiedAt) return 'Not confirmed';
  return request.verificationMethod === 'earlier_confirmation' ? 'Confirmed on an earlier request' : 'Confirmed by email link';
}

export function formatRequestDate(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Filters by name or email, sorts by request time, and returns one page. */
export function pageOfRequests(requests = [], { page = 1, pageSize = ADMIN_REQUESTS_PAGE_SIZE, query = '', sort = 'newest' } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const matching = requests
    .filter((request) => !needle || `${request.name ?? ''} ${request.email ?? ''}`.toLowerCase().includes(needle))
    .sort((left, right) => {
      const order = String(left.requestedAt ?? '').localeCompare(String(right.requestedAt ?? ''));
      return sort === 'oldest' ? order : -order;
    });
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pageCount);
  return { items: matching.slice((current - 1) * pageSize, current * pageSize), page: current, pageCount, total: matching.length };
}
