import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReasoning,
  createFunctionCallOutput,
  extractControllerText,
  normalizeRuntimeError,
} from '../src/lib/ai/assistant-openai-runtime.js';
import { HttpError } from '../src/lib/errors/http-error.js';

test('assistant OpenAI runtime builds reasoning only for reasoning-capable models', () => {
  assert.deepEqual(buildReasoning('medium', 'gpt-5.6-luna'), { effort: 'medium' });
  assert.deepEqual(buildReasoning('HIGH', 'o4-mini'), { effort: 'high' });
  assert.deepEqual(buildReasoning('max', 'gpt-6-luna'), { effort: 'max' });
  assert.deepEqual(buildReasoning('medium', 'gpt-6.1-sol'), { effort: 'medium' });
  assert.equal(buildReasoning('medium', 'gpt-4.1-mini'), undefined);
  assert.equal(buildReasoning('none', 'gpt-5.6-luna'), undefined);
});

test('assistant OpenAI runtime formats function call outputs', () => {
  assert.deepEqual(createFunctionCallOutput(' call-1 ', { ok: true }), {
    call_id: 'call-1',
    output: '{"ok":true}',
    type: 'function_call_output',
  });
});

test('assistant OpenAI runtime extracts controller text from response shapes', () => {
  assert.equal(extractControllerText({ output_text: ' direct answer ' }), 'direct answer');
  assert.equal(extractControllerText({
    output: [{
      content: [
        { text: 'first', type: 'output_text' },
        { text: 'ignored', type: 'input_text' },
      ],
      type: 'message',
    }, {
      content: [{ text: ' second ', type: 'output_text' }],
      type: 'message',
    }],
  }), 'first\nsecond');
});

test('assistant OpenAI runtime preserves HttpError and wraps generic failures', () => {
  const httpError = new HttpError(503, 'Not configured.');
  assert.equal(normalizeRuntimeError(httpError), httpError);

  const wrapped = normalizeRuntimeError(new Error('provider failed'));
  assert.equal(wrapped.statusCode, 502);
  assert.equal(wrapped.message, 'Assistant AI request failed: provider failed');
});
