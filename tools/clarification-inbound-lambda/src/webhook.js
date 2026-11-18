async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function forwardInboundPayload({
  fetchImpl = globalThis.fetch,
  payload,
  webhookSecret,
  webhookUrl,
} = {}) {
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required.');
  }

  if (!webhookUrl) {
    throw new Error('WEBHOOK_URL is required.');
  }

  if (!webhookSecret) {
    throw new Error('WEBHOOK_SECRET is required.');
  }

  const response = await fetchImpl(webhookUrl, {
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      'x-inbound-mail-secret': webhookSecret,
    },
    method: 'POST',
  });

  if (response.status >= 200 && response.status < 300) {
    return {
      retryable: false,
      statusCode: response.status,
    };
  }

  if (response.status >= 400 && response.status < 500) {
    return {
      retryable: false,
      statusCode: response.status,
    };
  }

  const responseText = await readResponseText(response);
  const suffix = responseText ? `: ${responseText.slice(0, 500)}` : '';
  throw new Error(`Webhook request failed with status ${response.status}${suffix}`);
}
