import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelSupportsTemperature,
  withOptionalTemperature,
} from '../src/lib/ai/openai-model-capabilities.js';

test('modelSupportsTemperature disables temperature for GPT-5 family models', () => {
  assert.equal(modelSupportsTemperature('gpt-5.5'), false);
  assert.equal(modelSupportsTemperature('gpt-5'), false);
  assert.equal(modelSupportsTemperature('gpt-5.6-luna'), false);
});

test('modelSupportsTemperature disables temperature for GPT-6 family models', () => {
  assert.equal(modelSupportsTemperature('gpt-6.1-sol'), false);
  assert.equal(modelSupportsTemperature('gpt-6-luna'), false);
});

test('modelSupportsTemperature keeps temperature for older chat models', () => {
  assert.equal(modelSupportsTemperature('gpt-4o-mini'), true);
  assert.equal(modelSupportsTemperature('gpt-4.1'), true);
  assert.equal(modelSupportsTemperature(''), true);
});

test('withOptionalTemperature omits temperature when the model does not support it', () => {
  assert.deepEqual(
    withOptionalTemperature(
      { model: 'gpt-5.5', store: false, temperature: 0.2 },
      { model: 'gpt-5.5', temperature: 0.2 },
    ),
    { model: 'gpt-5.5', store: false },
  );
});

test('withOptionalTemperature preserves temperature for compatible models', () => {
  assert.deepEqual(
    withOptionalTemperature(
      { model: 'gpt-4o-mini', store: false },
      { model: 'gpt-4o-mini', temperature: 0.2 },
    ),
    { model: 'gpt-4o-mini', store: false, temperature: 0.2 },
  );
});
