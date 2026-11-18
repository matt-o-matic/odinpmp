import {
  generateValidatedStructuredOutput,
} from './responses-structured-output.js';
import { withOptionalTemperature } from './openai-model-capabilities.js';
import { normalizeAiCapabilityConfig } from './ai-capability-config.js';
import { HttpError } from '../errors/http-error.js';

export function emptyTenantConfig(defaultModel = '') {
  return normalizeAiCapabilityConfig({
    valid_config: false,
    openai_key: '',
    available_models: [],
    capabilities: {},
  }, { defaultModel });
}

function modelSupportsReasoning(model = '') {
  return /^(gpt-([5-9]|\d{2,})|o\d)/i.test(String(model ?? '').trim());
}

export function buildReasoning(reasoningEffort, model) {
  const effort = String(reasoningEffort ?? '').trim().toLowerCase();
  if (!effort || effort === 'none' || !modelSupportsReasoning(model)) {
    return undefined;
  }

  return { effort };
}

export function createFunctionCallOutput(callId, output = {}) {
  return {
    call_id: String(callId ?? '').trim(),
    output: JSON.stringify(output ?? {}),
    type: 'function_call_output',
  };
}

export function extractResponseOutputItems(response = {}, type = '') {
  return (response?.output ?? []).filter((item) => item?.type === type);
}

export function extractControllerText(response = {}) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  return extractResponseOutputItems(response, 'message')
    .flatMap((item) => item?.content ?? [])
    .filter((content) => content?.type === 'output_text')
    .map((content) => String(content.text ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function parseStructuredResponse({
  abortSignal = null,
  client,
  fatalOnValidation = true,
  input,
  instructions,
  maxRepairAttempts = 2,
  maxOutputTokens = 7000,
  model,
  onRepairAttempt = null,
  operationName,
  reasoningEffort = 'max',
  schema,
  schemaName,
  validator = null,
}) {
  return generateValidatedStructuredOutput({
    abortSignal,
    client,
    fatalOnValidation,
    input,
    instructions,
    maxRepairAttempts,
    maxOutputTokens,
    model,
    onRepairAttempt,
    operationName,
    reasoningEffort,
    schema,
    schemaName,
    validator,
  });
}

export async function streamAssistantReply({
  abortSignal = null,
  client,
  input,
  instructions,
  model,
  onDelta,
  reasoningEffort = 'max',
}) {
  const stream = await client.responses.create(
    withOptionalTemperature({
      input,
      instructions,
      max_output_tokens: 3000,
      model,
      reasoning: buildReasoning(reasoningEffort, model),
      store: false,
      stream: true,
    }, {
      model,
      temperature: 0.2,
    }),
    abortSignal ? { signal: abortSignal } : undefined,
  );

  let text = '';

  for await (const event of stream) {
    if (event.type !== 'response.output_text.delta' || !event.delta) {
      continue;
    }

    text += event.delta;
    if (typeof onDelta === 'function') {
      await onDelta(event.delta);
    }
  }

  return text.trim();
}

export function normalizeRuntimeError(error) {
  if (error instanceof HttpError) {
    return error;
  }

  const message = String(error?.message ?? '').trim() || 'Assistant AI request failed.';
  return new HttpError(502, `Assistant AI request failed: ${message}`);
}
