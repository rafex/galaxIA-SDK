#!/bin/sh
set -eu

cert_dir=/etc/nginx/certs
key_path="$cert_dir/curp-web.key"
cert_path="$cert_dir/curp-web.crt"
mkdir -p "$cert_dir"

if [ -s "$key_path" ] && [ -s "$cert_path" ]; then
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 \
  -days "${CURP_CERT_DAYS:-365}" \
  -keyout "$key_path" \
  -out "$cert_path" \
  -subj "/CN=${CURP_CERT_CN}" \
  -addext "subjectAltName=${CURP_CERT_SAN}"
chmod 0600 "$key_path"
