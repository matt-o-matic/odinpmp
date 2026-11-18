/** Classifies an SMTP failure: hard bounces (unknown mailbox) are not retried. */
export function classifyBounce(errorMessage) {
  const message = String(errorMessage ?? '');

  if (/550/i.test(message) || /user unknown/i.test(message)) {
    return 'hard';
  }

  return 'soft';
}
