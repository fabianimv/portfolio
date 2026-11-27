#!/usr/bin/env node
/**
 * Copies conversations from the old tables into the single `portfolio-chatbot` table.
 *
 *   portfolio-chatbot-messages  (one item per message, keyed by messageId)
 *   portfolio-chatbot-sessions  (visitor name per sessionId)
 *        ↓
 *   portfolio-chatbot           (SESSION#<id> / SESSION  +  SESSION#<id> / MSG#<time>#<id>)
 *
 * Read-only on the old tables. Idempotent: running it twice writes the same items.
 * The old tables are NOT deleted; do that yourself in the console once you've checked.
 *
 * Usage (from lambda/, with AWS credentials, e.g. in CloudShell):
 *   npm ci
 *   node scripts/migrate-old-tables.js --dry-run   # show what would be copied
 *   node scripts/migrate-old-tables.js             # copy
 *   node scripts/migrate-old-tables.js --no-geo    # copy without locating IPs
 *
 * Times are converted to Chile time ("2026-11-27 13:30:05") and each distinct IP is
 * located once with ipwho.is (city, region, country, network), like the Lambda does.
 */
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'us-east-1';
const OLD_MESSAGES = process.env.OLD_MESSAGES_TABLE || 'portfolio-chatbot-messages';
const OLD_SESSIONS = process.env.OLD_SESSIONS_TABLE || 'portfolio-chatbot-sessions';
const NEW_TABLE = process.env.CHAT_TABLE || 'portfolio-chatbot';
const DRY_RUN = process.argv.includes('--dry-run');
const GEO = !process.argv.includes('--no-geo');

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true }
});

async function scanAll(table) {
    const items = [];
    let ExclusiveStartKey;
    try {
        do {
            const res = await db.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
            items.push(...(res.Items || []));
            ExclusiveStartKey = res.LastEvaluatedKey;
        } while (ExclusiveStartKey);
    } catch (err) {
        if (err.name === 'ResourceNotFoundException') {
            console.log(`- ${table}: does not exist, skipping`);
            return [];
        }
        throw err;
    }
    console.log(`- ${table}: ${items.length} items`);
    return items;
}

// Old items stored ISO strings (timestamp) or epoch seconds (createdAt) -> Chile time
function toChile(value) {
    if (!value) return undefined;
    const d = typeof value === 'number' ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
    if (isNaN(d)) return undefined;
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(d);
}

async function locate(ips) {
    const out = new Map();
    if (!GEO) return out;
    console.log(`Locating ${ips.length} IPs with ipwho.is…`);
    for (const ip of ips) {
        try {
            const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country,country_code,connection`, { signal: AbortSignal.timeout(5000) });
            const d = await res.json();
            if (d.success) {
                out.set(ip, {
                    location: [d.city, d.region, d.country].filter(Boolean).join(', ') || undefined,
                    country: d.country_code || undefined,
                    network: (d.connection?.org || d.connection?.isp || '').split(',')[0].trim().slice(0, 60) || undefined
                });
            }
        } catch { /* leave unlocated */ }
        await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  located ${out.size}/${ips.length}`);
    return out;
}

async function writeAll(items) {
    for (let i = 0; i < items.length; i += 25) {
        let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
        for (let attempt = 0; requests.length && attempt < 8; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
            const res = await db.send(new BatchWriteCommand({ RequestItems: { [NEW_TABLE]: requests } }));
            requests = res.UnprocessedItems?.[NEW_TABLE] || [];
        }
        if (requests.length) throw new Error(`${requests.length} items could not be written`);
        process.stdout.write(`\r  written ${Math.min(i + 25, items.length)}/${items.length}`);
    }
    if (items.length) process.stdout.write('\n');
}

(async () => {
    console.log(`Reading old tables (${REGION})…`);
    const [messages, sessions] = await Promise.all([scanAll(OLD_MESSAGES), scanAll(OLD_SESSIONS)]);

    const bySession = new Map();
    const group = (id) => {
        if (!bySession.has(id)) bySession.set(id, { messages: [], meta: {} });
        return bySession.get(id);
    };
    for (const s of sessions) if (s.sessionId) group(s.sessionId).meta = s;
    for (const m of messages) if (m.sessionId) group(m.sessionId).messages.push(m);

    const ips = [...new Set([...messages.map((m) => m.ipAddress), ...sessions.map((s) => s.ipAddress)].filter((ip) => ip && ip !== 'unknown'))];
    const geoByIp = await locate(ips);

    const out = [];
    for (const [sessionId, { messages: msgs, meta }] of bySession) {
        const pk = `SESSION#${sessionId}`;
        msgs.sort((a, b) => String(toChile(a.timestamp || a.createdAt)).localeCompare(String(toChile(b.timestamp || b.createdAt))));

        for (const m of msgs) {
            const createdAt = toChile(m.timestamp || m.createdAt) || '1970-01-01 00:00:00';
            out.push({
                pk,
                sk: `MSG#${createdAt}#${String(m.messageId || '').slice(-9) || 'old'}`,
                type: 'message',
                sessionId,
                createdAt,
                visitorName: m.visitorName || meta.visitorName,
                ip: m.ipAddress || meta.ipAddress,
                location: geoByIp.get(m.ipAddress || meta.ipAddress)?.location,
                userMessage: m.userMessage,
                botResponse: m.botResponse,
                language: m.language,
                awaitingName: m.awaitingName,
                requestId: m.requestId,
                migratedFrom: OLD_MESSAGES
            });
        }

        const times = msgs.map((m) => toChile(m.timestamp || m.createdAt)).filter(Boolean);
        const firstSeenAt = times[0] || toChile(meta.createdAt) || toChile(meta.updatedAt);
        const lastSeenAt = times[times.length - 1] || toChile(meta.updatedAt) || firstSeenAt;
        const last = msgs[msgs.length - 1];
        const ip = meta.ipAddress || msgs.find((m) => m.ipAddress)?.ipAddress;
        const geo = geoByIp.get(ip) || {};
        out.push({
            pk,
            sk: 'SESSION',
            type: 'session',
            sessionId,
            visitorName: meta.visitorName || msgs.find((m) => m.visitorName)?.visitorName,
            ip,
            location: geo.location,
            country: geo.country,
            network: geo.network,
            firstSeenAt,
            lastSeenAt,
            messageCount: msgs.length,
            lastLanguage: last?.language,
            lastMessage: last?.userMessage ? String(last.userMessage).slice(0, 200) : undefined,
            migratedFrom: 'v2 tables'
        });
    }

    const sessionsOut = out.filter((i) => i.type === 'session');
    console.log(`\nWill write ${sessionsOut.length} sessions and ${out.length - sessionsOut.length} messages to ${NEW_TABLE}.`);
    console.log(`Sessions with a name: ${sessionsOut.filter((s) => s.visitorName).length}`);

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing written. Sample:');
        console.log(JSON.stringify(sessionsOut.slice(0, 3), null, 2));
        return;
    }
    await writeAll(out);
    console.log(`✓ Done. Old tables untouched; delete them in the DynamoDB console when you're happy.`);
})().catch((err) => {
    console.error('✗', err.message);
    process.exit(1);
});
