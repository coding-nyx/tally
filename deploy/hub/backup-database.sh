#!/bin/sh
# Explicit local recovery backup. Off-device encrypted backups remain deferred.
set -eu
umask 077
backup_dir="${TALLY_DATABASE_ROOT:-$HOME/tally/database}/backups"
mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_dir/tally-$stamp.dump"
temporary="$destination.partial"
trap 'rm -f "$temporary"' EXIT
docker exec tally-database-1 pg_dump -U tally_admin -d tally -Fc > "$temporary"
docker exec -i tally-database-1 pg_restore --list < "$temporary" >/dev/null
mv "$temporary" "$destination"
sync -f "$destination"
printf 'Local recovery backup created: %s\n' "$destination"
