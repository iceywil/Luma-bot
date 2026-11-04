#!/bin/sh
# Deploys the lead enrichment worker to the Railway "leads" service.
# The repo's root railway.json is the daily registration cron, so this service is built from a
# staged folder holding only its own Dockerfile and railway.json next to the code.
set -e
cd "$(dirname "$0")/../.."
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp package.json package-lock.json tsconfig.json "$stage"/
cp -R src "$stage"/src
rm -rf "$stage"/src/_tmp "$stage"/src/playwright_chrome_profile
cp deploy/leads/Dockerfile deploy/leads/railway.json "$stage"/
railway up "$stage" --path-as-root --service leads --detach "$@"
