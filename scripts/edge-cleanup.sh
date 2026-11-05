#!/usr/bin/env bash
# Delete exactly one disposable acceptance Worker and verify that it is gone.
#
# Why this exists instead of `wrangler delete`
# --------------------------------------------
# Wrangler 4.156.0 deletes the Worker and then runs a "legacy Workers Sites"
# post-check that lists KV namespaces (`GET /accounts/{id}/storage/kv/namespaces`).
# That call needs Workers KV read access, which this workflow's token does not
# have, so Cloudflare answers `401 / code 10000` ("Authentication error").
# Wrangler only tolerates a `403` in that post-check
# (`isPermissionDeniedAPIError2` checks `status === 403`), so it rethrows and
# `wrangler delete` exits 1 *after the Worker has already been deleted*. The run
# then reported "cleanup could not delete … delete it manually" for a deletion
# that had in fact succeeded — a false failure that cannot be verified.
#
# This script performs the deletion itself, against the documented name-scoped
# endpoint, and then verifies the outcome with an independent read. The deletion
# request is never trusted on its own: the verification decides.
#
# Endpoints (Cloudflare's public OpenAPI schema, `api-schemas`)
# ------------------------------------------------------------
#   DELETE /accounts/{account_id}/workers/scripts/{script_name}?force=true
#     operationId `worker-script-delete-worker`, summary "Delete Worker",
#     "This call has no response body on a successful delete."
#     Accepted token groups: Workers Scripts Write, Workers Admin.
#   GET /accounts/{account_id}/workers/scripts/{script_name}/settings
#     operationId `worker-script-get-settings`, "Get Worker Script and Version
#     Settings" — JSON metadata, accepted token groups include Workers Scripts
#     Read/Write. `200` means the script still exists; `404` (code 10007, "This
#     Worker does not exist on your account.") means it is gone.
#
# Note: Wrangler deletes through `DELETE /accounts/{id}/workers/services/{name}`,
# which is *not* part of the public schema (only
# `/workers/services/{name}/environments/{env}/…` is). The two are not
# interchangeable, so this script uses the documented `workers/scripts` resource.
# No KV endpoint is called anywhere.
#
# Safety properties
# -----------------
#   * the target must match the workflow's disposable identity, `edge-<digits>-<digits>`;
#     anything else is rejected before a request is made, and a malformed name can
#     never be turned into a path segment;
#   * only the exact Worker resource is addressed: no listing, no enumeration, no
#     pattern, no second Worker name anywhere in the request path;
#   * the credential is read from CLOUDFLARE_API_TOKEN only (never from argv, so it
#     cannot be read from the process list) and is handed to curl through a private
#     `--config` file that is removed on exit. Every string written to the evidence
#     is scrubbed of the credential value before it is stored.
#
# Exit codes: 0 verified absent, 1 cleanup failed, 2 usage/validation error.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
#     bash scripts/edge-cleanup.sh --worker edge-<run>-<attempt> --out DIR \
#       [--evidence artifacts/acceptance.json] \
#       [--max-attempts 4] [--retry-delay 2]
#
# The file is sourceable and only runs its CLI when executed directly, which keeps
# it usable from a test driver without starting a cleanup.
set -uo pipefail

: "${EDGE_CLEANUP_MAX_ATTEMPTS:=4}"
: "${EDGE_CLEANUP_RETRY_DELAY:=2}"
: "${EDGE_CLEANUP_API_BASE:=https://api.cloudflare.com/client/v4}"
: "${EDGE_CLEANUP_CONNECT_TIMEOUT:=5}"
: "${EDGE_CLEANUP_MAX_TIME:=15}"

usage() {
    printf '%s\n' \
        "Delete one disposable acceptance Worker and verify that it is gone." \
        "" \
        "  --worker NAME      disposable Worker to delete (edge-<run>-<attempt>)" \
        "  --out DIR          artefact directory for cleanup.json" \
        "  --evidence FILE    acceptance.json to attach the cleanup record to" \
        "  --max-attempts N   attempts per phase for transient failures (default $EDGE_CLEANUP_MAX_ATTEMPTS)" \
        "  --retry-delay SEC  delay between transient attempts (default $EDGE_CLEANUP_RETRY_DELAY)" \
        "" \
        "Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (environment only)."
}

# Milliseconds since the epoch, without requiring GNU date.
now_ms() {
    if [[ -n "${EPOCHREALTIME:-}" && "${EPOCHREALTIME}" == *.* ]]; then
        local seconds="${EPOCHREALTIME%%.*}"
        local micros="${EPOCHREALTIME#*.}"
        printf '%s\n' "$(( seconds * 1000 + 10#${micros} / 1000 ))"
        return 0
    fi
    printf '%s000\n' "$(date +%s)"
}

# The workflow's disposable identity: `edge-<run_id>-<run_attempt>`.
#
# This is deliberately stricter than the API's own script-name pattern: the only
# Worker this script may ever delete is one the acceptance workflow created, so a
# name that cannot be that is refused before any request exists.
valid_worker_name() {
    local name="$1"
    [[ ${#name} -le 63 ]] || return 1
    [[ "$name" =~ ^edge-[0-9]{1,20}-[0-9]{1,4}$ ]]
}

# A Cloudflare account id is 32 hexadecimal characters.
valid_account_id() {
    [[ "$1" =~ ^[0-9a-f]{32}$ ]]
}

# Refuse a credential that could not be sent safely. The value is never printed;
# only the fact that it was rejected is reported.
valid_token_shape() {
    local token="$1"
    [[ ${#token} -ge 20 ]] || return 1
    [[ "$token" =~ ^[A-Za-z0-9_.-]+$ ]]
}

# The only network seam. Prints the HTTP status on stdout ("000" when no response
# arrived) and writes the body to $3, curl's diagnostic to $4.
#
# The credential is passed through a private curl config file ($CURL_CONFIG), not
# through the argument vector: `ps` cannot read it while the request is in flight.
api_request() {
    local method="$1" path="$2" body_file="$3" err_file="$4"
    local status=""

    status="$(curl -sS \
        --config "$CURL_CONFIG" \
        --request "$method" \
        --connect-timeout "$EDGE_CLEANUP_CONNECT_TIMEOUT" \
        --max-time "$EDGE_CLEANUP_MAX_TIME" \
        --output "$body_file" \
        --write-out '%{http_code}' \
        --url "${EDGE_CLEANUP_API_BASE}${path}" \
        2>"$err_file" || true)"
    [[ -n "$status" ]] || status="000"
    printf '%s\n' "$status"
}

is_success_status() { [[ "$1" == "200" || "$1" == "204" ]]; }
is_absent_status() { [[ "$1" == "404" ]]; }
is_auth_status() { [[ "$1" == "401" ]]; }
is_permission_status() { [[ "$1" == "403" ]]; }

# Transient means "the same request may succeed later": a transport failure, a
# rate limit, or a server-side failure. Everything else is a decision.
is_transient_status() {
    local status="$1"
    [[ "$status" == "000" || "$status" == "429" ]] && return 0
    [[ "$status" =~ ^5[0-9][0-9]$ ]]
}

# Append one attempt to the JSON-lines history.
#
# The Cloudflare error code and message are extracted here, from the response body
# the request actually produced, so the evidence explains a failure without a
# second request. A body that is not the documented JSON envelope (an HTML error
# page, an empty 200) is simply recorded as having no error envelope.
record_attempt() {
    local history_file="$1" phase="$2" attempt="$3" elapsed_ms="$4" status="$5"
    local retryable="$6" body_file="$7" err_file="$8"

    python3 - "$history_file" "$phase" "$attempt" "$elapsed_ms" "$status" \
        "$retryable" "$body_file" "$err_file" <<'PY'
import json, os, sys

(
    history, phase, attempt, elapsed_ms, status, retryable, body_path, err_path,
) = sys.argv[1:9]

code = message = None
try:
    with open(body_path, encoding="utf-8", errors="replace") as handle:
        payload = json.load(handle)
except Exception:
    payload = None
if isinstance(payload, dict):
    errors = payload.get("errors") or []
    if errors and isinstance(errors[0], dict):
        code = errors[0].get("code")
        message = errors[0].get("message")


def http_status(raw):
    """The HTTP status, or None when no status was received.

    curl reports "000" when the request never produced a response, and a status
    that is not a number at all must not abort the evidence either.
    """
    text = str(raw).strip()
    if text in ("", "000") or not text.isdigit():
        return None
    return int(text)

transport = None
if err_path and os.path.exists(err_path):
    with open(err_path, encoding="utf-8", errors="replace") as handle:
        text = " ".join(handle.read().split())
    if text:
        transport = text[:200]

record = {
    "attempt": int(attempt),
    "phase": phase,
    "elapsedMs": int(elapsed_ms),
    "httpStatus": http_status(status),
    "rawStatus": status,
    "cloudflareErrorCode": code,
    "cloudflareErrorMessage": message,
    "transportError": transport,
    "retryable": retryable == "1",
}

with open(history, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record) + "\n")
PY
}

# Final classification of the whole operation.
#
# The verification is authoritative: confirmed absence (404) is success however the
# deletion request answered, and a Worker that is still readable is a failure even
# if the deletion request returned 200.
classify_cleanup() {
    local delete_status="$1" verify_status="$2"
    local verify_attempted="$3"

    if (( verify_attempted == 0 )); then
        printf 'not-attempted\n'
        return 0
    fi

    if is_absent_status "$verify_status"; then
        if is_success_status "$delete_status"; then
            printf 'deleted-and-absent\n'
        elif is_absent_status "$delete_status"; then
            printf 'already-absent\n'
        else
            printf 'absent-after-delete-error\n'
        fi
        return 0
    fi

    if is_success_status "$verify_status"; then
        printf 'still-present\n'
    elif is_auth_status "$verify_status"; then
        printf 'authentication-failed\n'
    elif is_permission_status "$verify_status"; then
        printf 'permission-failed\n'
    elif [[ "$verify_status" == "000" ]]; then
        printf 'network-failure\n'
    elif is_transient_status "$verify_status"; then
        printf 'retries-exhausted\n'
    else
        printf 'unexpected-response\n'
    fi
}

# True when this classification describes a cleanup that actually finished.
is_cleanup_success() {
    case "$1" in
        deleted-and-absent | already-absent | absent-after-delete-error) return 0 ;;
        *) return 1 ;;
    esac
}

# The failure explanation recorded as `diagnostic`. It names what was observed and
# never contains the credential.
describe_failure() {
    local classification="$1" delete_status="$2" verify_status="$3"
    local verify_attempts="$4"

    case "$classification" in
        still-present)
            printf 'the Worker still exists after the deletion request (verification answered HTTP %s for all %s attempt(s))' \
                "$verify_status" "$verify_attempts"
            ;;
        authentication-failed)
            printf 'Cloudflare rejected the verification request as unauthenticated (HTTP %s); the token is missing, expired or invalid' \
                "$verify_status"
            ;;
        permission-failed)
            printf 'Cloudflare refused the verification request (HTTP %s); this token is not allowed to read this Worker' \
                "$verify_status"
            ;;
        network-failure)
            printf 'no HTTP response was received from the Cloudflare API; the attempt history records the transport error'
            ;;
        retries-exhausted)
            printf 'Cloudflare answered with a transient failure (HTTP %s) for every attempt; the retry budget was exhausted' \
                "$verify_status"
            ;;
        *)
            printf 'unexpected HTTP %s from the verification request after deletion answered HTTP %s' \
                "$verify_status" "$delete_status"
            ;;
    esac
}

# Issue one request, retrying only transient failures, bounded by $max_attempts.
# Prints the final HTTP status; every attempt is recorded in $history_file.
issue_request() {
    local method="$1" path="$2" body_file="$3" err_file="$4" history_file="$5"
    local phase="$6" max_attempts="$7" retry_delay="$8" retry_while_present="${9:-0}"

    local attempt=0 status="" retryable=0 started elapsed
    started="$(now_ms)"

    while :; do
        attempt=$((attempt + 1))
        status="$(api_request "$method" "$path" "$body_file" "$err_file")"
        elapsed="$(( $(now_ms) - started ))"

        retryable=0
        if is_transient_status "$status"; then
            retryable=1
        fi
        # After a deletion request, "still there" is worth re-reading: a delete can
        # take a moment to be reflected by the read API. This is bounded like any
        # other transient condition and never turns a persistent Worker into a pass.
        if (( retry_while_present == 1 )) && is_success_status "$status"; then
            retryable=1
        fi

        record_attempt "$history_file" "$phase" "$attempt" "$elapsed" "$status" \
            "$retryable" "$body_file" "$err_file"

        # Human-readable progress goes to stderr so that the function's stdout is
        # exactly one thing: the final HTTP status.
        printf 'cleanup: %s %s -> HTTP %s%s\n' "$method" "$path" "$status" \
            "$( (( retryable == 1 )) && printf ' (retrying)' || true )" >&2

        if (( retryable == 0 )); then
            break
        fi
        if (( attempt >= max_attempts )); then
            break
        fi
        sleep "$retry_delay"
    done

    printf '%s\n' "$status"
}

# Write cleanup.json and, when requested, attach the same record to the acceptance
# evidence without recomputing (or weakening) its verdict.
#
# The values reach the writer through the environment rather than a long argument
# vector, and every string is scrubbed of the credential value before it is
# written, so a diagnostic can never carry the secret into the artefact.
write_report() {
    local out_dir="$1"
    mkdir -p "$out_dir"

    CLEANUP_OUT="$out_dir" \
        CLEANUP_WORKER="$CLEANUP_WORKER" \
        CLEANUP_ACCOUNT="$CLEANUP_ACCOUNT" \
        CLEANUP_CLASSIFICATION="$CLEANUP_CLASSIFICATION" \
        CLEANUP_DIAGNOSTIC="$CLEANUP_DIAGNOSTIC" \
        CLEANUP_OK="$CLEANUP_OK" \
        CLEANUP_STARTED_AT="$CLEANUP_STARTED_AT" \
        CLEANUP_FINISHED_AT="$CLEANUP_FINISHED_AT" \
        CLEANUP_DURATION_MS="$CLEANUP_DURATION_MS" \
        CLEANUP_DELETE_ATTEMPTED="$CLEANUP_DELETE_ATTEMPTED" \
        CLEANUP_DELETE_STATUS="$CLEANUP_DELETE_STATUS" \
        CLEANUP_DELETE_PATH="$CLEANUP_DELETE_PATH" \
        CLEANUP_VERIFY_ATTEMPTED="$CLEANUP_VERIFY_ATTEMPTED" \
        CLEANUP_VERIFY_STATUS="$CLEANUP_VERIFY_STATUS" \
        CLEANUP_VERIFY_PATH="$CLEANUP_VERIFY_PATH" \
        CLEANUP_DELETE_HISTORY="${CLEANUP_DELETE_HISTORY:-}" \
        CLEANUP_VERIFY_HISTORY="${CLEANUP_VERIFY_HISTORY:-}" \
        CLEANUP_EVIDENCE="${CLEANUP_EVIDENCE:-}" \
        python3 - <<'PY'
import json, os

environment = os.environ
secret = environment.get("CLOUDFLARE_API_TOKEN", "")


def scrub(value):
    """Never store the credential, whatever produced the string."""
    if isinstance(value, str):
        return value.replace(secret, "***") if secret else value
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items()}
    return value


def history(path):
    records = []
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    return records


def status(raw):
    """HTTP status, or None when the observation was not a status at all.

    A malformed status, and curl's "000" (no response), are never allowed to
    abort the report: evidence of an unexpected answer is the point of writing it.
    """
    text = str(raw).strip()
    if text in ("", "-", "000") or not text.isdigit():
        return None
    return int(text)


delete_status = environment.get("CLEANUP_DELETE_STATUS", "-")
verify_status = environment.get("CLEANUP_VERIFY_STATUS", "-")

record = {
    "schemaVersion": 1,
    "worker": environment.get("CLEANUP_WORKER", ""),
    "account": environment.get("CLEANUP_ACCOUNT", ""),
    "ok": environment.get("CLEANUP_OK") == "1",
    "classification": environment.get("CLEANUP_CLASSIFICATION", ""),
    "diagnostic": environment.get("CLEANUP_DIAGNOSTIC") or None,
    "startedAt": environment.get("CLEANUP_STARTED_AT", ""),
    "timestamp": environment.get("CLEANUP_FINISHED_AT", ""),
    "durationMs": int(environment.get("CLEANUP_DURATION_MS") or 0),
    "deletion": {
        "attempted": environment.get("CLEANUP_DELETE_ATTEMPTED") == "1",
        "method": "DELETE",
        "path": environment.get("CLEANUP_DELETE_PATH", ""),
        "force": True,
        "httpStatus": status(delete_status),
        "rawStatus": delete_status,
        "attempts": history(environment.get("CLEANUP_DELETE_HISTORY", "")),
    },
    "verification": {
        "attempted": environment.get("CLEANUP_VERIFY_ATTEMPTED") == "1",
        "method": "GET",
        "path": environment.get("CLEANUP_VERIFY_PATH", ""),
        "httpStatus": status(verify_status),
        "rawStatus": verify_status,
        "absent": status(verify_status) == 404,
        "attempts": history(environment.get("CLEANUP_VERIFY_HISTORY", "")),
    },
}

record = scrub(record)

target = os.path.join(environment["CLEANUP_OUT"], "cleanup.json")
with open(target, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")

# Attach the record to the acceptance evidence when asked. The evidence verdict is
# not recomputed here: cleanup is recorded, never judged by this script.
evidence_path = environment.get("CLEANUP_EVIDENCE", "")
if evidence_path and os.path.exists(evidence_path):
    try:
        with open(evidence_path, encoding="utf-8") as handle:
            evidence = json.load(handle)
    except (OSError, ValueError):
        evidence = None
    if isinstance(evidence, dict):
        evidence["cleanup"] = record
        with open(evidence_path, "w", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2)
            handle.write("\n")

print(target)
PY
}

# Refuse before any request exists, with the evidence still written.
refuse_cleanup() {
    local classification="$1" diagnostic="$2" exit_code="$3" out_dir="$4"

    CLEANUP_CLASSIFICATION="$classification"
    CLEANUP_DIAGNOSTIC="$diagnostic"
    CLEANUP_OK=0
    CLEANUP_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    CLEANUP_DURATION_MS="$(( $(now_ms) - CLEANUP_STARTED_MS ))"

    local report
    report="$(write_report "$out_dir")"
    printf 'cleanup: REFUSED %s: %s\n' "$classification" "$diagnostic" >&2
    printf 'cleanup: no request was made; evidence written to %s\n' "$report" >&2
    return "$exit_code"
}

# Delete the Worker, verify it independently, record the result.
run_cleanup() {
    local worker="$1" out_dir="$2" max_attempts="$3" retry_delay="$4"

    CLEANUP_DELETE_PATH="/accounts/$CLEANUP_ACCOUNT/workers/scripts/$worker"
    CLEANUP_VERIFY_PATH="$CLEANUP_DELETE_PATH/settings"

    CLEANUP_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/edge-cleanup.XXXXXX")"
    CURL_CONFIG="$CLEANUP_WORK_DIR/curl.conf"

    # The credential reaches curl through this private file, never through argv.
    (
        umask 077
        printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
            "$CLOUDFLARE_API_TOKEN" >"$CURL_CONFIG"
    )

    CLEANUP_DELETE_HISTORY="$CLEANUP_WORK_DIR/deletion.jsonl"
    CLEANUP_VERIFY_HISTORY="$CLEANUP_WORK_DIR/verification.jsonl"
    : >"$CLEANUP_DELETE_HISTORY"
    : >"$CLEANUP_VERIFY_HISTORY"

    # 1. Delete exactly this Worker. `force` only permits deleting a Worker that
    #    other Workers still reference; for a disposable Worker it keeps the call
    #    idempotent, and it cannot widen the target, which is in the path.
    CLEANUP_DELETE_ATTEMPTED=1
    CLEANUP_DELETE_STATUS="$(issue_request DELETE \
        "${CLEANUP_DELETE_PATH}?force=true" \
        "$CLEANUP_WORK_DIR/deletion.body" \
        "$CLEANUP_WORK_DIR/deletion.err" \
        "$CLEANUP_DELETE_HISTORY" deletion "$max_attempts" "$retry_delay")"

    # 2. Verify independently: a 200 from the deletion request is not the verdict.
    CLEANUP_VERIFY_ATTEMPTED=1
    CLEANUP_VERIFY_STATUS="$(issue_request GET \
        "$CLEANUP_VERIFY_PATH" \
        "$CLEANUP_WORK_DIR/verification.body" \
        "$CLEANUP_WORK_DIR/verification.err" \
        "$CLEANUP_VERIFY_HISTORY" verification "$max_attempts" "$retry_delay" 1)"

    CLEANUP_CLASSIFICATION="$(classify_cleanup "$CLEANUP_DELETE_STATUS" \
        "$CLEANUP_VERIFY_STATUS" "$CLEANUP_VERIFY_ATTEMPTED")"

    local verify_attempts=0
    if [[ -s "$CLEANUP_VERIFY_HISTORY" ]]; then
        verify_attempts="$(wc -l <"$CLEANUP_VERIFY_HISTORY" | tr -d ' ')"
    fi

    CLEANUP_DIAGNOSTIC=""
    if is_cleanup_success "$CLEANUP_CLASSIFICATION"; then
        CLEANUP_OK=1
        if [[ "$CLEANUP_CLASSIFICATION" != "deleted-and-absent" ]]; then
            CLEANUP_DIAGNOSTIC="$(printf 'deletion answered HTTP %s, but the verification confirmed the Worker is absent' \
                "$CLEANUP_DELETE_STATUS")"
        fi
    else
        CLEANUP_OK=0
        CLEANUP_DIAGNOSTIC="$(describe_failure "$CLEANUP_CLASSIFICATION" \
            "$CLEANUP_DELETE_STATUS" "$CLEANUP_VERIFY_STATUS" "$verify_attempts")"
    fi

    CLEANUP_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    CLEANUP_DURATION_MS="$(( $(now_ms) - CLEANUP_STARTED_MS ))"

    local report
    report="$(write_report "$out_dir")"

    if (( CLEANUP_OK == 1 )); then
        printf 'cleanup: %s is gone (%s; delete HTTP %s, verification HTTP %s)\n' \
            "$worker" "$CLEANUP_CLASSIFICATION" "$CLEANUP_DELETE_STATUS" \
            "$CLEANUP_VERIFY_STATUS"
        printf 'cleanup: evidence written to %s\n' "$report"
        return 0
    fi

    printf 'cleanup: FAILED %s: %s\n' "$CLEANUP_CLASSIFICATION" \
        "$CLEANUP_DIAGNOSTIC" >&2
    printf 'cleanup: delete HTTP %s, verification HTTP %s; evidence written to %s\n' \
        "$CLEANUP_DELETE_STATUS" "$CLEANUP_VERIFY_STATUS" "$report" >&2
    return 1
}

main() {
    local worker="" out_dir="" evidence_path=""
    local max_attempts="$EDGE_CLEANUP_MAX_ATTEMPTS"
    local retry_delay="$EDGE_CLEANUP_RETRY_DELAY"

    while (( $# > 0 )); do
        case "$1" in
            --help | -h)
                usage
                return 0
                ;;
            --worker | --out | --evidence | --max-attempts | --retry-delay)
                if (( $# < 2 )); then
                    printf 'ERROR: %s requires a value\n' "$1" >&2
                    usage >&2
                    return 2
                fi
                case "$1" in
                    --worker) worker="$2" ;;
                    --out) out_dir="$2" ;;
                    --evidence) evidence_path="$2" ;;
                    --max-attempts) max_attempts="$2" ;;
                    --retry-delay) retry_delay="$2" ;;
                esac
                shift 2
                ;;
            *)
                printf 'ERROR: unknown argument %s\n' "$1" >&2
                usage >&2
                return 2
                ;;
        esac
    done

    if [[ -z "$out_dir" ]]; then
        printf 'ERROR: --out is required: the cleanup result has to be recorded\n' >&2
        usage >&2
        return 2
    fi
    if [[ ! "$max_attempts" =~ ^[0-9]+$ ]] || (( max_attempts < 1 )); then
        printf 'ERROR: --max-attempts must be a positive whole number\n' >&2
        return 2
    fi
    if [[ ! "$retry_delay" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
        printf 'ERROR: --retry-delay must be a number of seconds\n' >&2
        return 2
    fi

    # Everything the report needs, initialised before any refusal can occur.
    CLEANUP_WORKER="$worker"
    CLEANUP_ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
    CLEANUP_EVIDENCE="$evidence_path"
    CLEANUP_CLASSIFICATION="not-attempted"
    CLEANUP_DIAGNOSTIC=""
    CLEANUP_OK=0
    CLEANUP_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    CLEANUP_STARTED_MS="$(now_ms)"
    CLEANUP_FINISHED_AT="$CLEANUP_STARTED_AT"
    CLEANUP_DURATION_MS=0
    CLEANUP_DELETE_ATTEMPTED=0
    CLEANUP_DELETE_STATUS="-"
    CLEANUP_DELETE_PATH=""
    CLEANUP_VERIFY_ATTEMPTED=0
    CLEANUP_VERIFY_STATUS="-"
    CLEANUP_VERIFY_PATH=""
    CLEANUP_DELETE_HISTORY=""
    CLEANUP_VERIFY_HISTORY=""
    CLEANUP_WORK_DIR=""
    CURL_CONFIG=""

    # Validation happens before any request can be constructed, so a malformed
    # name or a missing credential can never reach the API.
    if [[ -z "$worker" ]] || ! valid_worker_name "$worker"; then
        refuse_cleanup invalid-worker-name \
            "the Worker name is missing or is not of the form edge-<run>-<attempt>; refusing to delete anything" \
            2 "$out_dir"
        return $?
    fi
    if ! valid_account_id "$CLEANUP_ACCOUNT"; then
        refuse_cleanup invalid-account \
            "CLOUDFLARE_ACCOUNT_ID is missing or is not a 32-character account id" \
            2 "$out_dir"
        return $?
    fi
    if ! valid_token_shape "${CLOUDFLARE_API_TOKEN:-}"; then
        refuse_cleanup invalid-credentials \
            "CLOUDFLARE_API_TOKEN is missing or is not a usable API token (the value is never shown)" \
            2 "$out_dir"
        return $?
    fi

    trap 'if [[ -n "$CLEANUP_WORK_DIR" ]]; then rm -rf "$CLEANUP_WORK_DIR"; fi' EXIT

    run_cleanup "$worker" "$out_dir" "$max_attempts" "$retry_delay"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
