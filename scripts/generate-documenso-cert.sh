#!/usr/bin/env bash
set -euo pipefail

# SPEC-029 helper for the self-hosted Documenso deployment.
# Based on /opt/apps/Perri/documenso/documenso/SIGNING.md and Documenso's
# self-hosted local signing-certificate docs. Generates a password-protected
# PKCS#12 certificate for NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH.

usage() {
  cat <<'USAGE'
Usage: scripts/generate-documenso-cert.sh [--force]

Environment:
  NEXT_PRIVATE_SIGNING_PASSPHRASE  Required passphrase for cert.p12. If unset,
                                   the script prompts securely.
  DOCUMENSO_CERT_PATH              Output path. Defaults to /opt/documenso/cert.p12.
  DOCUMENSO_CERT_DAYS              Validity period. Defaults to 3650.
  DOCUMENSO_CERT_SUBJECT           OpenSSL subject. Defaults to Fantasy Caravan.

The default output path normally requires sudo:
  sudo --preserve-env=NEXT_PRIVATE_SIGNING_PASSPHRASE ./scripts/generate-documenso-cert.sh
USAGE
}

force=false
case "${1:-}" in
  "")
    ;;
  "--force")
    force=true
    ;;
  "-h" | "--help")
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but was not found on PATH." >&2
  exit 1
fi

cert_path="${DOCUMENSO_CERT_PATH:-/opt/documenso/cert.p12}"
cert_days="${DOCUMENSO_CERT_DAYS:-3650}"
cert_subject="${DOCUMENSO_CERT_SUBJECT:-/C=AU/ST=Victoria/L=Melbourne/O=Fantasy Caravan/OU=Fantasy ERP/CN=Fantasy Caravan Documenso Signing}"

if [[ -e "$cert_path" && "$force" != "true" ]]; then
  echo "$cert_path already exists. Re-run with --force to replace it." >&2
  exit 1
fi

if [[ -z "${NEXT_PRIVATE_SIGNING_PASSPHRASE:-}" ]]; then
  read -r -s -p "NEXT_PRIVATE_SIGNING_PASSPHRASE: " cert_passphrase
  echo
  read -r -s -p "Confirm NEXT_PRIVATE_SIGNING_PASSPHRASE: " cert_passphrase_confirm
  echo

  if [[ "$cert_passphrase" != "$cert_passphrase_confirm" ]]; then
    echo "Passphrases did not match." >&2
    exit 1
  fi

  if [[ -z "$cert_passphrase" ]]; then
    echo "NEXT_PRIVATE_SIGNING_PASSPHRASE cannot be empty." >&2
    exit 1
  fi

  export NEXT_PRIVATE_SIGNING_PASSPHRASE="$cert_passphrase"
  unset cert_passphrase cert_passphrase_confirm
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

umask 077

openssl genrsa -out "$tmpdir/private.key" 2048
openssl req \
  -new \
  -x509 \
  -key "$tmpdir/private.key" \
  -out "$tmpdir/certificate.crt" \
  -days "$cert_days" \
  -subj "$cert_subject"
openssl pkcs12 \
  -export \
  -out "$tmpdir/cert.p12" \
  -inkey "$tmpdir/private.key" \
  -in "$tmpdir/certificate.crt" \
  -password env:NEXT_PRIVATE_SIGNING_PASSPHRASE

mkdir -p "$(dirname "$cert_path")"
install -m 0400 "$tmpdir/cert.p12" "$cert_path"

if chown 1001:1001 "$cert_path" 2>/dev/null; then
  chmod 0400 "$cert_path"
  ownership_note="owner set to uid/gid 1001 for the Documenso container"
else
  ownership_note="owner unchanged; run 'sudo chown 1001:1001 $cert_path && sudo chmod 0400 $cert_path' before starting Documenso if the container cannot read it"
fi

echo "Generated $cert_path ($ownership_note)."
echo "Set these Documenso env vars:"
echo "  NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH=$cert_path"
echo "  NEXT_PRIVATE_SIGNING_PASSPHRASE=<the passphrase used above>"
