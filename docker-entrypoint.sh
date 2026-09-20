#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIRECTORY}"
  chown node:node "${DATA_DIRECTORY}"
  exec gosu node "$@"
fi

exec "$@"
