#!/bin/sh
# Valida o nginx de verdade (try_files, cache, 404 para o que não é público): build da imagem, container, curl, limpeza.
# uso: sh tests/docker-nginx.sh            (porta NGINX_PORT, padrão 4312)
#      RUN_PLAYWRIGHT=1 sh tests/docker-nginx.sh   (roda também a suíte Playwright contra o container; PW_CHROME_PATH opcional)
set -eu
ROOT="$(dirname "$(dirname "$(realpath "$0")")")"
IMAGE=buscalead-docs-test
NAME=buscalead-docs-test
PORT="${NGINX_PORT:-4312}"
BASE="http://127.0.0.1:$PORT"
fail=0

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -q -t "$IMAGE" "$ROOT" >/dev/null
cleanup
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:80" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do curl -fs -o /dev/null "$BASE/" && break; sleep 0.25; done

status() { # caminho esperado
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$1")
    if [ "$code" = "$2" ]; then echo "ok    $1 -> $code"; else echo "FALHA $1 -> $code (esperado $2)"; fail=1; fi
}
header() { # caminho regex-do-header (case-insensitive)
    if curl -s -D - -o /dev/null "$BASE$1" | tr -d '\r' | grep -Eiq "$2"; then echo "ok    $1 tem $2"; else echo "FALHA $1 sem $2"; fail=1; fi
}

for p in / /index.html /docs /docs.html /contratacao/sucesso /contratacao/cancelada /contratacao/expirada \
         /assets/site.js /assets/site.css /assets/favicon.svg /assets/og-api.png; do status "$p" 200; done
# só o site público vai para a imagem: nada de config, testes, git ou package.json
for p in /nginx.conf /Dockerfile /package.json /package-lock.json /playwright.config.ts /tests/portal.spec.ts /node_modules/@playwright/test/package.json /test-results/index-375.png /PLAN-D-REPORT.md /.git /.git/config /.dockerignore /nao-existe /contratacao/nao-existe; do status "$p" 404; done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/contratacao/")
if [ "$code" != "200" ]; then echo "ok    /contratacao/ -> $code (sem listagem)"; else echo "FALHA /contratacao/ lista o diretório"; fail=1; fi

header /docs '^cache-control: max-age=300'
header /contratacao/sucesso '^cache-control: max-age=300'
header /assets/og-api.png '^cache-control: max-age=2592000'
header /assets/site.js '^cache-control: no-cache'
header /assets/site.css '^cache-control: no-cache'
header / '^content-type: text/html; charset=utf-8'
header /docs '^x-content-type-options: nosniff'
if curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' "$BASE/assets/site.js" | tr -d '\r' | grep -iq '^content-encoding: gzip'; then echo "ok    gzip em /assets/site.js"; else echo "FALHA sem gzip em /assets/site.js"; fail=1; fi
if curl -s "$BASE/docs" | grep -q 'id="busca"'; then echo "ok    /docs serve o conteúdo da documentação"; else echo "FALHA /docs sem conteúdo"; fail=1; fi

if [ "${RUN_PLAYWRIGHT:-0}" = "1" ]; then
    env -C "$ROOT" PW_BASE_URL="$BASE" node_modules/.bin/playwright test --reporter=list || fail=1
fi

if [ "$fail" = "0" ]; then echo "nginx: tudo certo"; else echo "nginx: ha falhas"; exit 1; fi
