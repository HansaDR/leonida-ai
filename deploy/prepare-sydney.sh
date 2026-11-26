#!/usr/bin/env bash
set -euo pipefail
stage=$1
original=/home/ubuntu/leonida-ai
target=/opt/leonida
state=/var/lib/leonida
config=/etc/leonida

for path in "$target" "$state" "$config" /etc/systemd/system/leonida.service; do
    if [[ -e "$path" ]]; then
        printf 'Refusing to overwrite existing install at %s\n' "$path" >&2
        exit 1
    fi
done
if ! getent passwd leonida >/dev/null; then
    useradd --system --user-group --home-dir "$state" --shell /usr/sbin/nologin leonida
fi
install -d -m 0755 "$target/v05" "$target/data" "$target/tiles"
install -d -m 0700 -o leonida -g leonida "$state"
install -d -m 0700 "$config"
cp -r "$stage"/{app.py,catalog.py,store.py,psn.py,psn_worker.mjs,static,package.json,package-lock.json,node_modules} "$target/v05/"
install -m 0755 "$stage/deploy/provision-psn.sh" "$target/v05/provision-psn.sh"
chown -R root:root "$target/v05"
chmod -R go-w "$target/v05"
install -m 0644 "$original"/data/*.json "$target/data/"
for manifest in story-milestones.json verified-availability.json reviewed-locations.json mission-guides.json; do
    if [[ -f "$stage/data/$manifest" ]]; then
        install -m 0644 "$stage/data/$manifest" "$target/data/"
    fi
done
cp -r "$original/gtadb-source/maps/tiles/6/day/"[0-6] "$target/tiles/"
install -m 0644 "$original/gtadb-source/LICENSE-DATA" "$target/GTADB-LICENSE-DATA"
python3 - "$original/preview.sqlite3" "$state/progress.sqlite3" <<'PY'
import sqlite3, sys
from pathlib import Path

with sqlite3.connect(Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as destination:
        source.backup(destination)
        if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Original database backup did not pass verification")
        assert source.execute("SELECT * FROM found ORDER BY id").fetchall() == destination.execute("SELECT * FROM found ORDER BY id").fetchall()
PY
chown leonida:leonida "$state/progress.sqlite3"
chmod 0600 "$state/progress.sqlite3"
(
    cd "$target/v05"
    sudo -u leonida /usr/bin/python3 -B -c 'from store import Store; Store("/var/lib/leonida/progress.sqlite3").migrate()'
)
umask 077
python3 -c 'import secrets; print(secrets.token_urlsafe(36))' > "$config/http-password"
install -m 0644 "$stage"/deploy/leonida{.service,-backup.service,-backup.timer} /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/leonida{.service,-backup.service,-backup.timer}
systemctl daemon-reload
systemctl enable --now leonida.service leonida-backup.timer
systemctl start leonida-backup.service
