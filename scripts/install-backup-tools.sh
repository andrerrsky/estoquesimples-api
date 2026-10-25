#!/usr/bin/env bash
# Ferramentas do backup externo no runner do GitHub: cliente do Postgres 16
# (precisa acompanhar o servidor; pg_restore antigo recusa dump novo), age e
# rclone. O rclone vem do release oficial fixado, com o SHA-256 conferido: o
# pacote do Ubuntu é antigo para --s3-version-at/--b2-version-at e para
# enviar a buckets com Object Lock (Content-MD5).
set -euo pipefail

RCLONE_VERSION="v1.75.1"
RCLONE_SHA256="982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab"

sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql-client-16 age jq

tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/rclone.zip" "https://github.com/rclone/rclone/releases/download/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-amd64.zip"
echo "${RCLONE_SHA256}  $tmp/rclone.zip" | sha256sum -c -
unzip -q "$tmp/rclone.zip" -d "$tmp"
sudo install -m 0755 "$tmp/rclone-${RCLONE_VERSION}-linux-amd64/rclone" /usr/local/bin/rclone
rm -rf "$tmp"
rclone version | head -1
