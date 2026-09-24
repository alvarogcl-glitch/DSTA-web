import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;

const JOB_PREFIX = 'dsta-ai-job-v1:';
const QUEUE_KEY = 'dsta-ai-chat-queue-v1';
const BUSY_KEY = 'dsta-ai-chat-busy-v1';
const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;

function environment(entries = []) {
  const values = new Map(entries);
  return {
    DASHBOARD_USER: 'admin',
    DASHBOARD_PASSWORD: 'password',
    INGEST_TOKEN: 'ingest',
    DSTA_BRIDGE_TOKEN: 'bridge',
    DASHBOARD_DATA: {
      async get(key) { return values.get(key) ?? null; },
      async put(key, value) { values.set(key, JSON.parse(value)); },
      async delete(key) { values.delete(key); },
    },
    values,
  };
}

async function submit(env, message = 'hola') {
  const request = new Request('https://example.com/api/assistant', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json() };
}

const oldId = 'd2228b81-07db-4c0e-9ff5-4c8d60e9bdf7';
const completed = { id: oldId, kind: 'chat', status: 'completed', message: 'hola' };
const stale = environment([[BUSY_KEY, oldId], [JOB_PREFIX + oldId, completed]]);
const next = await submit(stale);
assert.equal(next.status, 202, 'a stale busy key must not block a new request');
assert.notEqual(next.body.id, oldId);

const queued = { id: oldId, kind: 'chat', status: 'queued', message: 'hola', task: null };
const duplicate = environment([[QUEUE_KEY, queued], [JOB_PREFIX + oldId, queued]]);
const resumed = await submit(duplicate);
assert.equal(resumed.status, 202);
assert.equal(resumed.body.id, oldId, 'a duplicate submission must resume its original job');

const other = await submit(duplicate, 'otra consulta');
assert.equal(other.status, 429, 'a distinct request still waits for the active job');

console.log('assistant worker queue checks passed');
