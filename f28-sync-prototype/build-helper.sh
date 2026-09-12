#!/bin/sh
set -eu
output=${1:-/tmp/f28-filesystem-helper-x86_64}
flags="-std=c17 -Wall -Wextra -Werror -Wconversion -Wshadow -arch x86_64 -mmacosx-version-min=14"
if [ "${F28_SANITIZE:-0}" = 1 ]; then
  flags="$flags -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer"
else
  flags="$flags -O2"
fi
# shellcheck disable=SC2086
xcrun clang $flags f28-sync-prototype/native/filesystem_helper.c -o "$output"
file "$output"
