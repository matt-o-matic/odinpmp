import { parseStructuredResponse } from '../../../lib/ai/assistant-openai-runtime.js';
import { summaryOutputSchema } from './summary-output.js';
import {
  REQUIREMENTS_SUMMARY_OPERATION,
  REQUIREMENTS_SUMMARY_SCHEMA_NAME,
  requirementsSummaryInstructions,
  serializeSummaryModelInput,
} from './summary-prompt.js';

// The Odin summary's OpenAI call. Provider selection, the production guard for the local
// fixture, and tenant key and model resolution live in
// ../ai/requirements-ai-service.js (createRequirementsAiService exposes summarize()).

export const REQUIREMENTS_SUMMARY_CAPABILITY = 'requirementsSummary';
export const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;

/**
 * One structured-output call for the requirementsSummary capability. `resolveRuntime` is
 * the shared requirements runtime (throws ai_not_configured without a key). A call that
 * runs past `timeoutMs` is aborted and counts as a failed run.
 */
export async function summarizeWithOpenAi({ modelInput, resolveRuntime, tenantId, timeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS }) {
  const runtime = await resolveRuntime(tenantId, REQUIREMENTS_SUMMARY_CAPABILITY);
  const output = await parseStructuredResponse({
    abortSignal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null,
    client: runtime.client,
    input: [{
      content: [{ text: serializeSummaryModelInput(modelInput), type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions: requirementsSummaryInstructions,
    maxOutputTokens: 6000,
    model: runtime.settings.model,
    operationName: REQUIREMENTS_SUMMARY_OPERATION,
    reasoningEffort: runtime.settings.reasoningEffort,
    schema: summaryOutputSchema,
    schemaName: REQUIREMENTS_SUMMARY_SCHEMA_NAME,
  });
  return { model: runtime.settings.model, output };
}
