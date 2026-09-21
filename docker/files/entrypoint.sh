#!/bin/sh
set -eu
DB=/database/filebrowser.db
if [ ! -f "$DB" ]; then
  filebrowser -d "$DB" config init
fi
filebrowser -d "$DB" config set --auth.method=proxy --auth.header=X-Remote-User --root=/srv --address=0.0.0.0 --port=8080 --baseURL="${KKSS_BASE_PATH:-}/files" --disableExec=true --followExternalSymlinks=false --perm.execute=false --perm.share=false --perm.admin=false
exec filebrowser -d "$DB" --disableExec=true --followExternalSymlinks=false
