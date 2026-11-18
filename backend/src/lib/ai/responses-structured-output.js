import { zodToJsonSchema } from 'zod-to-json-schema';

import { HttpError } from '../errors/http-error.js';
import { logBackendError } from '../logging/backend-logger.js';
import { withOptionalTemperature } from './openai-model-capabilities.js';

function modelSupportsReasoning(model = '') {
  return /^(gpt-([5-9]|\d{2,})|o\d)/i.test(String(model ?? '').trim());
}

function buildReasoning(reasoningEffort, model) {
  const effort = String(reasoningEffort ?? '').trim().toLowerCase();
  if (!effort || effort === 'none' || !modelSupportsReasoning(model)) {
    return undefined;
  }

  return { effort };
}

function normalizeIssuePath(path = []) {
  if (typeof path === 'string') {
    return path.trim() || '$';
  }

  if (!Array.isArray(path) || path.length === 0) {
    return '$';
  }

  return path
    .map((segment) => typeof segment === 'number' ? `[${segment}]` : String(segment ?? '').trim())
    .reduce((accumulator, segment) => {
      if (!segment) {
        return accumulator;
      }
      if (segment.startsWith('[')) {
        return `${accumulator}${segment}`;
      }
      return accumulator ? `${accumulator}.${segment}` : segment;
    }, '');
}

function normalizeIssues(issues = []) {
  return (issues ?? []).map((issue) => ({
    ...(issue ?? {}),
    path: normalizeIssuePath(issue?.path),
  }));
}

function normalizeErrorMessage(error) {
  return String(error?.message ?? '').trim() || 'Structured output parse failed.';
}

export function isPreviousResponseNotFoundError(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return message.includes('previous response')
    && message.includes('not found');
}

function truncateText(value, maxLength = 2400) {
  const text = String(value ?? '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function shouldRetryStructuredOutputParse(error) {
  if (!error) {
    return false;
  }

  if (error instanceof HttpError) {
    return false;
  }

  const message = normalizeErrorMessage(error).toLowerCase();
  return message.includes('parse')
    || message.includes('schema')
    || message.includes('json')
    || message.includes('structured')
    || message.includes('output');
}

function formatIssueForPrompt(issue = {}) {
  const path = normalizeIssuePath(issue.path);
  const parts = [`- ${path}: ${String(issue.message ?? 'Invalid value.').trim()}`];
  if (Array.isArray(issue.allowedValues) && issue.allowedValues.length > 0) {
    parts.push(`Allowed values: ${issue.allowedValues.join(', ')}`);
  }
  if (issue.expected != null) {
    parts.push(`Expected: ${String(issue.expected)}`);
  }
  if (issue.received != null && issue.received !== '') {
    parts.push(`Received: ${String(issue.received)}`);
  }
  return parts.join(' ');
}

function buildRepairPrompt({
  issues = [],
  operationName,
  parseErrorMessage = '',
  previousParsed = null,
  previousRawOutput = '',
}) {
  const lines = [
    `Your previous response for ${operationName} did not pass deterministic validation.`,
    'Return the full corrected response in the required schema only.',
    'Preserve valid content and change only the invalid sections unless broader edits are required for consistency.',
  ];

  if (parseErrorMessage) {
    lines.push(`Structured parse error: ${parseErrorMessage}`);
  }

  if (issues.length > 0) {
    lines.push('Invalid fields:');
    lines.push(...issues.map((issue) => formatIssueForPrompt(issue)));
  }

  if (previousRawOutput) {
    lines.push('');
    lines.push('Previous raw response:');
    lines.push(truncateText(previousRawOutput));
  }

  if (previousParsed != null) {
    lines.push('');
    lines.push('Previous parsed response:');
    lines.push(JSON.stringify(previousParsed, null, 2));
  }

  return lines.join('\n');
}

function buildAttemptInput(input, repairPrompt = '') {
  if (!repairPrompt) {
    return input;
  }

  return [
    ...(input ?? []),
    {
      content: [{
        text: repairPrompt,
        type: 'input_text',
      }],
      role: 'user',
      type: 'message',
    },
  ];
}

function buildRetryInput(repairPrompt = '') {
  if (!repairPrompt) {
    return [];
  }

  return [{
    content: [{
      text: repairPrompt,
      type: 'input_text',
    }],
    role: 'user',
    type: 'message',
  }];
}

function buildContinuationPrompt(operationName) {
  return [
    `Continue correcting your previous response for ${operationName}.`,
    'Return the complete final response in the required schema only.',
    'Do not restart with commentary or explanations.',
  ].join('\n');
}

function extractResponseOutputText(response = {}) {
  const outputText = String(response?.output_text ?? '').trim();
  if (outputText) {
    return outputText;
  }

  const parts = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== 'message') {
      continue;
    }
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('').trim();
}

function stripCodeFence(text = '') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractLikelyJson(text = '') {
  const cleaned = stripCodeFence(text);
  if (!cleaned) {
    return '';
  }

  if (
    (cleaned.startsWith('{') && cleaned.endsWith('}'))
    || (cleaned.startsWith('[') && cleaned.endsWith(']'))
  ) {
    return cleaned;
  }

  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');

  const candidates = [];
  if (objectStart !== -1 && objectEnd > objectStart) {
    candidates.push(cleaned.slice(objectStart, objectEnd + 1).trim());
  }
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    candidates.push(cleaned.slice(arrayStart, arrayEnd + 1).trim());
  }

  return candidates.sort((left, right) => right.length - left.length)[0] ?? '';
}

function collectStructuredOutputCandidates(rawText = '') {
  const candidates = [
    String(rawText ?? '').trim(),
    stripCodeFence(rawText),
    extractLikelyJson(rawText),
  ].filter(Boolean);

  return [...new Set(candidates)];
}

function serializeIssueValue(value) {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function issuesFromStructuredParseError(error) {
  const rawIssues = Array.isArray(error?.issues) ? error.issues : [];
  return normalizeIssues(rawIssues.map((issue) => ({
    allowedValues: Array.isArray(issue?.options)
      ? issue.options
      : Array.isArray(issue?.values)
        ? issue.values
        : undefined,
    expected: issue?.expected,
    message: String(issue?.message ?? 'Invalid value.').trim() || 'Invalid value.',
    path: issue?.path ?? ['$'],
    received: serializeIssueValue(issue?.received ?? issue?.input),
  })));
}

function parseStructuredOutputText({
  rawText = '',
  schema,
  textFormat,
}) {
  const candidates = collectStructuredOutputCandidates(rawText);
  let lastError = null;
  let lastIssues = [];

  for (const candidate of candidates) {
    try {
      if (typeof textFormat?.$parseRaw === 'function') {
        return {
          parsed: textFormat.$parseRaw(candidate),
        };
      }

      return {
        parsed: schema.parse(JSON.parse(candidate)),
      };
    } catch (error) {
      lastError = error;
      const issues = issuesFromStructuredParseError(error);
      if (issues.length > 0) {
        lastIssues = issues;
      }
    }
  }

  return {
    error: lastError ?? new Error('Structured output parse failed: response was empty.'),
    issues: lastIssues,
    parsed: null,
  };
}

function logStructuredOutputFailure({
  attemptNumber,
  error = null,
  issues = [],
  model,
  operationName,
  schemaName,
  stage,
}) {
  logBackendError({
    context: {
      attemptNumber,
      issueCount: (issues ?? []).length,
      issueSummaries: (issues ?? []).map((issue) => formatIssueForPrompt(issue)),
      model,
      operationName,
      schemaName,
      stage,
    },
    error: error ?? new Error(`Deterministic ${stage} validation failed.`),
    level: 'warn',
    message: 'AI structured output validation failed.',
  });
}

export class AiStructuredOutputValidationError extends HttpError {
  constructor({
    attemptCount = 0,
    issues = [],
    operationName = 'unknown',
  } = {}) {
    super(502, `AI output validation failed for ${operationName}.`, {
      details: {
        attemptCount,
        issues: normalizeIssues(issues),
        operation: operationName,
      },
    });

    this.name = 'AiStructuredOutputValidationError';
  }
}

// The strict Structured Outputs format for a zod schema. Built here rather than with the SDK's
// zodTextFormat, which since openai 7 rejects schemas that trim strings or have defaults; replies
// are still validated against the full zod schema below.
export function strictJsonSchemaFormat(schema, name) {
  return { name, schema: zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openAi' }), strict: true, type: 'json_schema' };
}

export async function generateValidatedStructuredOutput({
  abortSignal = null,
  client,
  fatalOnValidation = true,
  input,
  instructions,
  maxOutputTokens = 7000,
  maxRepairAttempts = 2,
  model,
  onRepairAttempt = null,
  operationName = 'unknown',
  reasoningEffort = 'max',
  schema,
  schemaName,
  temperature = 0.2,
  validator = null,
}) {
  const textFormat = strictJsonSchemaFormat(schema, schemaName);
  let repairPrompt = '';
  let attemptNumber = 0;
  let previousResponseId = null;

  while (attemptNumber <= maxRepairAttempts) {
    attemptNumber += 1;

    let parsed = null;
    let response = null;
    let rawResponseText = '';
    let continuationCount = 0;

    while (continuationCount <= 2) {
      try {
        response = await client.responses.create(
          withOptionalTemperature({
            input: previousResponseId
              ? buildRetryInput(repairPrompt || buildContinuationPrompt(operationName))
              : buildAttemptInput(input, repairPrompt),
            instructions,
            max_output_tokens: maxOutputTokens,
            model,
            reasoning: buildReasoning(reasoningEffort, model),
            text: {
              format: textFormat,
            },
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          }, {
            model,
            temperature,
          }),
          abortSignal ? { signal: abortSignal } : undefined,
        );
      } catch (error) {
        if (previousResponseId && isPreviousResponseNotFoundError(error)) {
          previousResponseId = null;
          continue;
        }

        if (!shouldRetryStructuredOutputParse(error)) {
          throw error;
        }

        const issues = normalizeIssues([{
          message: normalizeErrorMessage(error),
          path: '$',
        }]);
        logStructuredOutputFailure({
          attemptNumber,
          error,
          issues,
          model,
          operationName,
          schemaName,
          stage: 'schema',
        });

        if (attemptNumber > maxRepairAttempts) {
          if (!fatalOnValidation) {
            return {
              attemptCount: attemptNumber,
              issues,
              output: null,
              status: 'no_safe_output',
            };
          }
          throw new AiStructuredOutputValidationError({
            attemptCount: attemptNumber,
            issues,
            operationName,
          });
        }

        if (typeof onRepairAttempt === 'function') {
          await onRepairAttempt({
            attemptNumber,
            issues,
            operationName,
            stage: 'schema',
          });
        }

        repairPrompt = buildRepairPrompt({
          issues,
          operationName,
          parseErrorMessage: normalizeErrorMessage(error),
        });
        response = null;
        break;
      }

      previousResponseId = response?.id ?? previousResponseId;
      rawResponseText = extractResponseOutputText(response);

      if (
        response?.status === 'incomplete'
        && response?.incomplete_details?.reason === 'max_output_tokens'
      ) {
        continuationCount += 1;
        repairPrompt = buildContinuationPrompt(operationName);
        continue;
      }

      break;
    }

    if (!response) {
      continue;
    }

    const parseResult = parseStructuredOutputText({
      rawText: rawResponseText,
      schema,
      textFormat,
    });
    if (!parseResult?.parsed) {
      const issues = parseResult?.issues?.length > 0
        ? parseResult.issues
        : normalizeIssues([{
            message: normalizeErrorMessage(parseResult?.error),
            path: '$',
          }]);
      logStructuredOutputFailure({
        attemptNumber,
        error: parseResult?.error,
        issues,
        model,
        operationName,
        schemaName,
        stage: 'schema',
      });

      if (attemptNumber > maxRepairAttempts) {
        if (!fatalOnValidation) {
          return {
            attemptCount: attemptNumber,
            issues,
            output: null,
            status: 'no_safe_output',
          };
        }
        throw new AiStructuredOutputValidationError({
          attemptCount: attemptNumber,
          issues,
          operationName,
        });
      }

      if (typeof onRepairAttempt === 'function') {
        await onRepairAttempt({
          attemptNumber,
          issues,
          operationName,
          stage: 'schema',
        });
      }

      repairPrompt = buildRepairPrompt({
        issues,
        operationName,
        parseErrorMessage: normalizeErrorMessage(parseResult?.error),
        previousRawOutput: rawResponseText,
      });
      continue;
    }

    parsed = parseResult.parsed;

    const issues = normalizeIssues(await validator?.(parsed) ?? []);
    if (issues.length === 0) {
      if (fatalOnValidation) {
        return parsed;
      }

      return {
        attemptCount: attemptNumber,
        issues: [],
        output: parsed,
        status: 'success',
      };
    }

    logStructuredOutputFailure({
      attemptNumber,
      issues,
      model,
      operationName,
      schemaName,
      stage: 'semantic',
    });

    if (attemptNumber > maxRepairAttempts) {
      if (!fatalOnValidation) {
        return {
          attemptCount: attemptNumber,
          issues,
          output: parsed,
          status: 'degraded_success',
        };
      }
      throw new AiStructuredOutputValidationError({
        attemptCount: attemptNumber,
        issues,
        operationName,
      });
    }

    if (typeof onRepairAttempt === 'function') {
      await onRepairAttempt({
        attemptNumber,
        issues,
        operationName,
        stage: 'semantic',
      });
    }

    repairPrompt = buildRepairPrompt({
      issues,
      operationName,
      previousParsed: parsed,
      previousRawOutput: rawResponseText,
    });
  }

  if (!fatalOnValidation) {
    return {
      attemptCount: maxRepairAttempts + 1,
      issues: [{
        message: 'Structured output validation exhausted all repair attempts.',
        path: '$',
      }],
      output: null,
      status: 'no_safe_output',
    };
  }

  throw new AiStructuredOutputValidationError({
    attemptCount: maxRepairAttempts + 1,
    issues: [{
      message: 'Structured output validation exhausted all repair attempts.',
      path: '$',
    }],
    operationName,
  });
}
