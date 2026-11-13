#!/usr/bin/env bash
# Build the Fantasy Documenso image on this machine, ship it to the host, and
# swap the running app container over to it.
#
#   deployment/deploy.sh production
#
# deployment/README.md is the manual: one-off set-up, every step, every
# BLOCKED message, rollback and restore. In short:
#
#   preflight  everything that can stop a release is checked before anything is
#              built: the commit, this machine's docker, the host, its compose
#              project, its disk, the backup directory, and the registry.
#   [1/4]      docker build --platform linux/amd64 from `git archive` of the
#              pushed overlay commit, so the image holds that commit and nothing
#              else this checkout happens to have lying around.
#   [2/4]      ship it: through a private Docker Hub repository (HTTPS), or
#              piped over ssh as a gzipped tarball.
#   [3/4]      deployment/deploy-remote.sh, piped over ssh: rollback point,
#              database backup, retag, recreate the app service only, health
#              check, roll back on failure.
#   [4/4]      drop this release's local image tags.
#
# The host is never named here: this repository is public. It comes from
# SSH_HOST or ~/.config/fantasy-documenso/ssh-host.
#
# Runs on macOS's /bin/bash 3.2: no associative arrays, no ${var,,}, no mapfile,
# and no empty-array expansion under set -u.

set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "usage: deployment/deploy.sh production" >&2
  echo "  deployment/README.md describes the set-up and every step." >&2
}

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  production) ;;
  "")
    usage
    exit 1
    ;;
  *)
    echo "BLOCKED: unknown environment '$ENVIRONMENT'; the only one is 'production'." >&2
    usage
    exit 1
    ;;
esac

# The branch whose pushed tip is the only thing this script will release.
RELEASE_BRANCH=fantasy-production-overlay
APP_IMAGE=documenso-fantasy

CONFIG_DIR="$HOME/.config/fantasy-documenso"
HOST_FILE="$CONFIG_DIR/ssh-host"
REPO_FILE="$CONFIG_DIR/dockerhub-repo"
TOKEN_FILE="$CONFIG_DIR/dockerhub-pull-token"

REMOTE_DIR="${REMOTE_DIR:-/opt/apps/Perri/documenso/documenso}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/production/compose.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/opt/apps/Perri/backups/documenso-deploy}"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
MIN_FREE_GB="${MIN_FREE_GB:-8}"
APP_PORT="${APP_PORT:-3010}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
MIGRATION_PREVIEW="${MIGRATION_PREVIEW:-1}"

say() { printf '\n==> %s\n' "$1"; }
blocked() { echo "BLOCKED: $1" >&2; exit 1; }

# Everything below is handed to a remote shell inside single quotes, so a value
# with a quote, a space or a '$' in it could change the command. Hold each one
# to a shape that cannot.
PATH_FORMAT='^/[A-Za-z0-9._/-]+$'
REL_FORMAT='^[A-Za-z0-9._/-]+$'
INT_FORMAT='^[0-9]+$'
[[ "$REMOTE_DIR" =~ $PATH_FORMAT ]] || blocked "REMOTE_DIR must be an absolute path of letters, digits, '.', '_', '-' and '/'."
[[ "$BACKUP_DIR" =~ $PATH_FORMAT ]] || blocked "BACKUP_DIR must be an absolute path of letters, digits, '.', '_', '-' and '/'."
[[ "$COMPOSE_FILE" =~ $REL_FORMAT ]] || blocked "COMPOSE_FILE must be a path of letters, digits, '.', '_', '-' and '/'."
[[ "$ENV_FILE" =~ $REL_FORMAT ]] || blocked "ENV_FILE must be a path of letters, digits, '.', '_', '-' and '/'."
for pair in "BACKUP_KEEP=$BACKUP_KEEP" "MIN_FREE_GB=$MIN_FREE_GB" "APP_PORT=$APP_PORT" \
            "HEALTH_RETRIES=$HEALTH_RETRIES" "HEALTH_INTERVAL=$HEALTH_INTERVAL"; do
  [[ "${pair#*=}" =~ $INT_FORMAT ]] || blocked "${pair%%=*} must be a whole number, not '${pair#*=}'."
done
[ "$BACKUP_KEEP" -ge 1 ] || blocked "BACKUP_KEEP must be at least 1."
[ "$HEALTH_RETRIES" -ge 1 ] || blocked "HEALTH_RETRIES must be at least 1."
case "$MIGRATION_PREVIEW" in 0|1) ;; *) blocked "MIGRATION_PREVIEW must be 0 or 1." ;; esac
case "$BACKUP_DIR/" in
  "$REMOTE_DIR"/*) blocked "BACKUP_DIR must be outside REMOTE_DIR ($REMOTE_DIR): a checkout is no place for database dumps." ;;
esac

# -- The commit --------------------------------------------------------------
# One commit, pushed, on the release branch. The image's tag and its
# org.opencontainers.image.revision label are the only record on the host of
# what is running, so they must name something everyone can find.

if [ -n "$(git status --porcelain)" ]; then
  blocked "working tree not clean — a release ships exactly one pushed commit. Commit and push, or stash."
fi
if ! git fetch --quiet origin "+refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH"; then
  blocked "git fetch origin $RELEASE_BRANCH failed; cannot tell whether this commit is the pushed one."
fi
FULL_SHA="$(git rev-parse HEAD)"
RELEASE_SHA="$(git rev-parse "refs/remotes/origin/$RELEASE_BRANCH")"
if [ "$FULL_SHA" != "$RELEASE_SHA" ]; then
  blocked "HEAD ($(git rev-parse --short=12 HEAD)) is not origin/$RELEASE_BRANCH ($(git rev-parse --short=12 "$RELEASE_SHA")). Only the pushed tip of $RELEASE_BRANCH is released: check it out (git switch --detach origin/$RELEASE_BRANCH) or push first."
fi
SHA="$(git rev-parse --short=12 HEAD)"
VERSION="$(git describe --tags --always HEAD 2>/dev/null || echo "$SHA")"

# -- Where it goes -----------------------------------------------------------

if [ -z "${SSH_HOST:-}" ] && [ -f "$HOST_FILE" ]; then
  SSH_HOST="$(tr -d '[:space:]' < "$HOST_FILE")"
fi
SSH_HOST="${SSH_HOST:-}"
if [ -z "$SSH_HOST" ]; then
  echo "BLOCKED: no target host. This repository is public, so the host is not written in it." >&2
  echo "  Set SSH_HOST for one run, or once for this machine:" >&2
  echo "    mkdir -p $CONFIG_DIR && echo '<ssh host or ~/.ssh/config alias>' > $HOST_FILE" >&2
  exit 1
fi
HOST_FORMAT='^[A-Za-z0-9_][A-Za-z0-9._@:-]*$'
[[ "$SSH_HOST" =~ $HOST_FORMAT ]] || blocked "SSH_HOST is not an ssh destination (letters, digits, '.', '_', '-', '@', ':' only)."

# -- Which way the image travels ---------------------------------------------

MISSING=""
[ -f "$REPO_FILE" ] || MISSING="$MISSING $REPO_FILE"
[ -f "$TOKEN_FILE" ] || MISSING="$MISSING $TOKEN_FILE"
case "${SHIP:-}" in
  registry)
    if [ -n "$MISSING" ]; then
      echo "BLOCKED: SHIP=registry, but the set-up is missing:" >&2
      for f in $MISSING; do echo "  $f" >&2; done
      echo "  deployment/README.md says how to set it up." >&2
      exit 1
    fi
    SHIP_VIA=registry
    SHIP_WHY="SHIP=registry"
    ;;
  ssh)
    SHIP_VIA=ssh
    SHIP_WHY="SHIP=ssh"
    ;;
  "")
    if [ -z "$MISSING" ]; then
      SHIP_VIA=registry
      SHIP_WHY="this machine is set up for it"
    else
      SHIP_VIA=ssh
      SHIP_WHY="this machine is not set up for the registry (missing:$MISSING); deployment/README.md says how"
    fi
    ;;
  *)
    blocked "SHIP must be 'registry' or 'ssh', not '$SHIP'."
    ;;
esac

echo "Releasing $VERSION ($SHA) to $ENVIRONMENT; image travels by $SHIP_VIA ($SHIP_WHY)."

# -- Preflight ---------------------------------------------------------------
# Nothing is built or pushed until every check here has passed.

docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 \
  || blocked "docker is not running on this machine (docker info failed). Start Docker Desktop."

ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" true 2>/dev/null \
  || blocked "cannot reach $SSH_HOST over ssh (BatchMode, 15s timeout). Check the host, your key and ~/.ssh/config."

# Values travel as environment variables in front of `bash -s`, never as
# arguments to the script, and the script itself arrives on stdin: there is no
# copy of it on the host to go stale. None of these are secret.
remote_env() {
  printf "MODE='%s' SHA='%s' FULL_SHA='%s' VERSION='%s' REMOTE_DIR='%s' COMPOSE_FILE='%s' ENV_FILE='%s' BACKUP_DIR='%s' BACKUP_KEEP='%s' MIN_FREE_GB='%s' APP_PORT='%s' HEALTH_RETRIES='%s' HEALTH_INTERVAL='%s' MIGRATION_PREVIEW='%s'" \
    "$1" "$SHA" "$FULL_SHA" "$(printf '%s' "$VERSION" | tr -cd 'A-Za-z0-9._-')" "$REMOTE_DIR" "$COMPOSE_FILE" "$ENV_FILE" \
    "$BACKUP_DIR" "$BACKUP_KEEP" "$MIN_FREE_GB" "$APP_PORT" "$HEALTH_RETRIES" "$HEALTH_INTERVAL" "$MIGRATION_PREVIEW"
}

# The host's half of the preflight is deploy-remote.sh itself in MODE=preflight:
# compose and env files, both containers running, the compose image reference,
# disk, backup directory. It changes nothing; the release runs the same checks
# again before it starts.
say "Preflight on $SSH_HOST"
ssh "$SSH_HOST" "$(remote_env preflight) bash -s" < deployment/deploy-remote.sh

# The registry is checked before anything is built, because a push is the one
# step here that cannot be taken back: Docker Hub creates a repository that
# does not exist yet on the first push to it, and creates it public. So the
# repository must already exist, be private, and be readable by the pull token
# the host will use.
#
# The token never goes on a command line, where `ps` shows it to every user of
# the machine: curl reads it from its config on stdin (-K -), and it is only
# ever handed to shell builtins and pipes. Nothing here prints it, nor the
# response bodies that carry it or the short-lived JWT it buys.
if [ "$SHIP_VIA" = registry ]; then
  REPO="$(tr -d '[:space:]' < "$REPO_FILE")"
  REPO_FORMAT='^[a-z0-9]+([._-][a-z0-9]+)*/[a-z0-9]+([._-][a-z0-9]+)*$'
  [[ "$REPO" =~ $REPO_FORMAT ]] || blocked "$REPO_FILE must hold one line, <id>/<name>, in lower case."
  REGISTRY_USER="${REGISTRY_USER:-${REPO%%/*}}"
  USER_FORMAT='^[A-Za-z0-9][A-Za-z0-9._-]*$'
  [[ "$REGISTRY_USER" =~ $USER_FORMAT ]] || blocked "REGISTRY_USER is not a Docker Hub user name."

  # GNU stat first: BSD stat refuses -c, while GNU stat reads -f as "file
  # system" and would answer the wrong question.
  TOKEN_MODE="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$TOKEN_FILE")"
  if [ "$TOKEN_MODE" != 600 ]; then
    echo "BLOCKED: $TOKEN_FILE is mode $TOKEN_MODE; it must be 600." >&2
    echo "  chmod 600 $TOKEN_FILE" >&2
    exit 1
  fi
  PULL_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  TOKEN_FORMAT='^[A-Za-z0-9_-]+$'
  [[ "$PULL_TOKEN" =~ $TOKEN_FORMAT ]] || blocked "$TOKEN_FILE does not hold a Docker Hub access token."

  HUB_REPO_URL="https://hub.docker.com/v2/repositories/$REPO/"

  # 1. Asked with no credentials, Docker Hub answers 200 only for a public
  #    repository. Any other answer passes here; step 3 asks the positive
  #    question.
  ANON_STATUS="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$HUB_REPO_URL" 2>/dev/null || true)"
  [ "$ANON_STATUS" != 200 ] || blocked "$REPO on Docker Hub is public. Make it private before deploying through it."

  # 2. The pull token buys a short-lived JWT (POST /v2/auth/token).
  LOGIN_OUT="$(printf 'header = "Content-Type: application/json"\ndata = "{\\"identifier\\":\\"%s\\",\\"secret\\":\\"%s\\"}"\n' \
      "$REGISTRY_USER" "$PULL_TOKEN" \
    | curl -sS --max-time 20 -K - -w '\n%{http_code}' https://hub.docker.com/v2/auth/token 2>/dev/null || true)"
  LOGIN_STATUS="$(printf '%s' "$LOGIN_OUT" | tail -n 1)"
  HUB_JWT="$(printf '%s' "$LOGIN_OUT" | perl -ne 'print $1 if /"access_token"\s*:\s*"([^"]+)"/')"
  LOGIN_OUT=""
  if [ "$LOGIN_STATUS" != 200 ] || [ -z "$HUB_JWT" ]; then
    echo "BLOCKED: Docker Hub refused the pull token for user $REGISTRY_USER (status ${LOGIN_STATUS:-none})." >&2
    echo "  Check $TOKEN_FILE, or set REGISTRY_USER if the token is another account's." >&2
    exit 1
  fi

  # 3. Asked with the token, the repository must answer 200 and say it is
  #    private: that proves it exists, is private, and this token can read it.
  REPO_OUT="$(printf 'header = "Authorization: Bearer %s"\n' "$HUB_JWT" \
    | curl -sS --max-time 20 -K - -w '\n%{http_code}' "$HUB_REPO_URL" 2>/dev/null || true)"
  HUB_JWT=""
  REPO_STATUS="$(printf '%s' "$REPO_OUT" | tail -n 1)"
  REPO_PRIVATE="$(printf '%s' "$REPO_OUT" | perl -ne 'print $1 if /"is_private"\s*:\s*(true|false)/')"
  REPO_OUT=""
  case "$REPO_STATUS" in
    200)
      [ "$REPO_PRIVATE" = true ] || blocked "$REPO on Docker Hub is not private (is_private: ${REPO_PRIVATE:-absent})."
      ;;
    404)
      echo "BLOCKED: $REPO does not exist on Docker Hub (status 404). Create it, private, first:" >&2
      echo "  a push would create it public." >&2
      exit 1
      ;;
    401|403)
      blocked "the pull token cannot read $REPO on Docker Hub (status $REPO_STATUS)."
      ;;
    *)
      blocked "Docker Hub did not confirm $REPO is private and readable (status ${REPO_STATUS:-none})."
      ;;
  esac
  echo "Registry $REPO is private and the pull token reads it."
fi

# -- Build -------------------------------------------------------------------

say "[1/4] Build $APP_IMAGE:$SHA for linux/amd64 ($VERSION)"
# The host is x86_64 and the installer stage compiles native modules (aws-crt,
# sharp, canvas) that the runner stage copies as they are, so the whole build
# runs under emulation on an Apple Silicon machine. Slow, and the only way.
#
# The context is `git archive` of the commit, streamed on stdin: the Dockerfile
# starts with `COPY . .`, and .dockerignore does not cover everything a working
# checkout accumulates (.turbo caches, local notes the .gitignore hides). What
# is built is what was pushed. docker/Dockerfile is not changed; the commit is
# recorded by a label.
git archive --format=tar "$FULL_SHA" | docker build \
  --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$FULL_SHA" \
  --label "org.opencontainers.image.version=$VERSION" \
  -f docker/Dockerfile \
  -t "$APP_IMAGE:$SHA" \
  -

# -- Ship --------------------------------------------------------------------

REGISTRY_REF=""
if [ "$SHIP_VIA" = registry ]; then
  REGISTRY_REF="$REPO:documenso-$ENVIRONMENT-$SHA"
  say "[2/4] Ship the image through the registry $REPO ($SHIP_WHY)"
  docker tag "$APP_IMAGE:$SHA" "$REGISTRY_REF"
  docker push "$REGISTRY_REF"

  # The host pulls with the read-only token, which arrives as this ssh's stdin
  # and nowhere else. The host's own Docker config is shared with other
  # projects, so the login goes into a temporary DOCKER_CONFIG, removed as soon
  # as the pull is over and again on any exit. Then the image takes the name
  # deploy-remote.sh expects and the registry's name for it is dropped.
  #
  # The script below is passed inside single quotes, so it holds none.
  REMOTE_PULL='
    set -eu
    dir="$(mktemp -d)"
    trap "rm -rf \"$dir\"" EXIT
    trap "exit 129" HUP
    trap "exit 130" INT
    trap "exit 143" TERM
    export DOCKER_CONFIG="$dir"
    if ! docker login -u "$REGISTRY_USER" --password-stdin >/dev/null 2>&1; then
      echo "BLOCKED: Docker Hub refused the pull token on the host." >&2
      exit 1
    fi
    docker pull --platform linux/amd64 "$REGISTRY_REF"
    rm -rf "$dir"
    unset DOCKER_CONFIG
    docker tag "$REGISTRY_REF" "$TARGET"
    docker rmi "$REGISTRY_REF" >/dev/null
  '
  printf '%s\n' "$PULL_TOKEN" | ssh "$SSH_HOST" \
    "REGISTRY_REF='$REGISTRY_REF' REGISTRY_USER='$REGISTRY_USER' TARGET='$APP_IMAGE:$SHA' bash -c '$REMOTE_PULL'"
  PULL_TOKEN=""
else
  say "[2/4] Ship the image over ssh as a gzipped tarball ($SHIP_WHY)"
  # Piped end to end: the tarball never lands on either disk. The whole image
  # goes every time, and port 22 from the office is shaped to tens of KB/s, so
  # the meter is what tells a slow pipe from a hung one. It reads the
  # uncompressed stream, the one size docker can name in advance.
  SIZE="$(docker image inspect --format '{{.Size}}' "$APP_IMAGE:$SHA")"
  meter() {
    perl -e '
      my $total = shift;
      my ($done, $start, $last, $step) = (0, time, 0, 0);
      binmode STDIN; binmode STDOUT;
      my $tty = -t STDERR;
      while (my $n = sysread(STDIN, my $buf, 1 << 16)) {
        for (my $off = 0; $off < $n;) {
          my $w = syswrite(STDOUT, $buf, $n - $off, $off) // die "write: $!";
          $off += $w;
        }
        $done += $n;
        my $now = time;
        next if $now == $last;
        $last = $now;
        my $pct = $total > 0 ? 100 * $done / $total : 0;
        my $elapsed = $now - $start;
        my $left = $done > 0 ? int($elapsed * ($total - $done) / $done) : 0;
        $left = 0 if $left < 0;
        my $line = sprintf("%5.1f%%  %.0f of %.0f MB  %d:%02d elapsed  %d:%02d left",
          $pct, $done / 1e6, $total / 1e6, $elapsed / 60, $elapsed % 60, $left / 60, $left % 60);
        if ($tty) { print STDERR "\r  $line   "; }
        elsif (int($pct / 10) > $step) { $step = int($pct / 10); print STDERR "  $line\n"; }
      }
      print STDERR "\n" if $tty;
    ' "$1"
  }
  docker save "$APP_IMAGE:$SHA" | meter "$SIZE" | gzip -1 | ssh "$SSH_HOST" 'gunzip | docker load'
fi

# -- Release -----------------------------------------------------------------

say "[3/4] Release on $SSH_HOST"
ssh "$SSH_HOST" "$(remote_env release) bash -s" < deployment/deploy-remote.sh

# -- Forget the local copy ---------------------------------------------------
# After the release, not after the upload: until the release has finished, the
# local image is what makes a second attempt cheap. Only the tags this script
# makes are removed — a 12-hex commit tag of this image, and the registry tag —
# so anything else named documenso-fantasy on this machine is left alone.

say "[4/4] Drop the local image tags for $APP_IMAGE"
if [ -n "$REGISTRY_REF" ]; then
  docker image rm "$REGISTRY_REF" >/dev/null 2>&1 || true
fi
docker images "$APP_IMAGE" --format '{{.Tag}}' \
  | { grep -E '^[0-9a-f]{12}$' || true; } \
  | while read -r tag; do docker image rm "$APP_IMAGE:$tag" >/dev/null 2>&1 || true; done

echo
echo "DEPLOYED: $ENVIRONMENT is running $VERSION ($SHA)."
