#!/usr/bin/env bash
# Wait until the published Worker actually serves the application that was
# deployed.
#
# Wrangler reports deployment success as soon as the version is uploaded, but the
# workers.dev route that serves it becomes available slightly later. Until it
# does, Cloudflare answers with its own error page (error 1042) or a transient
# 5xx. That is a property of propagation, not of the application: a single
# request issued immediately after deployment measures Cloudflare, not the
# deployment, and the observer that ran against such an answer rejected a page
# which rendered correctly moments later (run 42109653598).
#
# This script owns that wait. It is deliberately not a Deno launcher: it needs
# HTTP and nothing else, and a new launcher would have to be recorded in the
# `launcher-permissions` contract, whose lock this change must not touch.
#
# "Ready" is HTTP 200 *and* the application this run deployed, never an
# arbitrary 200:
#
#   1. the body contains the `#app` mount point declared in `index.html`, and
#   2. its `<title>` is the Worker name this run deployed — `scripts/init-project.mjs`
#      writes the project identity into the title, so a Cloudflare welcome page,
#      a cached page from another deployment, or any other 200 cannot be
#      mistaken for this deployment answering.
#
# Readiness is a *precondition*, not the acceptance verdict: the assertions in
# `scripts/edge-verify.mjs` still decide, and this script never writes that
# verdict.
#
# Every attempt is recorded — number, elapsed time, HTTP status, Cloudflare error
# code and a diagnostic — at `$OUT/edge-readiness.json`. On timeout the final
# response and the full history are printed and the exit status is non-zero, so
# the caller must fail explicitly rather than continue.
#
# Usage:
#   bash scripts/edge-readiness.sh --url URL --worker NAME --out DIR \
#       [--timeout-ms 30000] [--interval 2]
#
# Exit codes: 0 ready, 1 not ready within the budget, 2 usage error.
#
# The file is sourceable (`source scripts/edge-readiness.sh`) and only runs its
# CLI when executed directly. That is how the regression suite drives the real
# polling loop: it replaces `probe_once`, the single network seam, and leaves
# every classification, timing and reporting step under test.

# Defaults, overridable from the environment and from the command line. Assign
# with `:-` so sourcing this file never clobbers a caller's value.
: "${EDGE_READINESS_DEFAULT_TIMEOUT_MS:=30000}"
: "${EDGE_READINESS_DEFAULT_INTERVAL:=2}"

usage() {
    printf '%s\n' \
        "Wait until the published Worker serves the deployed application." \
        "" \
        "  --url URL           published workers.dev URL" \
        "  --worker NAME       deployed Worker name the page title must report" \
        "  --out DIR           artefact directory (edge-readiness.json, page.html)" \
        "  --timeout-ms MS     bounded budget (default $EDGE_READINESS_DEFAULT_TIMEOUT_MS)" \
        "  --interval SECONDS  delay between attempts (default $EDGE_READINESS_DEFAULT_INTERVAL)"
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

# The single network seam. Prints the HTTP status on stdout ("000" when no
# response arrived at all) and writes the body to $2; curl's own diagnostic goes
# to "$2.err". Its exit status is intentionally not propagated: a failed attempt
# is an ordinary observation here.
probe_once() {
    local url="$1" body_file="$2" status=""
    status="$(curl -sS \
        --connect-timeout "${EDGE_READINESS_CONNECT_TIMEOUT:-5}" \
        --max-time "${EDGE_READINESS_MAX_TIME:-10}" \
        -o "$body_file" -w '%{http_code}' "$url" 2>"${body_file}.err" || true)"
    [[ -n "$status" ]] || status="000"
    printf '%s\n' "$status"
}

# Cloudflare's own error pages carry `error code: 1042` (HTML) or `"code":1042`
# (JSON). Most responses carry neither, and that is not an error.
cloudflare_error_code() {
    local body_file="$1"
    [[ -f "$body_file" ]] || return 0
    {
        grep -oE 'error code:? *[0-9]{3,4}|"code" *: *[0-9]{3,4}' "$body_file" ||
            true
    } | head -n 1 | grep -oE '[0-9]{3,4}' || true
}

# Is this response worth retrying while the deployment propagates? Cloudflare
# 1042, a transient 5xx and a missing response are. Everything else is still
# bounded by the same budget, but is reported as what it is so the history
# explains the wait instead of describing it as propagation.
is_transient_response() {
    local status="$1" code="$2"
    [[ "$code" == "1042" || "$status" == "1042" ]] && return 0
    [[ "$status" == "000" ]] && return 0
    [[ "$status" =~ ^5[0-9][0-9]$ ]]
}

# Print why this response is not yet this run's deployed application; print
# nothing when it is. An empty result is the only readiness signal.
response_problem() {
    local status="$1" worker="$2" body_file="$3" code="$4"

    if [[ "$status" == "200" ]]; then
        if ! grep -Fq 'id="app"' "$body_file" 2>/dev/null; then
            printf 'HTTP 200 without the #app mount point of the deployed page'
            return 0
        fi
        if ! grep -Fq "<title>${worker}</title>" "$body_file" 2>/dev/null; then
            printf 'HTTP 200 whose <title> is not %s, so another deployment answered' \
                "$worker"
            return 0
        fi
        return 0
    fi

    if [[ "$status" == "000" ]]; then
        local reason=""
        if [[ -f "${body_file}.err" ]]; then
            reason="$(head -c 200 "${body_file}.err" 2>/dev/null | tr '\n' ' ' ||
                true)"
        fi
        printf 'no HTTP response%s' "${reason:+: $reason}"
        return 0
    fi

    if [[ -n "$code" ]]; then
        printf 'HTTP %s (Cloudflare error %s)' "$status" "$code"
        return 0
    fi

    printf 'HTTP %s' "$status"
}

# Append one attempt to the JSON-lines history.
record_attempt() {
    local history_file="$1" attempt="$2" elapsed_ms="$3" status="$4" code="$5"
    local retryable="$6" ready="$7" problem="$8"

    python3 - "$history_file" "$attempt" "$elapsed_ms" "$status" "$code" \
        "$retryable" "$ready" "$problem" <<'PY'
import json, sys

history, attempt, elapsed_ms, status, code, retryable, ready, problem = sys.argv[1:9]

record = {
    "attempt": int(attempt),
    "elapsedMs": int(elapsed_ms),
    "status": None if status in ("", "000") else int(status),
    "rawStatus": status,
    "cloudflareErrorCode": int(code) if code else None,
    "retryable": retryable == "1",
    "ready": ready == "1",
    "diagnostic": problem or None,
}

with open(history, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record) + "\n")
PY
}

# Write the machine-readable report that the acceptance evidence carries.
write_readiness_report() {
    local out_dir="$1" url="$2" worker="$3" timeout_ms="$4" interval="$5"
    local started_at="$6" elapsed_ms="$7" ready="$8" timed_out="$9"
    local final_status="${10}" skipped="${11}" history_file="${12}"

    python3 - "$out_dir" "$url" "$worker" "$timeout_ms" "$interval" \
        "$started_at" "$elapsed_ms" "$ready" "$timed_out" "$final_status" \
        "$skipped" "$history_file" <<'PY'
import json, os, sys

(
    out_dir, url, worker, timeout_ms, interval, started_at, elapsed_ms,
    ready, timed_out, final_status, skipped, history,
) = sys.argv[1:13]

attempts = []
with open(history, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if line:
            attempts.append(json.loads(line))

report = {
    "schemaVersion": 1,
    "url": url,
    "workerName": worker,
    "timeoutMs": int(timeout_ms),
    "intervalSeconds": float(interval),
    "startedAt": started_at,
    "elapsedMs": int(elapsed_ms),
    "ready": ready == "1",
    "timedOut": timed_out == "1",
    "skipped": skipped == "1",
    "finalStatus": None if final_status in ("", "000") else int(final_status),
    "rawFinalStatus": final_status,
    "finalResponse": attempts[-1] if attempts else None,
    "attempts": attempts,
}

target = os.path.join(out_dir, "edge-readiness.json")
with open(target, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
    handle.write("\n")
PY
}

# Poll until the deployment is ready or the budget is spent.
#
#   poll_edge_readiness <url> <worker> <out-dir> <timeout-ms> <interval>
#
# Returns 0 when ready, 1 otherwise. Side effects: the per-attempt history is
# printed, `$OUT/edge-readiness.json` is written, and `$OUT/page.html` holds the
# last response body that was actually tested.
poll_edge_readiness() {
    local url="$1" worker="$2" out_dir="$3" timeout_ms="$4" interval="$5"

    mkdir -p "$out_dir"
    local work_dir
    work_dir="$(mktemp -d "${TMPDIR:-/tmp}/edge-readiness.XXXXXX")"
    local history_file="$work_dir/history.jsonl"
    local body_file="$work_dir/body"
    : >"$history_file"

    local started_ms started_at attempt=0 status elapsed code problem retryable
    local ready=0 timed_out=0
    started_ms="$(now_ms)"
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    while :; do
        attempt=$((attempt + 1))
        status="$(probe_once "$url" "$body_file")"
        elapsed="$(( $(now_ms) - started_ms ))"
        code="$(cloudflare_error_code "$body_file")"
        problem="$(response_problem "$status" "$worker" "$body_file" "$code")"
        retryable=0
        if [[ -n "$problem" ]] && is_transient_response "$status" "$code"; then
            retryable=1
        fi
        ready=0
        if [[ -z "$problem" ]]; then
            ready=1
        fi

        record_attempt "$history_file" "$attempt" "$elapsed" "$status" "$code" \
            "$retryable" "$ready" "$problem"
        printf 'edge readiness: attempt %d after %sms: %s\n' \
            "$attempt" "$elapsed" \
            "${problem:-HTTP 200 and the deployed application}"

        if (( ready == 1 )); then
            break
        fi
        if (( elapsed >= timeout_ms )); then
            timed_out=1
            break
        fi
        sleep "$interval"
    done

    elapsed="$(( $(now_ms) - started_ms ))"
    cp "$body_file" "$out_dir/page.html" 2>/dev/null || : >"$out_dir/page.html"

    write_readiness_report "$out_dir" "$url" "$worker" "$timeout_ms" "$interval" \
        "$started_at" "$elapsed" "$ready" "$timed_out" "$status" 0 \
        "$history_file"

    local final_problem
    final_problem="$(response_problem "$status" "$worker" "$out_dir/page.html" \
        "$code")"

    rm -rf "$work_dir"

    if (( ready == 1 )); then
        printf 'edge readiness: ready after %sms (%d attempt(s)) at %s\n' \
            "$elapsed" "$attempt" "$url"
        return 0
    fi

    printf 'edge readiness: NOT READY after %sms (%d attempt(s)); final response: %s\n' \
        "$elapsed" "$attempt" "$final_problem" >&2
    printf 'edge readiness: attempt history written to %s/edge-readiness.json\n' \
        "$out_dir" >&2
    return 1
}

main() {
    set -uo pipefail

    local url="" worker="" out_dir=""
    local timeout_ms="$EDGE_READINESS_DEFAULT_TIMEOUT_MS"
    local interval="$EDGE_READINESS_DEFAULT_INTERVAL"

    while (( $# > 0 )); do
        case "$1" in
            --help | -h)
                usage
                return 0
                ;;
            --url | --worker | --out | --timeout-ms | --interval)
                if (( $# < 2 )); then
                    printf 'ERROR: %s requires a value\n' "$1" >&2
                    usage >&2
                    return 2
                fi
                case "$1" in
                    --url) url="$2" ;;
                    --worker) worker="$2" ;;
                    --out) out_dir="$2" ;;
                    --timeout-ms) timeout_ms="$2" ;;
                    --interval) interval="$2" ;;
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

    local missing=""
    [[ -n "$url" ]] || missing="$missing --url"
    [[ -n "$worker" ]] || missing="$missing --worker"
    [[ -n "$out_dir" ]] || missing="$missing --out"
    if [[ -n "$missing" ]]; then
        printf 'ERROR: missing required argument(s):%s\n' "$missing" >&2
        usage >&2
        return 2
    fi
    if [[ ! "$timeout_ms" =~ ^[0-9]+$ ]]; then
        printf 'ERROR: --timeout-ms must be a whole number of milliseconds\n' >&2
        return 2
    fi
    if [[ ! "$interval" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
        printf 'ERROR: --interval must be a number of seconds\n' >&2
        return 2
    fi
    if [[ "$interval" =~ ^0*([.]0*)?$ ]]; then
        printf 'ERROR: --interval must be greater than zero\n' >&2
        return 2
    fi
    if ! command -v curl >/dev/null 2>&1; then
        printf 'ERROR: curl is required to poll the published Worker\n' >&2
        return 2
    fi

    poll_edge_readiness "$url" "$worker" "$out_dir" "$timeout_ms" "$interval"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
