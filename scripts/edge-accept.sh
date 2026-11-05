#!/usr/bin/env bash
# Deployed-edge acceptance for one Cloudflare Worker deployment.
#
# Responsibilities are split on purpose:
#
#   * this script owns everything that needs the *deployment*: resolve the
#     deployed URL from the account's own Workers configuration (Wrangler 4.156
#     prints no workers.dev URL), wait for that URL to actually serve the
#     application (scripts/edge-readiness.sh), and record the deployment
#     identifier;
#   * scripts/edge-verify.mjs owns everything that needs a *browser*: it drives
#     the preinstalled Chrome under the declared edge-verify permission profile
#     and writes the acceptance evidence.
#
# The two phases answer different questions. Readiness asks "is the deployment
# being served yet?" and is bounded by a budget; observation asks "does it behave
# correctly?" and is answered only by the assertions. Neither substitutes for the
# other: a readiness timeout fails the run, and a ready deployment still has to
# pass every assertion.
#
# Acceptance is the conjunction of the assertions in the evidence file. Nothing
# here decides that a deployment is accepted because the commands succeeded.
#
# Evidence: the readiness attempt history is folded into
# `artifacts/acceptance.json` as `edgeReadiness` after the observer has written
# it. The fold never recomputes the verdict.
#
# Required environment:
#   WORKER_NAME              deployed Worker name (identity of the tested instance)
#   CLOUDFLARE_API_TOKEN     token with Workers Scripts:Read (never printed)
#   CLOUDFLARE_ACCOUNT_ID    account that holds the deployment
# Optional:
#   DEPLOY_LOG               Wrangler deploy output; used if it contains a URL
#   DEPLOY_EXIT_CODE         exit code of the deployment command (default 0)
#   EDGE_ARTIFACTS           artefact directory name (default artifacts)
#   EDGE_READINESS_TIMEOUT_MS  readiness budget in milliseconds (default 30000)
#   EDGE_READINESS_INTERVAL    seconds between readiness attempts (default 2)
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

# --- 3. Edge readiness gate -------------------------------------------------
# Wrangler reports success when the version is uploaded; the workers.dev route
# that serves it becomes available slightly later. Until it does, Cloudflare
# answers with its own error page (error 1042) or a transient 5xx, so a single
# request issued here would record Cloudflare's propagation state as the
# application's behaviour. This gate waits for the deployment instead: HTTP 200
# *and* the application this run deployed, with every attempt recorded. It is a
# precondition, not the verdict — the assertions below still decide, and they
# are never weakened by a slow deployment.
READINESS_TIMEOUT_MS="${EDGE_READINESS_TIMEOUT_MS:-30000}"
READINESS_INTERVAL="${EDGE_READINESS_INTERVAL:-2}"

set +e
"${BASH:-bash}" "$PROJECT_ROOT/scripts/edge-readiness.sh" \
    --url "$URL" \
    --worker "$WORKER_NAME" \
    --out "$ARTIFACTS" \
    --timeout-ms "$READINESS_TIMEOUT_MS" \
    --interval "$READINESS_INTERVAL"
READINESS_EXIT=$?
set -e

if (( READINESS_EXIT == 0 )); then
    EDGE_READY=true
else
    EDGE_READY=false
    echo "ERROR: $URL did not serve the deployed application within ${READINESS_TIMEOUT_MS}ms." >&2
    echo "ERROR: the attempt history above and $ARTIFACTS/edge-readiness.json record why." >&2
fi

# The status the observer records is the one the readiness gate last saw, so the
# evidence names the response that was actually tested rather than a second,
# unrelated request.
HTTP_STATUS="$(python3 - "$ARTIFACTS/edge-readiness.json" <<'PY'
import json, sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        report = json.load(handle)
except (OSError, ValueError):
    print("000")
else:
    status = report.get("finalStatus")
    print("000" if status is None else status)
PY
)"
echo "==> edge readiness: ready=$EDGE_READY, final response HTTP $HTTP_STATUS"

# --- 4. Real browser, declared permission profile --------------------------
# The flags below are the declared `edge-verify` profile: read the authorised
# criteria, write evidence, loopback DevTools, and run this exact Chrome. The
# profile is part of the launcher-permissions contract and is not changed here.
set +e
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
    --edge-ready "$EDGE_READY" \
    --expected-sha "$SHA" \
    --expected-deployment "$WORKER_NAME" \
    ${DEPLOYMENT_ID:+--deployment-id "$DEPLOYMENT_ID"} \
    "$@"
VERIFY_EXIT=$?
set -e

# --- 5. Evidence: fold the readiness history into the acceptance result ------
# The report is attached as evidence; the verdict is not recomputed here. A
# readiness timeout still fails this run even if the browser later observed a
# page that happened to render, because the deployment was not observably
# serving it inside the budget.
if [[ -f "$ARTIFACTS/edge-readiness.json" && -f "$ARTIFACTS/acceptance.json" ]]
then
    python3 - "$ARTIFACTS/acceptance.json" "$ARTIFACTS/edge-readiness.json" <<'PY'
import json, sys

evidence_path, readiness_path = sys.argv[1:3]

with open(evidence_path, encoding="utf-8") as handle:
    evidence = json.load(handle)
with open(readiness_path, encoding="utf-8") as handle:
    evidence["edgeReadiness"] = json.load(handle)

with open(evidence_path, "w", encoding="utf-8") as handle:
    json.dump(evidence, handle, indent=2)
    handle.write("\n")
PY
    echo "==> evidence: $ARTIFACTS/acceptance.json includes the edge readiness history"
fi

if (( READINESS_EXIT != 0 )); then
    echo "ERROR: edge acceptance failed: the deployment never became ready; see the attempt history above." >&2
    exit 1
fi

exit "$VERIFY_EXIT"
