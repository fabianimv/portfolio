# Portfolio Chatbot Lambda

Lambda `portfolio-chatbot-handler` + API Gateway + DynamoDB for the portfolio's AI assistant, backed by Google Gemini.

## How it works

1. The browser (`main.js`) sends `{ message, sessionId, visitorName, nameDeclined, lang, history }` to the API Gateway endpoint in `chatbot-config.js`.
   - `sessionId` is a UUID generated in the browser and kept in `localStorage` together with the visitor's name.
   - `history` is the last 12 messages of the conversation on screen, so the model has real multi-turn memory.
2. `index.js` makes **one Gemini call per turn** with a `systemInstruction` (rules + profile) and structured output: `{ reply, visitorName, nameDeclined, language }`.
   - **Name gate:** until the visitor gives a name, the model asks for it and doesn't answer yet. Once it gets the name, it also answers the question asked before. If the visitor refuses to share it, the gate opens.
   - The model detects the name and language, no regexes.
3. Each turn is logged in `portfolio-chatbot-messages` and the session (name, message count) in `portfolio-chatbot-sessions`. DynamoDB failures never break the reply.
4. If the backend fails, the browser falls back to local keyword answers and logs a `console.warn`.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `GEMINI_API_KEY` | yes | |
| `GEMINI_MODEL` | no | `gemini-flash-latest` (alias that always points to the newest Flash) |
| `ALLOWED_ORIGINS` | no | `*` (e.g. `https://fabianimv.github.io` to restrict CORS) |
| `MESSAGES_TABLE` / `SESSIONS_TABLE` | no | `portfolio-chatbot-messages` / `portfolio-chatbot-sessions` |

## Deploy

Option A, console / VS Code AWS Toolkit: replace the function's `index.js` with `lambda/index.js` and deploy. It uses no dependencies beyond the AWS SDK v3 included in the Node.js runtime.

Option B, script:

```bash
cd lambda
npm install
npm run deploy
```

Runtime: Node.js 18 or newer (uses the built-in `fetch`); new functions are created on `nodejs22.x`. Timeout: 30 s.

## Updating the profile

The assistant only answers from the `PROFILE` constant at the top of `index.js`. When the CV or `index.html` changes, update it there and redeploy.

## Logs

Logs are JSON lines (`request_ok`, `gemini_ok`, `gemini_error`, `rate_limited`, …) with latency and token usage, ready for CloudWatch Logs Insights:

```
fields @timestamp, event, latencyMs, usage.totalTokenCount, status, error
| filter event in ["request_ok", "gemini_error", "request_failed"]
| sort @timestamp desc
```

The `ver-*.sh` / `resumen-sesiones.sh` scripts still work to read conversations from DynamoDB.
