import { parseStructuredResponse } from '../../../lib/ai/assistant-openai-runtime.js';
import { planDraftOutputSchema, workBreakdownOutputSchema } from './plan-content.js';
import {
  REQUIREMENTS_PLAN_CAPABILITY,
  REQUIREMENTS_PLAN_DRAFT_OPERATION,
  REQUIREMENTS_PLAN_DRAFT_SCHEMA_NAME,
  REQUIREMENTS_PLAN_WORK_OPERATION,
  REQUIREMENTS_PLAN_WORK_SCHEMA_NAME,
  requirementsPlanDraftInstructions,
  requirementsPlanWorkInstructions,
  serializePlanModelInput,
} from './plan-prompt.js';

// The track plan's OpenAI calls, both under the requirementsPlan capability. Provider
// selection, the production guard for the local fixture, and tenant key and model
// resolution live in ../ai/requirements-ai-service.js (draftPlan() and proposeWork()).

export const DEFAULT_PLAN_TIMEOUT_MS = 120_000;

async function callStructured({ instructions, maxOutputTokens, modelInput, operationName, resolveRuntime, schema, schemaName, tenantId, timeoutMs }) {
  const runtime = await resolveRuntime(tenantId, REQUIREMENTS_PLAN_CAPABILITY);
  const output = await parseStructuredResponse({
    abortSignal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null,
    client: runtime.client,
    input: [{
      content: [{ text: serializePlanModelInput(modelInput), type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions,
    maxOutputTokens,
    model: runtime.settings.model,
    operationName,
    reasoningEffort: runtime.settings.reasoningEffort,
    schema,
    schemaName,
  });
  return { model: runtime.settings.model, output };
}

export function draftPlanWithOpenAi({ modelInput, resolveRuntime, tenantId, timeoutMs = DEFAULT_PLAN_TIMEOUT_MS }) {
  return callStructured({
    instructions: requirementsPlanDraftInstructions,
    maxOutputTokens: 8000,
    modelInput,
    operationName: REQUIREMENTS_PLAN_DRAFT_OPERATION,
    resolveRuntime,
    schema: planDraftOutputSchema,
    schemaName: REQUIREMENTS_PLAN_DRAFT_SCHEMA_NAME,
    tenantId,
    timeoutMs,
  });
}

export function proposeWorkWithOpenAi({ modelInput, resolveRuntime, tenantId, timeoutMs = DEFAULT_PLAN_TIMEOUT_MS }) {
  return callStructured({
    instructions: requirementsPlanWorkInstructions,
    maxOutputTokens: 8000,
    modelInput,
    operationName: REQUIREMENTS_PLAN_WORK_OPERATION,
    resolveRuntime,
    schema: workBreakdownOutputSchema,
    schemaName: REQUIREMENTS_PLAN_WORK_SCHEMA_NAME,
    tenantId,
    timeoutMs,
  });
}
