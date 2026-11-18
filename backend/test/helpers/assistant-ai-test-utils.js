export function createFixtureNanoTurnIntentClassification(options = {}) {
  if (!options || Array.isArray(options) || typeof options !== 'object') {
    throw new TypeError('Mocked nano intent must be supplied explicitly as structured output, never inferred from message text.');
  }
  const {
    intentClass = 'broad_mutation',
    requiresPlanEvaluation = intentClass === 'broad_mutation',
    signals = {},
    summary = 'Explicit mocked nano output for runtime tests.',
    targetScope = '',
  } = options;
  return {
    intentClass,
    rationale: 'Explicit mocked gpt-5.4-nano output; no message text was classified by test code.',
    requiresPlanEvaluation,
    signals: {
      projectMutationAllowed: ['targeted_mutation', 'broad_mutation'].includes(intentClass),
      requestedStoryCount: 1,
      requiresExternalResearch: false,
      ...signals,
    },
    summary,
    targetScope,
    titleSuggestion: '',
  };
}

export function createAssistantResponsesClient({
  compactRequests = [],
  compactResponses = [],
  controllerResponses = [],
  countRequests = [],
  createRequests = [],
  inputTokenCounts = [],
  structuredResponses = [],
  streamResponses = [],
  turnIntentClassification = null,
} = {}) {
  let controllerIndex = 0;
  let compactIndex = 0;
  let countIndex = 0;
  let structuredIndex = 0;
  let streamIndex = 0;

  function parseStructuredPayload(step = null) {
    if (!step?.output_text) {
      return null;
    }
    try {
      return JSON.parse(String(step.output_text ?? '{}'));
    } catch {
      return null;
    }
  }

  function isPlanEvaluationIntentRequest(request = {}) {
    return JSON.stringify(request?.text?.format ?? {}).includes('assistant_plan_evaluation_intent');
  }

  function isTurnIntentClassificationRequest(request = {}) {
    return JSON.stringify(request?.text?.format ?? {}).includes('assistant_turn_intent_classification');
  }

  function buildFixtureNanoTurnIntentResponse(request = {}) {
    let latestUserMessage = '';
    try {
      const payload = JSON.parse(String(request?.input?.at(-1)?.content?.[0]?.text ?? '{}'));
      latestUserMessage = String(payload?.latestUserMessage ?? '').trim();
    } catch {
      latestUserMessage = '';
    }
    if (turnIntentClassification) {
      const classification = typeof turnIntentClassification === 'function'
        ? turnIntentClassification({ latestUserMessage, request })
        : turnIntentClassification;
      return createStructuredResponse(classification, { id: 'structured-fixture-nano-turn-intent' });
    }

    return createStructuredResponse(
      createFixtureNanoTurnIntentClassification(),
      { id: 'structured-fixture-nano-turn-intent' },
    );
  }

  function buildAutoPlanEvaluationIntentResponse(request = {}) {
    let userPromptHistory = [];
    try {
      const payload = JSON.parse(String(request?.input?.at(-1)?.content?.[0]?.text ?? '{}'));
      userPromptHistory = Array.isArray(payload?.userPromptHistory) ? payload.userPromptHistory : [];
    } catch {
      userPromptHistory = [];
    }
    const combined = userPromptHistory
      .map((message) => String(message?.content ?? '').trim())
      .filter(Boolean)
      .join(' ');
    let completionPath = 'stories_required';
    if (
      /\bclarifications?\s+only\b/i.test(combined)
      || /\bwithout stories\b/i.test(combined)
      || /\bno stories\b/i.test(combined)
    ) {
      completionPath = 'clarifications_only';
    } else if (
      /\bstories later\b/i.test(combined)
      || /\bclarifications?\s+first\b/i.test(combined)
      || /\bepics?\s+and\s+clarifications?\b/i.test(combined)
    ) {
      completionPath = 'stories_or_clarifications';
    }

    return createStructuredResponse({
      completionPath,
      constraints: [],
      summary: combined || 'The user wants the current draft evaluated for writable-state readiness.',
      writableStateTarget: 'A coherent project plan that is ready for the next concrete implementation step.',
    }, {
      id: 'structured-auto-plan-evaluation-intent',
    });
  }

  function buildDefaultPlanEvaluationNextAction(payload = {}) {
    const firstCritical = Array.isArray(payload?.criticals) ? payload.criticals[0] : null;
    if (!firstCritical) {
      return {
        instruction: 'Finalize the draft because the current plan is writable as-is.',
        kind: 'finalize',
        targetIds: [],
      };
    }

    const linkedSection = String(firstCritical?.linkedSection ?? 'plan').trim().toLowerCase();
    return {
      instruction: String(firstCritical?.remediation ?? '').trim() || String(firstCritical?.message ?? '').trim() || 'Resolve the highest-leverage blocking issue.',
      kind: linkedSection === 'brief'
        ? 'brief'
        : linkedSection === 'clarifications'
          ? 'clarifications'
          : 'structure',
      targetIds: Array.isArray(firstCritical?.targetIds) ? firstCritical.targetIds : [],
    };
  }

  function normalizePlanEvaluationResponse(step = null) {
    const payload = parseStructuredPayload(step);
    if (!payload || payload.nextAction || !Array.isArray(payload.criticals) || !Array.isArray(payload.warnings)) {
      return step;
    }
    return createStructuredResponse({
      ...payload,
      nextAction: buildDefaultPlanEvaluationNextAction(payload),
    }, {
      id: step?.id ?? `structured-plan-evaluation-${Math.random().toString(16).slice(2)}`,
    });
  }

  return {
    responses: {
      async create(request = {}) {
        if (request?.stream) {
          createRequests.push(request);
          const streamStep = streamResponses[streamIndex++] ?? [];
          if (streamStep?.error) {
            throw streamStep.error;
          }
          const streamEvents = Array.isArray(streamStep) ? streamStep : [];
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of streamEvents) {
                yield event;
              }
            },
          };
        }

        if (request?.text?.format) {
          if (isTurnIntentClassificationRequest(request)) {
            return buildFixtureNanoTurnIntentResponse(request);
          }
          createRequests.push(request);
          if (isPlanEvaluationIntentRequest(request)) {
            const nextStructuredStep = structuredResponses[structuredIndex];
            const nextPayload = parseStructuredPayload(nextStructuredStep);
            if (nextPayload?.completionPath && nextPayload?.summary) {
              structuredIndex += 1;
              return nextStructuredStep;
            }
            return buildAutoPlanEvaluationIntentResponse(request);
          }
          const step = normalizePlanEvaluationResponse(structuredResponses[structuredIndex++]);
          if (!step) {
            throw new Error('Unexpected structured assistant create call.');
          }
          if (step.error) {
            throw step.error;
          }
          return step;
        }
        createRequests.push(request);
        const step = controllerResponses[controllerIndex++];
        if (!step) {
          const rawPayloadText = String(request?.input?.at(-1)?.content?.[0]?.text ?? '');
          let payloadText = `${rawPayloadText.slice(0, 1000)}\n...\n${rawPayloadText.slice(-1000)}`;
          try {
            const parsedPayload = JSON.parse(rawPayloadText);
            payloadText = JSON.stringify({
              currentDeficits: parsedPayload.currentDeficits,
              latestToolOutputs: parsedPayload.latestToolOutputs,
              planEvaluationState: parsedPayload.planEvaluationState,
              planSummary: parsedPayload.planSummary,
            }, null, 2);
          } catch {
            // Keep the raw preview when the payload is not JSON.
          }
          throw new Error(`Unexpected assistant create call at controller index ${controllerIndex - 1}: ${payloadText}`);
        }
        if (step.error) {
          throw step.error;
        }
        return step;
      },
      async compact(request = {}) {
        compactRequests.push(request);
        const step = compactResponses[compactIndex++];
        if (!step) {
          throw new Error('Unexpected assistant compact call.');
        }
        if (step.error) {
          throw step.error;
        }
        return step;
      },
      inputTokens: {
        async count(request = {}) {
          countRequests.push(request);
          const step = inputTokenCounts[countIndex++];
          if (step == null) {
            return {
              input_tokens: 0,
              object: 'response.input_tokens',
            };
          }
          if (step?.error) {
            throw step.error;
          }
          if (typeof step === 'number') {
            return {
              input_tokens: step,
              object: 'response.input_tokens',
            };
          }
          return step;
        },
      },
    },
  };
}

function clientWithExplicitNanoIntent(options, intentOptions) {
  return createAssistantResponsesClient({
    ...options,
    turnIntentClassification: options?.turnIntentClassification
      ?? createFixtureNanoTurnIntentClassification(intentOptions),
  });
}

export function createBroadMutationAssistantResponsesClient(options = {}) {
  return clientWithExplicitNanoIntent(options, { intentClass: 'broad_mutation' });
}

export function createTargetedMutationAssistantResponsesClient(options = {}) {
  return clientWithExplicitNanoIntent(options, { intentClass: 'targeted_mutation' });
}

export function createReadOnlyAssistantResponsesClient(options = {}) {
  return clientWithExplicitNanoIntent(options, {
    intentClass: 'read_only_data_gathering',
    requiresPlanEvaluation: false,
  });
}

export function createResearchAnswerAssistantResponsesClient(options = {}) {
  return clientWithExplicitNanoIntent(options, {
    intentClass: 'read_only_data_gathering',
    requiresPlanEvaluation: false,
    signals: { requiresExternalResearch: true },
  });
}

export function createResearchMutationAssistantResponsesClient(options = {}) {
  return clientWithExplicitNanoIntent(options, {
    intentClass: 'broad_mutation',
    signals: { requiresExternalResearch: true },
  });
}

export function createArtifactMutationAssistantResponsesClient(options = {}) {
  return clientWithExplicitNanoIntent(options, {
    intentClass: 'broad_mutation',
    signals: {
      requestedStoryCount: 2,
      requestsExistingProjectStorySliceFinalization: true,
      requestsStarterStructureEpic: true,
      requestsStarterStructureSlice: true,
    },
  });
}

export function createStructuredResponse(payload = {}, {
  id = `structured-${Math.random().toString(16).slice(2)}`,
} = {}) {
  const text = JSON.stringify(payload);
  return {
    id,
    output: [{
      content: [{
        text,
        type: 'output_text',
      }],
      role: 'assistant',
      type: 'message',
    }],
    output_text: text,
    status: 'completed',
  };
}

export function createCompletedAgentTask() {
  return {
    details: 'Inspect the request and keep the visible run plan aligned with draft changes.',
    key: 'inspect-and-plan',
    kind: 'analysis',
    status: 'completed',
    title: 'Inspect and plan',
  };
}

export function createControllerFunctionCall(name, {
  argumentsObject = {},
  callId = `${name}-call`,
} = {}) {
  return {
    arguments: JSON.stringify(argumentsObject),
    call_id: callId,
    name,
    status: 'completed',
    type: 'function_call',
  };
}

export function createControllerResponse(output = [], {
  id = `resp-${Math.random().toString(16).slice(2)}`,
  incompleteReason = null,
  outputText = '',
  status = null,
  usage = null,
} = {}) {
  return {
    id,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    output,
    output_text: outputText,
    status: status ?? (incompleteReason ? 'incomplete' : 'completed'),
    usage,
  };
}

export function createWebSearchCall({
  id = `wsc-${Math.random().toString(16).slice(2)}`,
  query = '',
  results = [],
  status = 'completed',
} = {}) {
  return {
    action: {
      queries: [query],
      query,
      sources: results.map((result) => ({ url: result.url ?? '' })),
    },
    id,
    results,
    status,
    type: 'web_search_call',
  };
}

export async function resolvePublicTestHostname() {
  return [{ address: '93.184.216.34', family: 4 }];
}

export function createRichEpicDescription({
  businessOutcome = 'Improve coordination and reduce delivery ambiguity.',
  dependencies = 'Stakeholder decisions and rollout constraints may affect sequencing.',
  name = 'Launch readiness',
  outOfScope = 'Post-launch support operations are not included.',
  scope = 'Approval ownership, sequencing, and rollout checkpoints are included.',
  successCriteria = 'Ownership is documented and delivery can proceed without approval confusion.',
  users = 'Program managers, delivery leads, approvers, and launch stakeholders are impacted.',
} = {}) {
  return `## Summary
What are we trying to accomplish?
Define ${name} so the workstream has clear boundaries, ownership, and delivery intent.

## Business Outcome
Why does this matter?
${businessOutcome}

## Users / Stakeholders
Who benefits or is impacted?
${users}

## Scope
What is included?
${scope}

## Out of Scope
What are we intentionally not doing?
${outOfScope}

## Success Criteria
How will we know this epic worked?
${successCriteria}

## Dependencies / Risks
What could block or shape the work?
${dependencies}`;
}

export function createRichStoryDescription({
  capability = 'configure product bundles and eligibility rules',
  context = 'The sales flow depends on a concrete story so engineering, UX, and delivery can align on expected behavior.',
  dependencies = 'Catalog data, eligibility rules, and pricing approvals must be available first.',
  outOfScope = 'Downstream fulfillment and billing reconciliation are handled separately.',
  outcome = 'sales staff can assemble a valid cart without manual workaround',
  technicalNotes = 'Track the selected bundle, serviceability checks, and pricing inputs across the cart session.',
  userType = 'sales representative',
  uxNotes = 'Show invalid bundle combinations inline and explain why a selection is unavailable.',
} = {}) {
  return `## User Story
As a ${userType},
I want to ${capability},
so that ${outcome}.

## Context
${context}

## Acceptance Criteria
- Given an eligible customer context, when I add a supported bundle, then the cart accepts the bundle and records the required product data.
- Given an incompatible combination, when I attempt to add it, then the cart blocks the change and explains the rule that failed.

## Business Rules
Bundle compatibility, eligibility, and pricing approvals must be enforced consistently before checkout.

## UX / Content Notes
${uxNotes}

## Technical Notes
${technicalNotes}

## Dependencies
${dependencies}

## Out of Scope
${outOfScope}`;
}

export function createBoldLabelStoryDescription({
  capability = 'configure plan bundles and financing rules',
  context = 'The delivery team needs a concrete story with explicit behavior, constraints, and handoffs.',
  dependencies = 'Catalog, pricing, and eligibility services must be ready first.',
  outOfScope = 'Provisioning execution and downstream billing are handled separately.',
  outcome = 'sales staff can build a valid cart without manual workarounds',
  technicalNotes = 'Persist bundle selections, financing flags, and serviceability results in the cart session.',
  userType = 'sales representative',
  uxNotes = 'Explain invalid selections inline and preserve the cart state after corrections.',
} = {}) {
  return `**User Story**
As a ${userType},
I want to ${capability},
so that ${outcome}.

**Context**
${context}

**Acceptance Criteria**
- Given an eligible customer, when I add a supported plan bundle, then the cart accepts it and stores the required product data.
- Given an unsupported combination, when I add it, then the cart blocks the change and explains the failed rule.

**Business Rules**
Eligibility, pricing, and financing rules must be enforced before checkout.

**UX / Content Notes**
${uxNotes}

**Technical Notes**
${technicalNotes}

**Dependencies**
${dependencies}

**Out of Scope**
${outOfScope}`;
}

export function createBoldLabelEpicDescription({
  businessOutcome = 'Reduce ambiguity and make the delivery boundary actionable.',
  dependencies = 'Pricing approvals and serviceability rules still influence sequencing.',
  name = 'Launch readiness',
  outOfScope = 'Post-launch support operations are outside this planning slice.',
  scope = 'Ownership, sequencing, and delivery boundaries are included.',
  successCriteria = 'The epic can be decomposed into implementable sprint stories without rework.',
  users = 'Program managers, product owners, and implementation teams depend on this boundary.',
} = {}) {
  return `**Summary**
What are we trying to accomplish?
Define ${name} so the workstream has clear boundaries, ownership, and delivery intent.

**Business Outcome**
Why does this matter?
${businessOutcome}

**Users / Stakeholders**
Who benefits or is impacted?
${users}

**Scope**
What is included?
${scope}

**Out of Scope**
What are we intentionally not doing?
${outOfScope}

**Success Criteria**
How will we know this epic worked?
${successCriteria}

**Dependencies / Risks**
What could block or shape the work?
${dependencies}`;
}
