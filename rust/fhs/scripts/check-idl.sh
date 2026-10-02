#!/bin/sh
set -eu

canonical="${GALAXIA_CANONICAL_IDL:-${GALAXIA_ROOT:-../../../galaxIA}/idl/fhs-protocol.proto}"
if test -f "$canonical"; then
  cmp -s "$canonical" proto/fhs-protocol.proto || {
    echo "proto/fhs-protocol.proto no coincide con el IDL canónico: $canonical" >&2
    exit 1
  }
  cmp -s "$(dirname "$canonical")/command-capabilities.json" proto/command-capabilities.json || {
    echo "proto/command-capabilities.json no coincide con el registro canónico" >&2
    exit 1
  }
  echo "FHS IDL: OK (comparación con canonical)"
else
  test -f proto/fhs-protocol.proto.sha256
  sha256sum -c proto/fhs-protocol.proto.sha256 2>/dev/null || shasum -a 256 -c proto/fhs-protocol.proto.sha256
  echo "FHS IDL: OK (hash de snapshot canónico)"
fi
