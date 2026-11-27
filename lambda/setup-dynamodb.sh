#!/usr/bin/env bash
# One-time setup of the chatbot's single DynamoDB table, run BEFORE deploying
# the Lambda version that writes to it (AWS CloudShell works fine).
#
# Creates, if missing:
#   - Table `portfolio-chatbot` (on-demand billing, deletion protection) with the
#     index `sessions-by-last-seen` to list visitors newest first.
#   - An inline policy on the Lambda's execution role allowing it to read and
#     write ONLY that table.
# Safe to run again.
#
# Usage:
#   bash lambda/setup-dynamodb.sh
set -euo pipefail

TABLE="portfolio-chatbot"
INDEX="sessions-by-last-seen"
FUNCTION_NAME="portfolio-chatbot-handler"
REGION="us-east-1"
export AWS_DEFAULT_REGION="$REGION"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
TABLE_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}"
echo "AWS account: ${ACCOUNT_ID}"

# 1. Table
if aws dynamodb describe-table --table-name "$TABLE" > /dev/null 2>&1; then
    echo "✓ Table ${TABLE} already exists"
else
    aws dynamodb create-table \
        --table-name "$TABLE" \
        --billing-mode PAY_PER_REQUEST \
        --deletion-protection-enabled \
        --attribute-definitions \
            AttributeName=pk,AttributeType=S \
            AttributeName=sk,AttributeType=S \
            AttributeName=type,AttributeType=S \
            AttributeName=lastSeenAt,AttributeType=S \
        --key-schema \
            AttributeName=pk,KeyType=HASH \
            AttributeName=sk,KeyType=RANGE \
        --global-secondary-indexes "[{
            \"IndexName\": \"${INDEX}\",
            \"KeySchema\": [
                {\"AttributeName\": \"type\", \"KeyType\": \"HASH\"},
                {\"AttributeName\": \"lastSeenAt\", \"KeyType\": \"RANGE\"}
            ],
            \"Projection\": {\"ProjectionType\": \"ALL\"}
        }]" \
        --tags Key=project,Value=portfolio-chatbot \
        > /dev/null
    echo "… creating table ${TABLE}"
    aws dynamodb wait table-exists --table-name "$TABLE"
    echo "✓ Table ${TABLE} created"
fi

# 2. Let the Lambda use it
ROLE_ARN=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --query Role --output text)
ROLE_NAME="${ROLE_ARN##*/}"

POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "${TABLE_ARN}",
        "${TABLE_ARN}/index/*"
      ]
    }
  ]
}
EOF
)

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name portfolio-chatbot-table \
    --policy-document "$POLICY"
echo "✓ Lambda role ${ROLE_NAME} can read/write ${TABLE}"

cat <<EOF

Done. Next:
  1. Merge the PR (or run the "Deploy Chatbot Lambda" workflow) so the Lambda writes to ${TABLE}.
  2. Optional: copy the old conversations into it:
       cd lambda && npm ci && node scripts/migrate-old-tables.js --dry-run
       node scripts/migrate-old-tables.js
  3. See who's talking to the assistant:
       node scripts/chats.js
EOF
