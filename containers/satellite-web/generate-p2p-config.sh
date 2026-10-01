#!/bin/sh
# Escribe /p2p-config.json desde FHS_BOOTSTRAP_ADDRS y falla el arranque si el
# valor no es una lista de multiaddrs /…/tcp/<puerto>/tls/ws[/p2p/<PeerId>].
set -eu

config_path=/usr/share/nginx/html/p2p-config.json
bootstrap_addrs=$(printf '%s' "${FHS_BOOTSTRAP_ADDRS:-}" | tr '\n' ',' | tr -d ' ')

if [ -z "$bootstrap_addrs" ]; then
  echo "FHS_BOOTSTRAP_ADDRS es obligatorio" >&2
  exit 1
fi

old_ifs=$IFS
IFS=','
for addr in $bootstrap_addrs; do
  [ -n "$addr" ] || continue
  if ! printf '%s' "$addr" | grep -Eq '^/(ip4|ip6|dns4|dns6|dns)/[A-Za-z0-9.:-]+/tcp/[0-9]{1,5}/tls/ws(/p2p/[A-Za-z0-9]+)?$'; then
    echo "FHS_BOOTSTRAP_ADDRS: dirección inválida: $addr" >&2
    exit 1
  fi
done
IFS=$old_ifs

printf '{"bootstrapAddrs":"%s"}\n' "$bootstrap_addrs" > "$config_path"

# CSP: orígenes WSS que el navegador puede abrir (Atlas y Navigator). Sin
# SATELLITE_CONNECT_SRC explícito se derivan de los bootstrap (wss://host:puerto).
connect_src=${SATELLITE_CONNECT_SRC:-}
if [ -z "$connect_src" ]; then
  connect_src=$(printf '%s' "$bootstrap_addrs" | tr ',' '\n' \
    | sed -E 's#^/(ip4|ip6|dns4|dns6|dns)/([^/]+)/tcp/([0-9]+)/tls/ws.*#wss://\2:\3#' | tr '\n' ' ')
fi
# El Navigator vive en el mismo host que Atlas, en :4010.
case "$connect_src" in
  *:4001*) connect_src="$connect_src $(printf '%s' "$connect_src" | sed -E 's#:4001#:4010#g')" ;;
esac
case "$connect_src" in
  *[!A-Za-z0-9:./\ -]*) echo "SATELLITE_CONNECT_SRC contiene caracteres no permitidos" >&2; exit 1 ;;
esac
sed "s#@CONNECT_SRC@#$connect_src#" /etc/nginx/satellite.conf.template > /etc/nginx/conf.d/satellite.conf
