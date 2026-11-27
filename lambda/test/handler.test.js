// Tests for lambda/index.js with Gemini (fetch) and DynamoDB mocked.
// Run: cd lambda && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// ---- mocks (set up before loading the handler) ----
const ddbCalls = [];
let storedSession = null;
let queryResponse = () => ({ Items: [] });
DynamoDBDocumentClient.prototype.send = async function (cmd) {
    ddbCalls.push({ name: cmd.constructor.name, input: cmd.input });
    if (cmd.constructor.name === 'GetCommand') return { Item: storedSession };
    if (cmd.constructor.name === 'QueryCommand') return queryResponse(cmd.input);
    return {};
};

const geminiCalls = [];
const geoCalls = [];
let geminiQueue = [];
global.fetch = async (url, opts) => {
    if (url.startsWith('https://ipwho.is/')) {
        geoCalls.push(url);
        const body = url.includes('/0.0.0.0?')
            ? { success: false, message: 'Invalid IP address' }
            : { success: true, city: 'Santiago', region: 'Region Metropolitana', country: 'Chile', country_code: 'CL', connection: { org: 'Entel' } };
        return { ok: true, status: 200, json: async () => body };
    }
    geminiCalls.push({ url, opts, body: JSON.parse(opts.body) });
    const next = geminiQueue.shift();
    if (!next) throw new Error('unexpected Gemini call');
    if (next instanceof Error) throw next; // network failure / timeout, like real fetch
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
    _internals.modelCooldown.clear();
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
    assert.strictEqual(upd.input.TableName, 'portfolio-chatbot');
    assert.deepStrictEqual(upd.input.Key, { pk: 'SESSION#abc12345-session', sk: 'SESSION' });
    const names = Object.values(upd.input.ExpressionAttributeNames);
    const values = Object.values(upd.input.ExpressionAttributeValues);
    assert.ok(names.includes('visitorName') && values.includes('Ana'));
    assert.ok(names.includes('ip') && names.includes('lastSeenAt') && names.includes('messageCount'));
    assert.ok(values.includes('session'), 'session item is typed for the GSI');
});

test('message item: same session collection, ordered sort key, visitor data on the session', async () => {
    geminiQueue.push(ok({ reply: 'Claro.', visitorName: 'Ana', nameDeclined: false, language: 'es' }));
    await call({
        ...ev({
            message: '¿Proyectos?', sessionId: 'abc12345-session', visitorName: 'Ana',
            client: { timezone: 'America/Santiago', referrer: 'https://www.linkedin.com/in/someone/?trk=abc' }
        }, '200.1.2.3'),
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148' }
    });
    const put = ddbCalls.find((d) => d.name === 'PutCommand');
    assert.strictEqual(put.input.Item.pk, 'SESSION#abc12345-session');
    assert.match(put.input.Item.sk, /^MSG#\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}#[0-9a-f]{6}$/);
    assert.match(put.input.Item.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.strictEqual(put.input.Item.location, 'Santiago, Region Metropolitana, Chile');
    assert.strictEqual(put.input.Item.type, 'message');
    assert.strictEqual(put.input.Item.userMessage, '¿Proyectos?');
    assert.strictEqual(put.input.Item.botResponse, 'Claro.');
    assert.strictEqual(put.input.Item.ip, '200.1.2.3');
    assert.strictEqual(put.input.Item.tokens, 10);

    const upd = ddbCalls.find((d) => d.name === 'UpdateCommand');
    const map = {};
    for (const [alias, name] of Object.entries(upd.input.ExpressionAttributeNames)) {
        const v = alias.replace('#f', ':v');
        map[name] = upd.input.ExpressionAttributeValues[v];
    }
    assert.strictEqual(map.timezone, 'America/Santiago');
    assert.strictEqual(map.cameFrom, 'https://www.linkedin.com/in/someone/', 'query string stripped');
    assert.strictEqual(map.device, 'mobile');
    assert.strictEqual(map.ip, '200.1.2.3');
    assert.strictEqual(map.location, 'Santiago, Region Metropolitana, Chile');
    assert.strictEqual(map.country, 'CL');
    assert.strictEqual(map.network, 'Entel');
    assert.match(upd.input.UpdateExpression, /firstSeenAt\b|#f\d+ = if_not_exists\(#f\d+, :v\d+\)/);
});

test('geolocation: once per new chat, cached, skipped for private IPs and failures', async () => {
    geoCalls.length = 0;
    geminiQueue.push(ok({ reply: 'a', visitorName: 'Leo', nameDeclined: false, language: 'es' }));
    await call(ev({ message: 'hola', visitorName: 'Leo' }, '201.2.3.4'));
    assert.strictEqual(geoCalls.length, 1);

    // Same chat continues (history present): no lookup
    geminiQueue.push(ok({ reply: 'b', visitorName: 'Leo', nameDeclined: false, language: 'es' }));
    await call(ev({ message: 'y?', visitorName: 'Leo', history: [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'a' }] }, '201.2.3.4'));
    assert.strictEqual(geoCalls.length, 1);

    // New chat from the same IP: served from cache
    assert.deepStrictEqual(await _internals.lookupLocation('201.2.3.4'), { location: 'Santiago, Region Metropolitana, Chile', country: 'CL', network: 'Entel' });
    assert.strictEqual(geoCalls.length, 1);

    assert.strictEqual(await _internals.lookupLocation('192.168.1.10'), null);
    assert.strictEqual(await _internals.lookupLocation('0.0.0.0'), null);
});

test('shortNetwork keeps the company name only', () => {
    assert.strictEqual(_internals.shortNetwork('Bharti Airtel Limited, Plot Number 21 Rajiv Gandhi Technology Park, Chandigarh'), 'Bharti Airtel Limited');
    assert.strictEqual(_internals.shortNetwork('Microsoft Corporation'), 'Microsoft Corporation');
    assert.strictEqual(_internals.shortNetwork(undefined), undefined);
});

test('chileTime is readable and sortable', () => {
    assert.strictEqual(_internals.chileTime(new Date('2026-11-27T16:30:05Z')), '2026-11-27 13:30:05');
    assert.ok(_internals.chileTime(new Date('2026-01-01T00:00:00Z')) < _internals.chileTime(new Date('2026-01-02T00:00:00Z')));
});

test('clientInfo rejects junk', () => {
    const info = _internals.clientInfo({ client: { timezone: 'x; DROP TABLE', referrer: 'javascript:alert(1)' } }, { headers: {} });
    assert.strictEqual(info.timezone, undefined);
    assert.strictEqual(info.referrer, undefined);
    assert.strictEqual(info.device, undefined);
});

test('buildSet skips empty values and aliases every attribute name', () => {
    const s = _internals.buildSet({ type: { value: 'session' }, visitorName: { value: null }, n: { value: 1, mode: 'add' } });
    assert.strictEqual(s.UpdateExpression, 'SET #f0 = :v0, #f1 = if_not_exists(#f1, :z1) + :v1');
    assert.deepStrictEqual(s.ExpressionAttributeNames, { '#f0': 'type', '#f1': 'n' });
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
    assert.match(put.input.Item.pk, /^SESSION#ip-[0-9a-f]{16}$/);
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

// ---------------- Admin API ----------------
const admin = (body, ip = '9.9.9.1') => call(ev({ admin: body }, ip));

test('admin API is disabled (404) when ADMIN_TOKEN is not set', async () => {
    delete process.env.ADMIN_TOKEN;
    const r = await admin({ token: 'anything', action: 'visitors' });
    assert.strictEqual(r.status, 404);
    assert.ok(!ddbCalls.some((d) => d.name === 'QueryCommand'));
});

test('admin API rejects a wrong or missing token without reading the table', async () => {
    process.env.ADMIN_TOKEN = 'correct-horse-battery-staple';
    try {
        assert.strictEqual((await admin({ token: 'wrong', action: 'visitors' }, '9.9.9.2')).status, 401);
        assert.strictEqual((await admin({ action: 'visitors' }, '9.9.9.2')).status, 401);
        assert.strictEqual((await admin('just-a-string', '9.9.9.2')).status, 401);
        assert.ok(!ddbCalls.some((d) => d.name === 'QueryCommand'));
    } finally {
        delete process.env.ADMIN_TOKEN;
    }
});

test('admin visitors: newest first from the index, only whitelisted fields, cursor round-trip', async () => {
    process.env.ADMIN_TOKEN = 'secret-token';
    const lastKey = { pk: 'SESSION#abc', sk: 'SESSION', type: 'session', lastSeenAt: '2026-11-27 13:00:00' };
    queryResponse = () => ({
        Items: [{ pk: 'SESSION#abc', sk: 'SESSION', type: 'session', sessionId: 'abc', visitorName: 'Camila', ip: '190.1.1.1', location: 'Santiago, Chile', lastSeenAt: '2026-11-27 13:00:00', messageCount: 3, userAgent: 'secret UA' }],
        LastEvaluatedKey: lastKey
    });
    try {
        const r = await admin({ token: 'secret-token', action: 'visitors', limit: 5000 }, '9.9.9.3');
        assert.strictEqual(r.status, 200);
        const q = ddbCalls.find((d) => d.name === 'QueryCommand').input;
        assert.strictEqual(q.IndexName, 'sessions-by-last-seen');
        assert.strictEqual(q.ScanIndexForward, false);
        assert.strictEqual(q.Limit, 300, 'limit is capped');
        assert.deepStrictEqual(r.visitors[0], { sessionId: 'abc', visitorName: 'Camila', ip: '190.1.1.1', location: 'Santiago, Chile', lastSeenAt: '2026-11-27 13:00:00', messageCount: 3 });
        assert.ok(r.nextCursor);

        ddbCalls.length = 0;
        await admin({ token: 'secret-token', action: 'visitors', cursor: r.nextCursor }, '9.9.9.3');
        assert.deepStrictEqual(ddbCalls.find((d) => d.name === 'QueryCommand').input.ExclusiveStartKey, lastKey);

        ddbCalls.length = 0;
        await admin({ token: 'secret-token', action: 'visitors', cursor: Buffer.from('{"evil":1}').toString('base64url') }, '9.9.9.3');
        assert.strictEqual(ddbCalls.find((d) => d.name === 'QueryCommand').input.ExclusiveStartKey, undefined, 'bad cursor ignored');
    } finally {
        queryResponse = () => ({ Items: [] });
        delete process.env.ADMIN_TOKEN;
    }
});

test('admin conversation: session + messages in order; validates sessionId', async () => {
    process.env.ADMIN_TOKEN = 'secret-token';
    queryResponse = (input) => {
        assert.strictEqual(input.ExpressionAttributeValues[':pk'], 'SESSION#MTkwLjEuMi4z');
        return { Items: [
            { pk: 'SESSION#MTkwLjEuMi4z', sk: 'MSG#2026-11-27 13:00:00#aaa', type: 'message', createdAt: '2026-11-27 13:00:00', userMessage: 'hola', botResponse: '¿nombre?', requestId: 'x' },
            { pk: 'SESSION#MTkwLjEuMi4z', sk: 'MSG#2026-11-27 13:01:00#bbb', type: 'message', createdAt: '2026-11-27 13:01:00', userMessage: 'Camila', botResponse: 'Hola Camila' },
            { pk: 'SESSION#MTkwLjEuMi4z', sk: 'SESSION', type: 'session', sessionId: 'MTkwLjEuMi4z', visitorName: 'Camila' }
        ] };
    };
    try {
        const r = await admin({ token: 'secret-token', action: 'conversation', sessionId: 'MTkwLjEuMi4z' }, '9.9.9.4');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.session.visitorName, 'Camila');
        assert.deepStrictEqual(r.messages.map((m) => m.userMessage), ['hola', 'Camila']);
        assert.strictEqual(r.messages[0].requestId, undefined, 'internal fields not exposed');

        assert.strictEqual((await admin({ token: 'secret-token', action: 'conversation', sessionId: 'x"; DROP' }, '9.9.9.4')).status, 400);
        assert.strictEqual((await admin({ token: 'secret-token', action: 'nope' }, '9.9.9.4')).status, 400);
    } finally {
        queryResponse = () => ({ Items: [] });
        delete process.env.ADMIN_TOKEN;
    }
});

test('admin API is rate limited per IP', async () => {
    process.env.ADMIN_TOKEN = 'secret-token';
    try {
        let last;
        for (let i = 0; i < 31; i++) last = await admin({ token: 'secret-token', action: 'visitors' }, '9.9.9.5');
        assert.strictEqual(last.status, 429);
    } finally {
        delete process.env.ADMIN_TOKEN;
    }
});

// ---------------- Model fallback ----------------
const modelOf = (c) => c.url.match(/\/models\/([^:]+):generateContent$/)[1];

test('503 "high demand" on the main model -> fallback model answers and is stored', async () => {
    geminiQueue.push(
        { status: 503, body: { error: { message: 'This model is currently experiencing high demand.' } } },
        ok({ reply: 'Respuesta del respaldo', visitorName: 'Leo', nameDeclined: false, language: 'es' })
    );
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'hola', visitorName: 'Leo' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.message, 'Respuesta del respaldo');
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
    assert.strictEqual(ddbCalls.find((d) => d.name === 'PutCommand').input.Item.model, 'gemini-flash-lite-latest');
});

test('both models overloaded -> primary is tried again, then a friendly busy message (502)', async () => {
    const busy = { status: 503, body: { error: { message: 'high demand' } } };
    geminiQueue.push(busy, busy, busy);
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'hola', visitorName: 'Leo', lang: 'es' }));
    assert.strictEqual(r.status, 502);
    assert.match(r.message, /mucha demanda/);
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest']);
});

test('404 (model retired) drops that model and keeps using the other one', async () => {
    geminiQueue.push(
        { status: 503, body: { error: { message: 'high demand' } } },
        { status: 404, body: { error: { message: 'models/gemini-flash-lite-latest is not found' } } },
        ok({ reply: 'ok', visitorName: 'Leo', nameDeclined: false, language: 'en' })
    );
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'hi', visitorName: 'Leo' }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest']);
});

test('timeout on the main model -> fallback', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    geminiQueue.push(timeout, ok({ reply: 'ok', visitorName: 'Leo', nameDeclined: false, language: 'en' }));
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'hi', visitorName: 'Leo' }));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
});

// ---------------- Circuit breaker ----------------
test('after a 503 the main model cools down: next requests go straight to the fallback', async () => {
    geminiQueue.push(
        { status: 503, body: { error: { message: 'high demand' } } },
        ok({ reply: 'uno', visitorName: 'Leo', nameDeclined: false, language: 'es' })
    );
    await call(ev({ message: 'hola', visitorName: 'Leo' }));

    geminiQueue.push(ok({ reply: 'dos', visitorName: 'Leo', nameDeclined: false, language: 'es' }));
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'y?', visitorName: 'Leo' }));
    assert.strictEqual(r.message, 'dos');
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-lite-latest'], 'no wasted call to the overloaded model');
});

test('cooled-down main model is tried again once the cooldown expires', async () => {
    _internals.modelCooldown.set('gemini-flash-latest', Date.now() - 1);
    geminiQueue.push(ok({ reply: 'ok', visitorName: 'Leo', nameDeclined: false, language: 'es' }));
    const before = geminiCalls.length;
    await call(ev({ message: 'hola', visitorName: 'Leo' }));
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-latest']);
});

test('if the fallback fails while the main model is cooling down, the main model is still tried', async () => {
    _internals.modelCooldown.set('gemini-flash-latest', Date.now() + 60000);
    geminiQueue.push(
        { status: 503, body: { error: { message: 'high demand' } } },
        ok({ reply: 'principal', visitorName: 'Leo', nameDeclined: false, language: 'es' })
    );
    const before = geminiCalls.length;
    const r = await call(ev({ message: 'hola', visitorName: 'Leo' }));
    assert.strictEqual(r.message, 'principal');
    assert.deepStrictEqual(geminiCalls.slice(before).map(modelOf), ['gemini-flash-lite-latest', 'gemini-flash-latest']);
    assert.ok(!_internals.modelCooldown.has('gemini-flash-latest'), 'a success clears the cooldown');
});

test('language rule: ambiguous short replies keep the conversation language', () => {
    const p = _internals.buildSystemPrompt({ visitorName: 'Ana', nameDeclined: false, pageLang: 'en' });
    assert.match(p, /"no", "sí"\/"si", "ok"/);
    assert.match(p, /KEEP the language of the visitor's previous messages/);
});
