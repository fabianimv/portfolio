#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy the chatbot Lambda without AWS keys.
#
# Creates, if missing:
#   1. The GitHub Actions OIDC identity provider in IAM.
#   2. A role that ONLY the main branch of fabianimv/portfolio can assume, allowed
#      ONLY to read, update and invoke the portfolio-chatbot-handler function.
# Safe to run again: it updates the role's policies instead of failing.
#
# Usage (with AWS credentials that can manage IAM):
#   bash lambda/setup-github-deploy.sh
set -euo pipefail

REPO="fabianimv/portfolio"
BRANCH="main"
FUNCTION_NAME="portfolio-chatbot-handler"
REGION="us-east-1"
ROLE_NAME="github-deploy-portfolio-chatbot"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

echo "AWS account: ${ACCOUNT_ID}"

# 1. OIDC provider (one per AWS account; other repos can reuse it)
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" > /dev/null 2>&1; then
    echo "✓ GitHub OIDC provider already exists"
else
    aws iam create-open-id-connect-provider \
        --url https://token.actions.githubusercontent.com \
        --client-id-list sts.amazonaws.com \
        --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd \
        > /dev/null
    echo "✓ GitHub OIDC provider created"
fi

# 2. Role: only this repo's main branch can assume it
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:${REPO}:ref:refs/heads/${BRANCH}"
        }
      }
    }
  ]
}
EOF
)

# Least privilege: just this one function
PERMISSIONS_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:InvokeFunction"
      ],
      "Resource": "${FUNCTION_ARN}"
    }
  ]
}
EOF
)

if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY"
    echo "✓ Role ${ROLE_NAME} already existed; trust policy updated"
else
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --description "GitHub Actions (${REPO}@${BRANCH}) deploys ${FUNCTION_NAME}" \
        --assume-role-policy-document "$TRUST_POLICY" \
        > /dev/null
    echo "✓ Role ${ROLE_NAME} created"
fi

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name deploy-portfolio-chatbot-lambda \
    --policy-document "$PERMISSIONS_POLICY"
echo "✓ Permissions limited to ${FUNCTION_ARN}"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)

cat <<EOF

Last step: tell the workflow which role to use.
GitHub → ${REPO} → Settings → Secrets and variables → Actions → Variables → New repository variable

  Name:  AWS_LAMBDA_DEPLOY_ROLE_ARN
  Value: ${ROLE_ARN}

(or, with the GitHub CLI: gh variable set AWS_LAMBDA_DEPLOY_ROLE_ARN --repo ${REPO} --body "${ROLE_ARN}")
EOF
