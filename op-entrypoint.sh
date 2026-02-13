#!/bin/sh
set -eu

TOKEN_FILE="/run/secrets/op_service_account_token"

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  if [ ! -f "$TOKEN_FILE" ]; then
    echo "OP_SERVICE_ACCOUNT_TOKEN not set and $TOKEN_FILE not found." >&2
    exit 1
  fi
  OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
  export OP_SERVICE_ACCOUNT_TOKEN
fi

exec op run -- "$@"
