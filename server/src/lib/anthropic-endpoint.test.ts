import assert from 'node:assert/strict';
import test from 'node:test';
import { anthropicMessagesUrl } from './anthropic-endpoint.js';

const cases = [
  ['https://api.example.com', 'https://api.example.com/v1/messages'],
  ['https://api.example.com/', 'https://api.example.com/v1/messages'],
  ['  https://api.example.com  ', 'https://api.example.com/v1/messages'],
  ['https://api.example.com/v1', 'https://api.example.com/v1/messages'],
  ['https://api.example.com/v1/', 'https://api.example.com/v1/messages'],
  ['https://api.example.com/v1///', 'https://api.example.com/v1/messages'],
  ['https://gateway.example.com/anthropic', 'https://gateway.example.com/anthropic/v1/messages'],
] as const;

for (const [endpoint, expected] of cases) {
  test(`builds the messages URL from ${endpoint}`, () => {
    assert.equal(anthropicMessagesUrl(endpoint), expected);
  });
}
