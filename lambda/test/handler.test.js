// Tests for lambda/index.js with Gemini (fetch) and DynamoDB mocked.
// Run: cd lambda && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// ---- mocks (set up before loading the handler) ----
const ddbCalls = [];
let storedSession = null;
DynamoDBDocumentClient.prototype.send = async function (cmd) {
    ddbCalls.push({ name: cmd.constructor.name, input: cmd.input });
    if (cmd.constructor.name === 'GetCommand') return { Item: storedSession };
    return {};
};

const geminiCalls = [];
let geminiQueue = [];
global.fetch = async (url, opts) => {
    geminiCalls.push({ url, opts, body: JSON.parse(opts.body) });
    const next = geminiQueue.shift();
    if (!next) throw new Error('unexpected Gemini call');
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
};

const ok = (obj) => ({
    status: 200,
    body: {
        modelVersion: 'gemini-test',
        usageMetadata: { totalTokenCount: 10 },
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }]
    }
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.AWS_REGION = 'us-east-1';
// Keep test output readable
console.log = console.warn = console.error = () => {};

const { handler, _internals } = require('../index.js');

const ctx = { awsRequestId: 'req-test', getRemainingTimeInMillis: () => 29000 };
let ipCounter = 0;
const ev = (body, ip) => ({
    httpMethod: 'POST',
    headers: { origin: 'https://fabianimv.github.io' },
    requestContext: { identity: { sourceIp: ip || `10.0.0.${++ipCounter}` } },
    body: JSON.stringify(body)
});
const call = async (event) => {
    const r = await handler(event, ctx);
    return { status: r.statusCode, headers: r.headers, ...JSON.parse(r.body || '{}') };
};

test.beforeEach(() => {
    geminiQueue = [];
    storedSession = null;
    ddbCalls.length = 0;
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const r = await handler({ httpMethod: 'OPTIONS', headers: {} }, ctx);
    assert.strictEqual(r.statusCode, 204);
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], '*');
});

test('name gate: unknown name -> asks for it; request shape is correct', async () => {
    geminiQueue.push(ok({ reply: '¿Cómo te llamas?', visitorName: null, nameDeclined: false, language: 'es' }));
    const r = await call(ev({ message: '¿Qué experiencia tiene con Kafka?', sessionId: 'abc12345-session', lang: 'es' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.awaitingName, true);

    const c = geminiCalls.at(-1);
    assert.ok(!c.url.includes('key='), 'API key must not be in the URL');
    assert.strictEqual(c.opts.headers['x-goog-api-key'], 'test-key');
    assert.match(c.url, /\/models\/gemini-flash-latest:generateContent$/);
    assert.match(c.body.systemInstruction.parts[0].text, /NAME GATE/);
    assert.strictEqual(c.body.generationConfig.responseMimeType, 'application/json');
    assert.deepStrictEqual(c.body.contents, [{ role: 'user', parts: [{ text: '¿Qué experiencia tiene con Kafka?' }] }]);
});

test('name given with history -> learned and stored in the sessions table', async () => {
    geminiQueue.push(ok({ reply: 'Mucho gusto, Ana.', visitorName: 'Ana', nameDeclined: false, language: 'es' }));
    const r = await call(ev({
        message: 'Ana', sessionId: 'abc12345-session', lang: 'es',
        history: [
            { role: 'assistant', text: 'saludo' },
            { role: 'user', text: '¿Qué experiencia tiene con Kafka?' },
            { role: 'assistant', text: '¿Cómo te llamas?' }
        ]
    }));
    assert.strictEqual(r.visitorName, 'Ana');
    assert.strictEqual(r.awaitingName, false);
    assert.deepStrictEqual(geminiCalls.at(-1).body.contents.map((x) => x.role), ['user', 'model', 'user']);
    const upd = ddbCalls.find((d) => d.name === 'UpdateCommand');
    assert.strictEqual(upd.input.ExpressionAttributeValues[':name'], 'Ana');
    assert.strictEqual(upd.input.Key.sessionId, 'abc12345-session');
});

test('known name drops the gate and markdown is stripped', async () => {
    geminiQueue.push(ok({ reply: '**Sí**, tiene [AWS](https://aws.amazon.com).\n* Cloud Practitioner', visitorName: 'Ana', nameDeclined: false, language: 'es' }));
    const r = await call(ev({ message: '¿Certificaciones?', sessionId: 'abc12345-session', visitorName: 'Ana' }));
    assert.doesNotMatch(geminiCalls.at(-1).body.systemInstruction.parts[0].text, /NAME GATE/);
    assert.strictEqual(r.message, 'Sí, tiene AWS: https://aws.amazon.com.\n- Cloud Practitioner');
});

test('name is read from DynamoDB when the browser does not send it', async () => {
    storedSession = { sessionId: 'abc12345-session', visitorName: 'Ana' };
    geminiQueue.push(ok({ reply: 'Claro, Ana.', visitorName: 'Ana', nameDeclined: false, language: 'es' }));
    const r = await call(ev({ message: 'y proyectos?', sessionId: 'abc12345-session' }));
    assert.strictEqual(r.visitorName, 'Ana');
});

test('declining to give a name opens the gate', async () => {
    geminiQueue.push(ok({ reply: 'Sin problema.', visitorName: null, nameDeclined: true, language: 'es' }));
    const r = await call(ev({ message: 'prefiero no decirlo', sessionId: 'other1234' }));
    assert.strictEqual(r.nameDeclined, true);
    assert.strictEqual(r.awaitingName, false);
});

test('replies in the visitor language, not only es/en', async () => {
    geminiQueue.push(ok({ reply: 'Olá!', visitorName: 'Leo', nameDeclined: false, language: 'PT' }));
    const r = await call(ev({ message: 'Ele trabalha com Kafka?', visitorName: 'Leo', lang: 'es' }));
    assert.strictEqual(r.language, 'pt');
});

test('sanitizeName rejects non-names', () => {
    assert.strictEqual(_internals.sanitizeName('Kubernetes 1.29'), null);
    assert.strictEqual(_internals.sanitizeName('<script>'), null);
    assert.strictEqual(_internals.sanitizeName('a b c d e'), null);
    assert.strictEqual(_internals.sanitizeName("María José O'Neil"), "María José O'Neil");
});

test('retries once on 503', async () => {
    geminiQueue.push({ status: 503, body: { error: { message: 'overloaded' } } }, ok({ reply: 'Hi!', visitorName: 'John', nameDeclined: false, language: 'en' }));
    const before = geminiCalls.length;
    const r = await call(ev({ message: "I'm John", sessionId: 'john12345', lang: 'en' }));
    assert.strictEqual(geminiCalls.length - before, 2);
    assert.strictEqual(r.status, 200);
});

test('does not retry on 400 and returns 502', async () => {
    geminiQueue.push({ status: 400, body: { error: { message: 'bad request' } } });
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'hola', sessionId: 'x12345678' }));
    assert.strictEqual(geminiCalls.length - before, 1);
    assert.strictEqual(r.status, 502);
});

test('non-JSON text is used as the reply; a safety block gives the fallback', async () => {
    geminiQueue.push({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'plain answer' }] } }] } });
    let r = await call(ev({ message: 'hola', visitorName: 'Leo' }));
    assert.strictEqual(r.message, 'plain answer');

    geminiQueue.push({ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } });
    r = await call(ev({ message: 'hola', visitorName: 'Leo', lang: 'en' }));
    assert.match(r.message, /linkedin\.com\/in\/fabianimv/);
});

test('thought parts are ignored', async () => {
    geminiQueue.push({ status: 200, body: { candidates: [{ content: { parts: [
        { text: 'thinking...', thought: true },
        { text: JSON.stringify({ reply: 'final', nameDeclined: false, language: 'en' }) }
    ] } }] } });
    const r = await call(ev({ message: 'q', visitorName: 'Leo' }));
    assert.strictEqual(r.message, 'final');
});

test('input validation', async () => {
    assert.strictEqual((await call(ev({ message: '' }))).status, 400);
    assert.strictEqual((await call(ev({ message: 'x'.repeat(501) }))).status, 400);
    assert.strictEqual((await call({ ...ev({}), body: '{bad' })).status, 400);
    const r = await handler({ httpMethod: 'GET', headers: {} }, ctx);
    assert.strictEqual(r.statusCode, 405);
});

test('invalid sessionId falls back to a hashed IP', async () => {
    geminiQueue.push(ok({ reply: 'hi', nameDeclined: false, language: 'en' }));
    await call(ev({ message: 'hi', sessionId: '../../etc', visitorName: 'Leo' }));
    const put = ddbCalls.find((d) => d.name === 'PutCommand');
    assert.match(put.input.Item.sessionId, /^ip-[0-9a-f]{16}$/);
});

test('rate limit per IP', async () => {
    let last;
    for (let i = 0; i < 16; i++) {
        geminiQueue.push(ok({ reply: 'hi', nameDeclined: false, language: 'en' }));
        last = await call(ev({ message: 'hi', visitorName: 'Leo' }, '6.6.6.6'));
    }
    assert.strictEqual(last.status, 429);
    assert.ok(last.message);
});

test('HTTP API (v2) event with base64 body', async () => {
    geminiQueue.push(ok({ reply: 'v2 ok', nameDeclined: false, language: 'en' }));
    const r = await handler({
        requestContext: { http: { method: 'POST', sourceIp: '4.4.4.4' } },
        headers: {},
        isBase64Encoded: true,
        body: Buffer.from(JSON.stringify({ message: 'hi', visitorName: 'Leo' })).toString('base64')
    }, ctx);
    assert.strictEqual(JSON.parse(r.body).message, 'v2 ok');
});

test('missing API key returns 500 without calling Gemini', async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        const before = geminiCalls.length;
        const r = await call(ev({ message: 'hola' }));
        assert.strictEqual(r.status, 500);
        assert.strictEqual(geminiCalls.length, before);
    } finally {
        process.env.GEMINI_API_KEY = key;
    }
});
