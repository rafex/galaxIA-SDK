#!/bin/sh
# Certificado autofirmado de la página. Se reutiliza el que exista en el volumen
# (el SAN debe cubrir la IP desde la que el teléfono abre la página).
set -eu

cert_dir=/etc/nginx/certs
key_path="$cert_dir/satellite-web.key"
cert_path="$cert_dir/satellite-web.crt"
mkdir -p "$cert_dir"

if [ -s "$key_path" ] && [ -s "$cert_path" ]; then
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 \
  -days "${SATELLITE_CERT_DAYS:-365}" \
  -keyout "$key_path" \
  -out "$cert_path" \
  -subj "/CN=${SATELLITE_CERT_CN}" \
  -addext "subjectAltName=${SATELLITE_CERT_SAN}"
chmod 0600 "$key_path"
