#!/usr/bin/env bash
# Backup externo do Estoque Simples, em fases (uma por passo do workflow, cada
# uma só com as credenciais de que precisa). Usado por
# .github/workflows/backup-offsite.yml (produção, toda noite) e por
# .github/workflows/backup-offsite-test.yml (CI, contra um S3 local), que exercita
# todas as fases e as travas.
#
#   scripts/backup-offsite.sh <fase>
#
# Fases e variáveis:
#   check     BACKUP_DATABASE_URL, AGE_RECIPIENT, DUMPS_REMOTE, IMAGES_SOURCE, IMAGES_DEST
#             (ALLOW_INSECURE_DB=1 só no teste, onde o Postgres local não tem TLS)
#   dump      BACKUP_DATABASE_URL                       -> $WORKDIR/backup.dump
#   verify    DESTINO                                   -> $WORKDIR/verificacao.json
#   upload    AGE_RECIPIENT, DUMPS_REMOTE (+ RCLONE_CONFIG_* do remoto dos dumps) -> $WORKDIR/envio.json
#   photos    IMAGES_SOURCE, IMAGES_DEST, VERSIONING_CONFIRMED, MAX_DELETE (+ RCLONE_CONFIG_*) -> $WORKDIR/fotos.json
#   register  API_BASE_URL, OPS_BACKUP_TOKEN
#   finish    falha se a produção está atrás do repositório (o backup já foi guardado)
#   cleanup   apaga as cópias locais
#
# Remotos do rclone no formato "remoto:bucket" (DUMPS_REMOTE, IMAGES_SOURCE,
# IMAGES_DEST), configurados por variáveis RCLONE_CONFIG_<REMOTO>_*.
set -euo pipefail
umask 077

WORKDIR="${WORKDIR:-$PWD/.backup-offsite}"
mkdir -p "$WORKDIR"
fase="${1:-}"

erro() {
  echo "::error::$*" >&2
  exit 1
}

precisa() {
  local faltando=""
  for nome in "$@"; do
    [ -n "${!nome:-}" ] || faltando="$faltando $nome"
  done
  [ -z "$faltando" ] || erro "Variáveis ausentes:$faltando"
}

case "$fase" in
  check)
    precisa BACKUP_DATABASE_URL AGE_RECIPIENT DUMPS_REMOTE IMAGES_SOURCE IMAGES_DEST
    # "remoto:bucket" completo: um segredo de bucket vazio deixaria só "remoto:".
    for nome in DUMPS_REMOTE IMAGES_SOURCE IMAGES_DEST; do
      [[ "${!nome}" =~ ^[a-z0-9]+:[A-Za-z0-9._-]+$ ]] || erro "$nome precisa ser remoto:bucket (recebido: '${!nome}')"
    done
    if [ "${ALLOW_INSECURE_DB:-}" != "1" ]; then
      # O banco é alcançado pelo proxy público do Railway: TLS obrigatório.
      case "$BACKUP_DATABASE_URL" in
        *sslmode=require* | *sslmode=verify-full* | *sslmode=verify-ca*) ;;
        *) erro "BACKUP_DATABASE_URL precisa terminar em ?sslmode=require (ou verify-full)" ;;
      esac
    fi
    ;;

  dump)
    precisa BACKUP_DATABASE_URL
    pg_dump --format=custom --no-owner --file="$WORKDIR/backup.dump" "$BACKUP_DATABASE_URL"
    ls -l "$WORKDIR/backup.dump"
    ;;

  verify)
    # Backup que nunca foi restaurado é suposição: o dump só segue depois de
    # restaurado e conferido. --schema-atras-ok: com uma migration já no
    # repositório e o deploy pendente, o dump (estado real) ainda é guardado.
    precisa DESTINO
    npm run backup:verify --workspace @estoquesimples/api -- \
      --dump "$WORKDIR/backup.dump" --target "$DESTINO" \
      --report-file "$WORKDIR/verificacao.json" --schema-atras-ok
    ;;

  upload)
    precisa AGE_RECIPIENT DUMPS_REMOTE
    stamp="$(date -u +%Y/%m/%d/estoquesimples-%Y%m%dT%H%M%SZ)"
    age --recipient "$AGE_RECIPIENT" --output "$WORKDIR/backup.dump.age" "$WORKDIR/backup.dump"
    sha="$(sha256sum "$WORKDIR/backup.dump.age" | cut -d' ' -f1)"
    echo "$sha" > "$WORKDIR/backup.dump.age.sha256"
    objeto="db/$stamp.dump.age"
    rclone copyto "$WORKDIR/backup.dump.age" "$DUMPS_REMOTE/$objeto" --s3-no-check-bucket
    rclone copyto "$WORKDIR/backup.dump.age.sha256" "$DUMPS_REMOTE/$objeto.sha256" --s3-no-check-bucket
    # Confere que o objeto chegou inteiro (hash calculado de volta, do bucket).
    remoto="$(rclone cat "$DUMPS_REMOTE/$objeto" | sha256sum | cut -d' ' -f1)"
    [ "$remoto" = "$sha" ] || erro "O arquivo no bucket não confere com o enviado"
    jq -n --arg objeto "$objeto" --arg sha "$sha" '{objeto: $objeto, sha256: $sha}' > "$WORKDIR/envio.json"
    # Fica no log do GitHub, fora do banco de produção: na restauração, é com
    # ele que se reconhece o dump verdadeiro (ver docs/seguranca.md, passo 2).
    echo "Enviado: $objeto"
    echo "SHA-256: $sha"
    ;;

  photos)
    # Espelho das fotos num bucket com versionamento: foto apagada na origem
    # vira versão antiga no destino e fica pelo prazo da regra do bucket. Só
    # roda se o destino guarda versões (senão apagaria a cópia de verdade) e
    # se a origem não está vazia (bucket errado ou esvaziado por alguém).
    precisa IMAGES_SOURCE IMAGES_DEST
    # O rclone responde em JSON (`"Enabled"`): tira aspas e espaços antes de comparar.
    versioning="$(rclone backend versioning "$IMAGES_DEST" 2>/dev/null | tr -d '"[:space:]' || true)"
    if [ "$versioning" != "Enabled" ] && [ "${VERSIONING_CONFIRMED:-}" != "true" ]; then
      erro "O bucket da cópia das fotos não informa versionamento ativo (${versioning:-sem resposta}). Ative o versionamento (no B2, Object Lock) ou, se o provedor não informa, defina BACKUP_IMAGES_VERSIONING_CONFIRMED=true."
    fi
    total="$(rclone size "$IMAGES_SOURCE" --json | jq '.count')"
    [ "${total:-0}" -gt 0 ] || erro "O bucket das fotos está vazio; espelho não executado."
    # Mais exclusões que MAX_DELETE numa noite não é rotina: o rclone para e o job falha.
    rclone sync "$IMAGES_SOURCE" "$IMAGES_DEST" --s3-no-check-bucket --transfers 8 \
      --max-delete "${MAX_DELETE:-200}" --stats-one-line --stats 60s
    jq -n --argjson fotos "$total" '{fotos: $fotos}' > "$WORKDIR/fotos.json"
    ;;

  register)
    # Só agora: banco restaurado e conferido, dump cifrado no bucket e
    # conferido, fotos espelhadas. É isto que zera o alerta backup_desatualizado.
    precisa API_BASE_URL OPS_BACKUP_TOKEN
    for arquivo in verificacao envio fotos; do
      [ -s "$WORKDIR/$arquivo.json" ] || erro "Falta $arquivo.json: alguma fase anterior não terminou."
    done
    body="$(jq -c -s '{origem: "backup-offsite"} + .[0] + .[1] + .[2] | {origem, tabelas, registros, duracaoSegundos, migracao, schemaAtras, migracoesAtras, schemaAFrente, migracoesAFrente, objeto, sha256, fotos}' \
      "$WORKDIR/verificacao.json" "$WORKDIR/envio.json" "$WORKDIR/fotos.json")"
    curl -fsS -X POST "$API_BASE_URL/ops/backup" \
      -H "authorization: Bearer $OPS_BACKUP_TOKEN" -H 'content-type: application/json' --data "$body"
    echo
    ;;

  finish)
    if [ "$(jq -r '.schemaAFrente' "$WORKDIR/verificacao.json")" = "true" ]; then
      erro "O banco de produção está $(jq -r '.migracoesAFrente' "$WORKDIR/verificacao.json") migration(s) à frente do repositório (deploy de outra branch, revert no main ou banco errado). Backup guardado; confira."
    fi
    if [ "$(jq -r '.schemaAtras' "$WORKDIR/verificacao.json")" = "true" ]; then
      erro "O banco de produção está $(jq -r '.migracoesAtras' "$WORKDIR/verificacao.json") migration(s) atrás do repositório. Backup guardado; confira o deploy no Railway."
    fi
    ;;

  cleanup)
    rm -rf "$WORKDIR"
    ;;

  *)
    erro "Fase desconhecida: '$fase' (use check, dump, verify, upload, photos, register, finish ou cleanup)"
    ;;
esac
