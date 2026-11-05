#!/usr/bin/env bash
# Deployed-edge acceptance for one Cloudflare Worker deployment.
#
# Responsibilities are split on purpose:
#
#   * this script owns everything that needs the *deployment*: resolve the
#     deployed URL from the account's own Workers configuration (Wrangler 4.156
#     prints no workers.dev URL), make the independent HTTP request, and record
#     the deployment identifier;
#   * scripts/edge-verify.mjs owns everything that needs a *browser*: it drives
#     the preinstalled Chrome under the declared edge-verify permission profile
#     and writes the acceptance evidence.
#
# Acceptance is the conjunction of the assertions in the evidence file. Nothing
# here decides that a deployment is accepted because the commands succeeded.
#
# Required environment:
#   WORKER_NAME              deployed Worker name (identity of the tested instance)
#   CLOUDFLARE_API_TOKEN     token with Workers Scripts:Read (never printed)
#   CLOUDFLARE_ACCOUNT_ID    account that holds the deployment
# Optional:
#   DEPLOY_LOG               Wrangler deploy output; used if it contains a URL
#   DEPLOY_EXIT_CODE         exit code of the deployment command (default 0)
#   EDGE_ARTIFACTS           artefact directory name (default artifacts)
#   CHROME_BIN               Chrome executable (default: first on PATH)
#   GITHUB_SHA/RUN_ID/RUN_ATTEMPT   provenance, when running in Actions
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/edge-accept.sh" "$@"
fi

: "${WORKER_NAME:?WORKER_NAME must name the deployed Worker}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required to resolve the deployment}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required to resolve the deployment}"

ARTIFACTS="$PROJECT_ROOT/${EDGE_ARTIFACTS:-artifacts}"
CRITERIA="$PROJECT_ROOT/acceptance/criteria.json"
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
RUN_ID="${GITHUB_RUN_ID:-local}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
DEPLOY_EXIT_CODE="${DEPLOY_EXIT_CODE:-0}"

if [[ -n "${CHROME_BIN:-}" ]]; then
    CHROME="$CHROME_BIN"
else
    CHROME="$(command -v google-chrome || command -v google-chrome-stable ||
        command -v chromium-browser || command -v chromium || true)"
fi
if [[ -z "$CHROME" || ! -x "$CHROME" ]]; then
    echo "ERROR: no Chrome/Chromium executable found; set CHROME_BIN." >&2
    exit 1
fi

mkdir -p "$ARTIFACTS"

# --- 1. Deployed URL --------------------------------------------------------
# The URL is taken from the deployment result. Wrangler does not print it for a
# workers.dev deployment, so the account's own subdomain is read from the
# Cloudflare API and paired with the deployed name the deployment reported. If
# the deploy log does contain a URL, that value wins and is recorded as such.
URL=""
URL_SOURCE=""
if [[ -n "${DEPLOY_LOG:-}" && -f "${DEPLOY_LOG:-}" ]]; then
    URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" |
        head -n1 || true)"
    if [[ -n "$URL" ]]; then
        URL_SOURCE="deploy-output"
    fi
fi

if [[ -z "$URL" ]]; then
    SUBDOMAIN_RESPONSE="$(curl -fsS \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain")"
    SUBDOMAIN="$(printf '%s' "$SUBDOMAIN_RESPONSE" | python3 -c \
        'import json,sys; print(json.load(sys.stdin)["result"]["subdomain"])')"
    URL="https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev"
    URL_SOURCE="cloudflare-api:workers/subdomain"
fi

echo "==> tested deployment: worker=$WORKER_NAME url=$URL (source: $URL_SOURCE)"

# --- 2. Deployment identifier (best effort) ---------------------------------
DEPLOYMENT_ID="$(node "${PROJECT_ROOT}/node_modules/wrangler/bin/wrangler.js" \
    deployments status --name "$WORKER_NAME" --json 2>/dev/null |
    python3 -c 'import json,sys
d = json.load(sys.stdin)
print(d.get("id") or (d.get("versions") or [{}])[0].get("version_id") or "")' \
        2>/dev/null || true)"
if [[ -z "$DEPLOYMENT_ID" ]]; then
    echo "==> deployment identifier unavailable; evidence records null" >&2
fi

# --- 3. Independent HTTP request -------------------------------------------
HTTP_STATUS="$(curl -sS -o "$ARTIFACTS/page.html" -w '%{http_code}' "$URL" ||
    echo "000")"
echo "==> independent HTTP request: $URL -> HTTP $HTTP_STATUS"

# --- 4. Real browser, declared permission profile --------------------------
# The flags below are the declared `edge-verify` profile: read the authorised
# criteria, write evidence, loopback DevTools, and run this exact Chrome. The
# profile is part of the launcher-permissions contract.
deno run \
    --allow-read="$PROJECT_ROOT/acceptance" \
    --allow-write="$ARTIFACTS" \
    --allow-net=127.0.0.1 \
    --allow-run="$CHROME" \
    --cached-only \
    --frozen \
    scripts/edge-verify.mjs \
    --url "$URL" \
    --worker "$WORKER_NAME" \
    --sha "$SHA" \
    --criteria "$CRITERIA" \
    --out "$ARTIFACTS" \
    --chrome "$CHROME" \
    --http-status "$HTTP_STATUS" \
    --run-id "$RUN_ID" \
    --run-attempt "$RUN_ATTEMPT" \
    --url-source "$URL_SOURCE" \
    --deploy-exit "$DEPLOY_EXIT_CODE" \
    --expected-sha "$SHA" \
    --expected-deployment "$WORKER_NAME" \
    ${DEPLOYMENT_ID:+--deployment-id "$DEPLOYMENT_ID"} \
    "$@"
