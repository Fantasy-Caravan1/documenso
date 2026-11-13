#!/usr/bin/env bash
# The half of deployment/deploy.sh that runs on the host. It is piped in over
# ssh (`bash -s`), so no copy of it lives there to go stale, and it takes all of
# its settings from the environment deploy.sh puts in front of it. Not meant to
# be run by hand.
#
#   MODE=preflight  checks only; changes nothing.
#   MODE=release    the same checks, then:
#                     1. the new image is here and carries the commit's label
#                     2. rollback point: the RUNNING container's image, tagged
#                        documenso-fantasy:predeploy-<sha>
#                     3. pg_dump of the database container, gzipped, mode 600
#                     4. the new image takes the tag compose.yml names
#                     5. migration preview (prisma migrate status, new image)
#                     6. `up -d --no-deps --force-recreate documenso`
#                     7. health: /api/health, /api/certificate-status, and the
#                        container really runs the new image id
#                     8. on failure, roll back to the predeploy image
#                     9. on success, predeploy becomes :rollback, then cleanup
#
# What it never does: `docker compose down`, anything to the `database`
# service or its volume, `docker image prune`. The compose project's name, its
# network and the app container's name are relied on by the ERP (it joins
# documenso-production_default as an external network and calls the container
# by name), so the app service is only ever recreated in place.
#
# The whole script is one function called on the last line, so bash has read
# every line of it from the ssh pipe before the first command runs.

set -euo pipefail

main() {
  : "${MODE:?}" "${SHA:?}" "${FULL_SHA:?}" "${REMOTE_DIR:?}" "${COMPOSE_FILE:?}" "${ENV_FILE:?}" "${BACKUP_DIR:?}"
  VERSION="${VERSION:-$SHA}"
  BACKUP_KEEP="${BACKUP_KEEP:-5}"
  MIN_FREE_GB="${MIN_FREE_GB:-8}"
  APP_PORT="${APP_PORT:-3010}"
  HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
  HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
  MIGRATION_PREVIEW="${MIGRATION_PREVIEW:-1}"

  APP_IMAGE=documenso-fantasy
  APP_SERVICE=documenso
  DB_SERVICE=database
  BASE_URL="http://127.0.0.1:${APP_PORT}"
  NEW_REF="$APP_IMAGE:$SHA"

  case "$MODE" in
    preflight) preflight; echo "  -- preflight passed" ;;
    release) preflight; release ;;
    *) echo "BLOCKED: MODE must be preflight or release, not '$MODE'." >&2; exit 1 ;;
  esac
}

say() { printf '  -- %s\n' "$1"; }
blocked() { echo "BLOCKED: $1" >&2; exit 1; }

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Everything that can stop a release, checked without changing anything.
preflight() {
  [ -d "$REMOTE_DIR" ] || blocked "$REMOTE_DIR does not exist on this host."
  cd "$REMOTE_DIR"
  [ -f "$COMPOSE_FILE" ] || blocked "$REMOTE_DIR/$COMPOSE_FILE does not exist."
  [ -f "$ENV_FILE" ] || blocked "$REMOTE_DIR/$ENV_FILE does not exist. It is kept by hand on the host and never shipped."
  docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || blocked "docker is not usable on this host by this user."

  APP_CID="$(compose ps -q --status running "$APP_SERVICE" 2>/dev/null || true)"
  DB_CID="$(compose ps -q --status running "$DB_SERVICE" 2>/dev/null || true)"
  [ -n "$APP_CID" ] && [ "$(printf '%s\n' "$APP_CID" | wc -l | tr -d ' ')" = 1 ] \
    || blocked "the '$APP_SERVICE' service is not running exactly one container. A release replaces a running service; it does not start a stopped one."
  [ -n "$DB_CID" ] && [ "$(printf '%s\n' "$DB_CID" | wc -l | tr -d ' ')" = 1 ] \
    || blocked "the '$DB_SERVICE' service is not running. Nothing is released without a database to back up."

  # The tag compose.yml names, read from the running container: that is the
  # reference `up` will resolve, and the one a new image has to take.
  LIVE_REF="$(docker inspect -f '{{.Config.Image}}' "$APP_CID")"
  LIVE_ID="$(docker inspect -f '{{.Image}}' "$APP_CID")"
  local ref_format="^$APP_IMAGE:[A-Za-z0-9_][A-Za-z0-9_.-]*\$"
  if ! [[ "$LIVE_REF" =~ $ref_format ]] || [ "$LIVE_REF" = "$APP_IMAGE:rollback" ] \
      || [ "${LIVE_REF#"$APP_IMAGE":predeploy-}" != "$LIVE_REF" ]; then
    blocked "the running '$APP_SERVICE' container was started from '$LIVE_REF', not a fixed $APP_IMAGE:<tag> reference. This flow retags that reference; it cannot retag a digest or another name."
  fi
  # grep without -q reads to the end: an early exit would SIGPIPE compose, and
  # pipefail would call that a mismatch.
  if ! compose config --images 2>/dev/null | grep -xF "$LIVE_REF" >/dev/null; then
    blocked "$COMPOSE_FILE no longer names $LIVE_REF, the image the running container was started from. Someone changed the compose file since; settle that by hand first."
  fi

  local docker_root free_gb
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)"
  [ -d "$docker_root" ] || docker_root=/
  free_gb="$(df -BG --output=avail "$docker_root" | tail -n1 | tr -dc '0-9')"
  if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
    echo "BLOCKED: only ${free_gb:-0}G free under $docker_root; need ${MIN_FREE_GB}G (MIN_FREE_GB)." >&2
    echo "  Reclaim with: docker builder prune -af   (touches no images)" >&2
    exit 1
  fi

  ( umask 077 && mkdir -p "$BACKUP_DIR" ) 2>/dev/null || blocked "cannot create the backup directory $BACKUP_DIR."
  [ -w "$BACKUP_DIR" ] || blocked "the backup directory $BACKUP_DIR is not writable by $(id -un)."

  say "compose project ok: $APP_SERVICE runs $LIVE_REF (${LIVE_ID#sha256:}), $DB_SERVICE running"
  say "${free_gb}G free under $docker_root; backups go to $BACKUP_DIR"
}

image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

# A first-matching "status" is the top-level one: /api/health returns
# {"status":…,"timestamp":…,"checks":{…}}.
health_status() {
  printf '%s' "$1" | { grep -o '"status"[[:space:]]*:[[:space:]]*"[a-z]*"' || true; } \
    | sed -n '1s/.*"\([a-z]*\)"$/\1/p'
}

cert_available() {
  local body
  body="$(curl -s --max-time 10 "$BASE_URL/api/certificate-status" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"isAvailable"[[:space:]]*:[[:space:]]*true'; then
    echo yes
  elif printf '%s' "$body" | grep -q '"isAvailable"[[:space:]]*:[[:space:]]*false'; then
    echo no
  else
    echo unknown
  fi
}

# prisma migrate status from a one-off container of the service, which the tag
# move has just pointed at the new image. Bounded, where `timeout` exists.
migration_status() {
  set -- run --rm --no-deps -T "$APP_SERVICE" \
    npx prisma migrate status --schema ../../packages/prisma/schema.prisma
  if command -v timeout >/dev/null 2>&1; then
    timeout 180 docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    compose "$@"
  fi
}

# Recreate the app service from whatever image the compose tag names now.
recreate_app() {
  compose up -d --no-deps --force-recreate "$APP_SERVICE"
}

# Waits until the app answers /api/health with 200 and a status other than
# "error", and the container is the one running $1 (an image id).
wait_healthy() {
  local want_id="$1" i cid running code body status
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    cid="$(compose ps -q "$APP_SERVICE" 2>/dev/null || true)"
    running="$( [ -n "$cid" ] && docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
    body="$(curl -s --max-time 10 -w '\n%{http_code}' "$BASE_URL/api/health" 2>/dev/null || true)"
    code="$(printf '%s' "$body" | tail -n1)"
    status="$(health_status "$(printf '%s' "$body" | sed '$d')")"
    if [ "$running" = "$want_id" ] && [ "$code" = 200 ] && [ -n "$status" ] && [ "$status" != error ]; then
      say "healthy: HTTP 200, status $status, running ${want_id#sha256:}"
      return 0
    fi
    say "attempt $i/$HEALTH_RETRIES: HTTP ${code:-000}, status ${status:-none}, running ${running#sha256:}"
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# Set as the release goes, read by the exit trap.
TAG_MOVED=0
SWITCHED=0
FINISHED=0
PREDEPLOY_TAG=""
BACKUP_FILE=""

rollback() {
  set +e
  # If ssh has gone, a write to it must fail quietly, not kill the rollback.
  trap '' PIPE
  echo "!! RELEASE FAILED: $1" >&2
  if [ "$TAG_MOVED" = 1 ] && [ -n "$PREDEPLOY_TAG" ]; then
    docker tag "$PREDEPLOY_TAG" "$LIVE_REF"
    echo "!! $LIVE_REF points at the previous image again (${LIVE_ID#sha256:})." >&2
  fi
  if [ "$SWITCHED" = 1 ]; then
    echo "!! Recreating $APP_SERVICE from the previous image." >&2
    if recreate_app && wait_healthy "$LIVE_ID"; then
      echo "!! The previous image is serving again." >&2
    else
      echo "!! The previous image did NOT come back healthy. Manual intervention required:" >&2
      echo "!!   cd $REMOTE_DIR && docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs --tail 100 $APP_SERVICE" >&2
    fi
  else
    echo "!! The running container was never replaced." >&2
  fi
  echo "!! Database migrations are NOT rolled back." >&2
  if [ -n "$BACKUP_FILE" ]; then
    echo "!! The database backup taken before this release is $BACKUP_FILE" >&2
  fi
  FINISHED=1
  exit 1
}

on_exit() {
  local code=$?
  if [ "$code" != 0 ] && [ "$FINISHED" = 0 ] && [ "$TAG_MOVED" = 1 ]; then
    rollback "the release stopped unexpectedly (exit $code)"
  fi
}

release() {
  # -- 1. The image ----------------------------------------------------------
  NEW_ID="$(image_id "$NEW_REF")"
  [ -n "$NEW_ID" ] || blocked "$NEW_REF is not on this host; the ship step did not land it."
  local label arch
  label="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_REF")"
  [ "$label" = "$FULL_SHA" ] || blocked "$NEW_REF is labelled revision '${label:-none}', not $FULL_SHA."
  arch="$(docker image inspect -f '{{.Architecture}}' "$NEW_REF")"
  [ "$arch" = amd64 ] || blocked "$NEW_REF is built for '$arch', not amd64."
  if [ "$LIVE_ID" = "$NEW_ID" ]; then
    say "the running container already runs $NEW_REF; nothing to release"
    return 0
  fi

  # -- 2. Rollback point -----------------------------------------------------
  # From the running container, not from a tag: the tag can have moved.
  PREDEPLOY_TAG="$APP_IMAGE:predeploy-$SHA"
  docker tag "$LIVE_ID" "$PREDEPLOY_TAG"
  say "rollback point: the running image ${LIVE_ID#sha256:} is $PREDEPLOY_TAG"
  local cert_before
  cert_before="$(cert_available)"
  say "certificate before the release: available=$cert_before"

  # -- 3. Database backup ----------------------------------------------------
  # pg_dump runs inside the database container as its own POSTGRES_USER over
  # the local socket. The variable names are expanded by the container's shell,
  # so no value of them is on this host's command line or in this output.
  local stamp tmp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_FILE="$BACKUP_DIR/documenso-$stamp-$SHA.sql.gz"
  tmp="$BACKUP_FILE.partial"
  say "backing up the database to $BACKUP_FILE"
  # Chained with &&: set -e does not apply inside an `if` condition. pg_dump
  # writes that trailer line only after the last table, so its presence is the
  # proof the dump ran to the end.
  if ! ( umask 077 &&
         docker exec "$DB_CID" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip -c > "$tmp" &&
         gzip -t "$tmp" &&
         gzip -dc "$tmp" | tail -n 20 | grep 'PostgreSQL database dump complete' >/dev/null ); then
    rm -f "$tmp"
    docker rmi "$PREDEPLOY_TAG" >/dev/null 2>&1 || true
    echo "!! ABORTED: the database backup failed or is incomplete. Nothing was changed." >&2
    exit 1
  fi
  mv "$tmp" "$BACKUP_FILE"
  chmod 600 "$BACKUP_FILE"
  say "backup ok: $(du -h "$BACKUP_FILE" | cut -f1)"
  # Keep the newest $BACKUP_KEEP of this script's own files; the names sort by time.
  local all count
  all="$(ls -1 "$BACKUP_DIR" | grep -E '^documenso-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.sql\.gz$' | sort || true)"
  count="$(printf '%s' "$all" | grep -c . || true)"
  if [ "$count" -gt "$BACKUP_KEEP" ]; then
    printf '%s\n' "$all" | head -n "$((count - BACKUP_KEEP))" | while read -r old; do
      rm -f "$BACKUP_DIR/$old" && say "removed old backup $old"
    done
  fi

  # -- 4. Retag --------------------------------------------------------------
  # From here on, any exit that is not a finished release rolls back.
  trap on_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  WAS_ROLLBACK="$(image_id "$APP_IMAGE:rollback")"
  WAS_COMPOSE="$(image_id "$LIVE_REF")"
  TAG_MOVED=1
  docker tag "$NEW_REF" "$LIVE_REF"
  say "$LIVE_REF now names $NEW_REF (${NEW_ID#sha256:})"

  # -- 5. Migration preview --------------------------------------------------
  # A one-off container of the new image, with compose's own environment for
  # the service, so the database URL never passes through this script. Prisma
  # prints the database host, not the password; any URL is masked anyway. The
  # exit status is not judged: "pending migrations" is a non-zero exit too.
  if [ "$MIGRATION_PREVIEW" = 1 ]; then
    say "migrations the new image will apply on start (prisma migrate status):"
    { migration_status 2>&1 || true; } \
      | sed -E 's#[a-z]+://[^[:space:]"]*#<url>#g; s/^/     | /'
  fi

  # -- 6. Switch -------------------------------------------------------------
  say "recreating $APP_SERVICE only (no --deps, database untouched)"
  SWITCHED=1
  recreate_app

  # -- 7. Health -------------------------------------------------------------
  say "health check: $BASE_URL/api/health (up to $HEALTH_RETRIES x ${HEALTH_INTERVAL}s; migrations run on start)"
  wait_healthy "$NEW_ID" || rollback "no healthy response from the new image"
  local cert_after
  cert_after="$(cert_available)"
  say "certificate after the release: available=$cert_after"
  if [ "$cert_before" = yes ] && [ "$cert_after" != yes ]; then
    rollback "the signing certificate was available before this release and is not now"
  fi
  if [ "$cert_after" != yes ]; then
    echo "WARNING: the signing certificate is not available (before: $cert_before). Documents cannot be sealed until it is." >&2
  fi

  # -- 9. Promote and clean up -----------------------------------------------
  FINISHED=1
  trap - EXIT
  docker tag "$PREDEPLOY_TAG" "$APP_IMAGE:rollback"
  docker rmi "$PREDEPLOY_TAG" >/dev/null 2>&1 || true
  say "$APP_IMAGE:rollback is now the previous image (${LIVE_ID#sha256:})"

  # Keep the tag compose names, :rollback, and this commit's tag. Only this
  # image name is touched: other projects share this host, so no prune.
  local tag
  docker images "$APP_IMAGE" --format '{{.Tag}}' | while read -r tag; do
    case "$tag" in
      "${LIVE_REF#"$APP_IMAGE":}"|rollback|"$SHA"|"<none>"|"") ;;
      *) docker rmi "$APP_IMAGE:$tag" >/dev/null 2>&1 && say "untagged $APP_IMAGE:$tag" || true ;;
    esac
  done
  # Moving :rollback (and the compose tag) untagged the images they named
  # before, and an untagged image is not listed above. Remove it by id, only if nothing names it any more.
  local superseded
  for superseded in "${WAS_ROLLBACK:-}" "${WAS_COMPOSE:-}"; do
    [ -n "$superseded" ] || continue
    [ "$superseded" != "$LIVE_ID" ] && [ "$superseded" != "$NEW_ID" ] || continue
    [ "$(docker image inspect -f '{{len .RepoTags}}' "$superseded" 2>/dev/null || echo 1)" = 0 ] || continue
    docker rmi "$superseded" >/dev/null 2>&1 && say "removed the superseded image ${superseded#sha256:}" || true
  done

  say "production healthy on $VERSION ($SHA); backup $BACKUP_FILE"
}

main "$@"
