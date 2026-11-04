# Lead enrichment worker (npm run enrich-leads) for the Railway "leads" service.
# Reads and writes its files on the volume mounted at /data, so it continues where it stopped.
FROM node:22-slim

# Claude Code CLI, used to fill title/company/vertical/chains (auth via CLAUDE_CODE_OAUTH_TOKEN)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV OUTPUT_DIR=/data
# ENRICH_ARGS: the leads file and options, e.g. "/data/token2049_leads_clean.json --target=5000"
# Enrichment starts once /data/.ready exists, so the input files can be uploaded to a fresh volume first.
# The download server (serveOutputs.ts, needs DOWNLOAD_KEY) runs alongside, so results can be
# fetched over HTTPS while the job runs and after it finishes. A crash exits non-zero, so Railway
# restarts it and it resumes.
CMD ["sh", "-c", "npx ts-node src/cli/serveOutputs.ts & while [ ! -f /data/.ready ]; do echo 'Waiting for /data/.ready (upload the leads, then .ready)'; sleep 30; done; npx ts-node src/cli/enrichLeads.ts $ENRICH_ARGS || exit 1; echo 'Finished, the download server keeps running'; wait"]
