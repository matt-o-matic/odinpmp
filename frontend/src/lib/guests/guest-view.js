// The guest view's shared pieces: where sign-in sends a guest
// back to, and readable messages for sign-in errors. Pure functions, so they test without a
// browser; the tab's guest API is in guest-client.js.

/** A path inside the guest view to return to after signing in; anything else goes home. */
export function safeGuestNext(value) {
  const next = String(value ?? '');
  return /^\/guest(?:\/[\w\-/?=&%.]*)?$/.test(next) && !next.startsWith('//') && !next.startsWith('/guest/sign-in') ? next : '/guest';
}

/** The sign-in page's route for someone who must sign in to reach `fullPath`. */
export function signInRouteFor(fullPath, { notice = '', workspace = '' } = {}) {
  const query = { next: safeGuestNext(fullPath) };
  if (workspace) query.workspace = workspace;
  if (notice) query.notice = notice;
  return { name: 'guest-sign-in', query };
}

/**
 * The notice for a refused request: none for someone who never signed in (an invitation link),
 * "expired" for a session that ended, "ended" for a guest with no channel left.
 */
export function signInNoticeFor(error) {
  const code = error?.data?.details?.code;
  if (code === 'guest_access_ended') return 'ended';
  if (code === 'guest_session_ended') return 'expired';
  return '';
}

/** True for the errors that mean the guest is not signed in (any more). */
export function needsSignIn(error) {
  return error?.status === 401;
}

const NOTICES = {
  ended: 'You no longer have access there. If you think you should, ask the person who invited you.',
  expired: 'Your session ended. Sign in again to continue.',
  'signed-out': 'You signed out.',
};

export function guestNotice(value) {
  return NOTICES[String(value ?? '')] ?? '';
}

/** A message for a failed sign-in step. */
export function signInErrorMessage(error) {
  const code = error?.data?.details?.code;
  const remaining = error?.data?.details?.remaining;
  switch (code) {
    case 'invalid_email': return 'Enter your email address.';
    case 'code_invalid': return remaining > 0 ? `That code is not right. ${remaining === 1 ? 'One try is' : `${remaining} tries are`} left.` : 'That code is not right.';
    case 'code_locked': return 'Too many wrong codes. Ask for a new one.';
    case 'code_expired': return 'That code has expired. Ask for a new one.';
    case 'code_required': return 'Ask for a new code first.';
    case 'code_recently_sent': return 'A code was sent a moment ago. Check your email, or ask again in a minute.';
    case 'rate_limited': return 'Too many tries. Wait a few minutes, then try again.';
    default: return error?.status ? (error.message || 'Something went wrong. Try again.') : 'Odin could not be reached. Check your connection and try again.';
  }
}

/** "1:05" until a resend is allowed, or "" once it is. */
export function resendCountdown(resendAt, now = Date.now()) {
  const seconds = Math.ceil((Number(resendAt ?? 0) - now) / 1000);
  if (!(seconds > 0)) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
