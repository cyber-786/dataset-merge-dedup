#!/bin/bash
# Creates a test dataset on Apify with sample leads containing:
# - exact duplicates (same email, different casing/whitespace)
# - fuzzy duplicates (typos, "Corp" vs "Corporation")
# Prints the dataset ID to use in the actor's input.

set -e
TOKEN="YOUR_API_TOKEN"   # <-- paste your Apify API token here

echo "Creating dataset..."
DATASET_ID=$(curl -s -X POST "https://api.apify.com/v2/datasets?token=${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"dedup-test-data"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.id')

echo "Dataset created: ${DATASET_ID}"
echo "Adding test items..."

curl -s -X POST "https://api.apify.com/v2/datasets/${DATASET_ID}/items?token=${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '[
    { "companyName": "Microsoft Corp",       "email": "info@microsoft.com" },
    { "companyName": "Microsoft Corporation","email": "info@microsoft.com" },
    { "companyName": "Apple Inc",            "email": "contact@apple.com" },
    { "companyName": "Aple Inc",             "email": "contact@apple.com" },
    { "companyName": "Google LLC",           "email": "hello@google.com" },
    { "companyName": "Google LLC",           "email": "  HELLO@Google.com  " },
    { "companyName": "Tesla Inc",            "email": "press@tesla.com" }
  ]'

echo ""
echo "Done. Dataset ID: ${DATASET_ID}"
echo "Use this ID in the actor's datasetIds input."
