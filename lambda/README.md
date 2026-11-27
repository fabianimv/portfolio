# Portfolio Chatbot Lambda

Lambda `portfolio-chatbot-handler` + API Gateway + DynamoDB for the portfolio's AI assistant, backed by Google Gemini.

## How it works

1. The browser (`main.js`) sends `{ message, sessionId, visitorName, nameDeclined, lang, history }` to the API Gateway endpoint in `chatbot-config.js`.
   - `sessionId` is a UUID generated in the browser and kept in `localStorage` together with the visitor's name.
   - `history` is the last 12 messages of the conversation on screen, so the model has real multi-turn memory.
2. `index.js` makes **one Gemini call per turn** with a `systemInstruction` (rules + profile) and structured output: `{ reply, visitorName, nameDeclined, language }`.
   - **Name gate:** until the visitor gives a name, the model asks for it and doesn't answer yet. Once it gets the name, it also answers the question asked before. If the visitor refuses to share it, the gate opens.
   - The model detects the name and language, no regexes.
3. Each turn is saved in the single DynamoDB table `portfolio-chatbot` (see [Data](#data-who-talks-to-the-assistant)). On the first message of a chat, the visitor's IP is located with ipwho.is in parallel with Gemini. DynamoDB or geolocation failures never break the reply.
4. If the backend fails, the browser falls back to local keyword answers and logs a `console.warn`.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `GEMINI_API_KEY` | yes | |
| `GEMINI_MODEL` | no | `gemini-flash-latest` (alias that always points to the newest Flash) |
| `GEMINI_FALLBACK_MODELS` | no | `gemini-flash-lite-latest`. Used when the main model answers 503/429 ("high demand"), times out or no longer exists. Comma-separated, tried in order |
| `ALLOWED_ORIGINS` | no | `*` (e.g. `https://fabianimv.github.io` to restrict CORS) |
| `CHAT_TABLE` | no | `portfolio-chatbot` |
| `ADMIN_TOKEN` | no | unset = private dashboard disabled (see [Private dashboard](#private-dashboard-adminhtml)) |
| `GEO_LOOKUP` | no | on; `off` stops sending visitor IPs to ipwho.is |

Function settings: **Timeout 30 s**, runtime **Node.js 24.x**, and **no VPC** (or a VPC with a NAT gateway), since it calls Gemini and ipwho.is over the internet. The deploy workflow warns about these and fails if `GEMINI_API_KEY` is missing.

## Automatic deploys (GitHub Actions)

`.github/workflows/deploy-lambda.yml`:

- **Every PR** that touches the Lambda runs `node --check` and the unit tests (`npm test`).
- **Every push to `main`** that touches the Lambda (or a manual run from the Actions tab) runs the tests, then:
  1. checks the function configuration: Node.js 24 (warns on older runtimes), `GEMINI_API_KEY` present (fails otherwise), timeout and VPC (warnings),
  2. builds `index.js` + `package.json` + production `node_modules` into a zip,
  3. backs up the code currently deployed,
  4. updates the function code (environment variables such as `GEMINI_API_KEY` are never touched),
  5. smoke-tests the live function (CORS preflight → 204, empty POST → 400; neither calls Gemini nor writes to DynamoDB),
  6. **restores the backup automatically** if any step after the update fails.

AWS access uses GitHub OIDC: no AWS keys are stored in GitHub. The role can only be assumed by `main` of this repo, and can only read, update and invoke this one function.

### One-time setup

1. With AWS credentials that can manage IAM, run:

   ```bash
   bash lambda/setup-github-deploy.sh
   ```

   It creates the GitHub OIDC provider (if missing) and the `github-deploy-portfolio-chatbot` role, and prints its ARN.
2. In GitHub → Settings → Secrets and variables → Actions → **Variables**, create `AWS_LAMBDA_DEPLOY_ROLE_ARN` with that ARN.
3. Actions → Deploy Chatbot Lambda → **Run workflow** to check it end to end.

Until the variable exists, the deploy job is skipped and only the tests run.

## Data: who talks to the assistant

One table, **`portfolio-chatbot`**. Every visitor session is a group of items with the same `pk`:

| pk | sk | type | What it holds |
|---|---|---|---|
| `SESSION#<id>` | `SESSION` | `session` | **Who and from where**: `visitorName`, `ip`, `location` (city, region, country), `country`, `network` (ISP or company, e.g. "Microsoft Corporation" = a bot in the cloud), `timezone`, `device`, `cameFrom` (external page that linked to the site), `firstSeenAt`, `lastSeenAt`, `messageCount`, `lastMessage` |
| `SESSION#<id>` | `MSG#<time>#<rand>` | `message` | **One Q&A turn**: `createdAt`, `userMessage`, `botResponse`, `language`, `visitorName`, `ip`, `location`, `latencyMs`, `tokens`, `model` |

- **All times are Chile time**, written as `2026-11-27 13:30:05`: readable and still sorted correctly.
- Index **`sessions-by-last-seen`** (`type` + `lastSeenAt`) lists visitors newest first.

### Private dashboard (`admin.html`)

`https://fabianimv.github.io/portfolio/admin.html`: latest visitors with name, city/country, network (cloud networks are flagged as probable bots), messages, the page they came from and their last question; click one to read the whole conversation. Search, period filter and "hide bots" included. Works on mobile.

- Not linked from the site and marked `noindex`. The page itself holds no data: it asks the Lambda, which answers only with the right **admin token** (same endpoint as the chat, `POST { admin: { token, action } }`, constant-time check, 30 requests/min per IP).
- Visitor text is always rendered as text, never as HTML.
- To enable it, create a long random token and add it to the function as the environment variable **`ADMIN_TOKEN`** (Configuration → Environment variables):

  ```bash
  openssl rand -hex 24
  ```

  Without `ADMIN_TOKEN` the admin API answers 404. Change the token any time to log every browser out.

### From the terminal

From `lambda/` (CloudShell works; run `npm ci` once):

```bash
node scripts/chats.js              # latest visitors: when, name, IP, location, network, messages
node scripts/chats.js Camila       # full conversations by name (or by IP / sessionId)
```

In the console: DynamoDB → Tables → `portfolio-chatbot` → **Explore items** → *Query* → index `sessions-by-last-seen`, `type` = `session`, sort descending. Querying a session's `pk` shows its messages in order.

### One-time setup

```bash
bash lambda/setup-dynamodb.sh                         # table + index + Lambda permission
cd lambda && npm ci
node scripts/migrate-old-tables.js --dry-run           # preview copying the old 2 tables
node scripts/migrate-old-tables.js                     # copy (old tables are left untouched)
```

After checking the data, delete `portfolio-chatbot-messages` and `portfolio-chatbot-sessions` in the console. Names in the old data came from the old regex (e.g. "Tell me about"), so some aren't real names.

## Manual deploy

Option A, console / VS Code AWS Toolkit: replace the function's `index.js` with `lambda/index.js` and deploy. It uses no dependencies beyond the AWS SDK v3 included in the Node.js runtime.

Option B, script (also creates the function, IAM role and API Gateway from scratch):

```bash
cd lambda
npm install
npm run deploy
```

Runtime: Node.js 24.x (`deploy.js` creates new functions on `nodejs24.x`; CI tests on Node 24). Timeout: 30 s.

## Updating the profile

The assistant only answers from the `PROFILE` constant at the top of `index.js`. When the CV or `index.html` changes, update it there and redeploy.

## Logs

Logs are JSON lines (`request_ok`, `gemini_ok`, `gemini_error`, `rate_limited`, …) with latency and token usage, ready for CloudWatch Logs Insights:

```
fields @timestamp, event, latencyMs, usage.totalTokenCount, status, error, cause
| filter event in ["request_ok", "gemini_error", "request_failed", "dynamodb_write_failed", "geo_lookup_failed"]
| sort @timestamp desc
```
