#!/bin/sh
set -eu

# Private keys are created on the installation, never in a published image.
directory=/etc/nginx/certs
if [ -s "$directory/youplayer.key" ] && [ -s "$directory/youplayer.crt" ]; then
    exit 0
fi
umask 077
mkdir -p "$directory"
temporary=$(mktemp -d "$directory/.generate.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$temporary/youplayer.key" \
    -out "$temporary/youplayer.crt" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
mv "$temporary/youplayer.key" "$directory/youplayer.key"
mv "$temporary/youplayer.crt" "$directory/youplayer.crt"
