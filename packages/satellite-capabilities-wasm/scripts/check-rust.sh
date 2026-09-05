#!/bin/sh
set -eu

if command -v rustup >/dev/null 2>&1; then
  rustup target add wasm32-unknown-unknown >/dev/null
  rust_bin_dir=$(dirname "$(rustup which cargo)")
  PATH="$rust_bin_dir:$PATH"
  export PATH
fi

exec cargo check --target wasm32-unknown-unknown
