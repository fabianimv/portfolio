#!/usr/bin/env node
/**
 * Who is talking to the portfolio's AI assistant, and what they asked.
 *
 * Usage (from lambda/, with AWS credentials, e.g. in CloudShell; run `npm ci` once):
 *   node scripts/chats.js                 # latest 30 visitors, newest first
 *   node scripts/chats.js --limit 100     # more visitors
 *   node scripts/chats.js Camila          # full conversations of visitors named Camila
 *   node scripts/chats.js 200.54.1.2      # ... or from that IP
 *   node scripts/chats.js <sessionId>     # ... or that session
 *
 * Times are stored and shown in Chile time (America/Santiago).
 */
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.CHAT_TABLE || 'portfolio-chatbot';
const INDEX = 'sessions-by-last-seen';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

let limit = 30;
let search;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') limit = Number(args[++i]) || 30;
    else if (!search) search = args[i];
}

// Stored as "2026-11-27 13:30:05" (Chile time); show up to the minute
const fmt = (t) => (t ? String(t).slice(0, 16) : '—');
const cut = (s, n) => {
    s = String(s ?? '—').replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const pad = (s, n) => cut(s, n).padEnd(n);

async function latestSessions(max) {
    const items = [];
    let ExclusiveStartKey;
    do {
        const res = await db.send(new QueryCommand({
            TableName: TABLE,
            IndexName: INDEX,
            KeyConditionExpression: '#t = :s',
            ExpressionAttributeNames: { '#t': 'type' },
            ExpressionAttributeValues: { ':s': 'session' },
            ScanIndexForward: false,
            Limit: Math.min(max - items.length, 100),
            ExclusiveStartKey
        }));
        items.push(...(res.Items || []));
        ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < max);
    return items;
}

async function conversation(sessionId) {
    const items = [];
    let ExclusiveStartKey;
    do {
        const res = await db.send(new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :msg)',
            ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}`, ':msg': 'MSG#' },
            ExclusiveStartKey
        }));
        items.push(...(res.Items || []));
        ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

function where(s) {
    return s.location || s.timezone || '—';
}

async function list() {
    const sessions = await latestSessions(limit);
    if (!sessions.length) return console.log(`No conversations yet in ${TABLE}.`);

    console.log(`\n${sessions.length} latest visitors of the AI assistant (Chile time)\n`);
    console.log(`${pad('LAST SEEN', 16)} ${pad('NAME', 16)} ${pad('IP', 15)} ${pad('LOCATION', 30)} ${pad('NETWORK', 20)} ${pad('MSGS', 4)} ${pad('CAME FROM', 22)} LAST QUESTION`);
    console.log('─'.repeat(160));
    for (const s of sessions) {
        console.log([
            pad(fmt(s.lastSeenAt), 16),
            pad(s.visitorName || (s.nameDeclined ? '(anonymous)' : '(no name yet)'), 16),
            pad(s.ip, 15),
            pad(where(s), 30),
            pad(s.network || '—', 20),
            pad(s.messageCount ?? 0, 4),
            pad(s.cameFrom ? s.cameFrom.replace(/^https?:\/\/(www\.)?/, '') : '—', 22),
            cut(s.lastMessage, 36)
        ].join(' '));
    }

    const named = sessions.filter((s) => s.visitorName).length;
    const ips = new Set(sessions.map((s) => s.ip).filter(Boolean)).size;
    console.log(`\n${named} with a name · ${ips} distinct IPs. See a conversation: node scripts/chats.js <name | ip | sessionId>\n`);
}

async function show(term) {
    const needle = term.toLowerCase();
    const sessions = (await latestSessions(1000)).filter((s) =>
        s.sessionId === term || s.ip === term || (s.visitorName || '').toLowerCase().includes(needle));
    if (!sessions.length) return console.log(`No visitor matches "${term}".`);

    for (const s of sessions) {
        console.log('\n' + '━'.repeat(80));
        console.log(`👤 ${s.visitorName || '(no name)'}   🌐 ${s.ip || '—'}   📍 ${where(s)}${s.network ? `   🏢 ${s.network}` : ''}`);
        if (s.timezone || s.device) console.log(`   🕰  ${[s.timezone, s.device].filter(Boolean).join(' · ')}`);
        console.log(`🕒 ${fmt(s.firstSeenAt)} → ${fmt(s.lastSeenAt)}   💬 ${s.messageCount ?? 0} messages   🔗 ${s.cameFrom || 'direct'}`);
        console.log(`   session ${s.sessionId}`);
        console.log('━'.repeat(80));
        for (const m of await conversation(s.sessionId)) {
            console.log(`\n[${fmt(m.createdAt)}]`);
            console.log(`  👤 ${m.userMessage}`);
            console.log(`  🤖 ${String(m.botResponse || '').replace(/\n/g, '\n     ')}`);
        }
    }
    console.log('');
}

(search ? show(search) : list()).catch((err) => {
    console.error('✗', err.name === 'ResourceNotFoundException' ? `Table ${TABLE} not found. Run lambda/setup-dynamodb.sh first.` : err.message);
    process.exit(1);
});
