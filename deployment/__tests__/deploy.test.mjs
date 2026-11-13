// Runs deployment/deploy.sh end to end in a throwaway git repository, with
// docker, ssh, curl and df replaced by recording stubs (./stubs.mjs). The ssh
// stub runs the remote half on this machine, so deploy-remote.sh executes for
// real against a simulated host. What this proves is the SHAPE of each path:
// which calls happen, in which order, and which never happen. It proves nothing
// about the real tools, the real build, or the real host.
//
//   node --test deployment/__tests__/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CURL_STUB, DF_STUB, DOCKER_STUB, SSH_STUB } from './stubs.mjs';

const deploymentDir = fileURLToPath(new URL('..', import.meta.url));
const LIVE_REF = 'documenso-fantasy:2.14.0-email-template';

const sh = (cwd, cmd) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};

const git = (cwd, cmd) => sh(cwd, `git -c user.name=harness -c user.email=harness@example.invalid ${cmd}`);

const setup = (opts = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'documenso-deploy-')));
  const work = join(root, 'work');
  mkdirSync(join(work, 'deployment'), { recursive: true });
  mkdirSync(join(work, 'docker'), { recursive: true });
  for (const f of ['deploy.sh', 'deploy-remote.sh']) {
    copyFileSync(join(deploymentDir, f), join(work, 'deployment', f));
  }
  writeFileSync(join(work, 'docker', 'Dockerfile'), 'FROM scratch\n');
  git(work, 'init -q -b main');
  git(work, 'add -A');
  git(work, 'commit -q -m harness');
  git(root, 'init -q --bare origin.git');
  git(work, `remote add origin ${join(root, 'origin.git')}`);
  git(work, 'push -q origin HEAD:refs/heads/fantasy-production-overlay');
  const fullSha = git(work, 'rev-parse HEAD');
  const sha = fullSha.slice(0, 12);

  const remote = join(root, 'remote');
  mkdirSync(join(remote, 'docker', 'production'), { recursive: true });
  writeFileSync(join(remote, 'docker', 'production', 'compose.yml'), 'name: documenso-production\n');
  if (!opts.noEnvFile) {
    writeFileSync(join(remote, '.env.production'), 'POSTGRES_USER=documenso\n');
  }
  const backups = join(root, 'backups');
  if (opts.oldBackups) {
    mkdirSync(backups, { recursive: true });
    for (let i = 0; i < opts.oldBackups; i++) {
      writeFileSync(join(backups, `documenso-2026010${i}T000000Z-aaaaaaaaaaaa.sql.gz`), 'x');
    }
    writeFileSync(join(backups, 'unrelated-file.txt'), 'keep me');
  }

  const home = join(root, 'home');
  const config = join(home, '.config', 'fantasy-documenso');
  mkdirSync(config, { recursive: true });
  if (opts.registry) {
    writeFileSync(join(config, 'dockerhub-repo'), 'harnessorg/documenso\n');
    writeFileSync(join(config, 'dockerhub-pull-token'), 'dckr_pat_harness-token\n');
    chmodSync(join(config, 'dockerhub-pull-token'), opts.tokenMode ?? 0o600);
  }
  if (opts.hostFile) {
    writeFileSync(join(config, 'ssh-host'), `${opts.hostFile}\n`);
  }

  const bin = join(root, 'stub-bin');
  mkdirSync(bin);
  for (const [name, body] of [
    ['docker', DOCKER_STUB],
    ['curl', CURL_STUB],
    ['ssh', SSH_STUB],
    ['df', DF_STUB],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }

  writeFileSync(
    join(root, 'scenario.json'),
    JSON.stringify({ liveRef: LIVE_REF, dockerRoot: root, fullSha, certOld: true, certNew: true, ...opts.scenario }),
  );
  writeFileSync(join(root, 'free-gb'), String(opts.freeGb ?? 50));
  if (opts.sshDown) {
    writeFileSync(join(root, 'ssh-down'), '');
  }
  if (opts.sshSlow) {
    writeFileSync(join(root, 'ssh-slow'), '');
  }
  const fresh = Boolean(opts.fresh);
  const remoteState = {
    next: 1,
    volumes: opts.volumes ?? (fresh ? [] : ['documenso-production_database']),
    tags: fresh
      ? { 'someone-else:latest': 'sha256:other' }
      : {
          [LIVE_REF]: 'sha256:old',
          'documenso-fantasy:rollback': 'sha256:older',
          'documenso-fantasy:0123456789ab': 'sha256:old',
          'someone-else:latest': 'sha256:other',
        },
    images: {
      'sha256:old': { labels: {} },
      'sha256:older': { labels: {} },
      'sha256:other': { labels: {} },
      'sha256:pg': { labels: {} },
    },
    containers: {
      documenso: { id: 'c-app', ref: opts.liveRef ?? LIVE_REF, image: 'sha256:old', running: opts.appRunning ?? true },
      database: { id: 'c-db', ref: 'postgres:15', image: 'sha256:pg', running: opts.dbRunning ?? true },
    },
  };
  if (fresh || opts.noApp) delete remoteState.containers.documenso;
  if (fresh || opts.noDb) delete remoteState.containers.database;
  if (fresh) {
    delete remoteState.images['sha256:old'];
    delete remoteState.images['sha256:older'];
    delete remoteState.images['sha256:pg'];
  }
  writeFileSync(join(root, 'state-remote.json'), JSON.stringify(remoteState));
  writeFileSync(join(root, 'calls.log'), '');
  return { root, work, remote, backups, home, bin, fullSha, sha };
};

const run = (h, { args = ['production'], env = {} } = {}) => {
  const base = { ...process.env };
  for (const k of ['SSH_HOST', 'SHIP', 'REGISTRY_USER', 'REMOTE_DIR', 'BACKUP_DIR', 'MIN_FREE_GB', 'HARNESS_SIDE', 'BUILD_NODE_HEAP_MB', 'FIRST_RELEASE', 'ALLOW_EMPTY_DATABASE', 'SSH_PROBE_MB', 'SSH_PROBE_SECONDS']) {
    delete base[k];
  }
  const r = spawnSync('bash', [join(h.work, 'deployment', 'deploy.sh'), ...args], {
    cwd: h.work,
    encoding: 'utf8',
    env: {
      ...base,
      PATH: `${h.bin}:${process.env.PATH}`,
      HOME: h.home,
      HARNESS_ROOT: h.root,
      SSH_HOST: 'deploy-target',
      REMOTE_DIR: h.remote,
      BACKUP_DIR: h.backups,
      HEALTH_RETRIES: '2',
      HEALTH_INTERVAL: '0',
      DB_HEALTH_RETRIES: '2',
      DB_HEALTH_INTERVAL: '0',
      SSH_PROBE_MB: '1',
      SSH_PROBE_SECONDS: '2',
      ...env,
    },
  });
  const calls = readFileSync(join(h.root, 'calls.log'), 'utf8');
  const remoteState = JSON.parse(readFileSync(join(h.root, 'state-remote.json'), 'utf8'));
  const localPath = join(h.root, 'state-local.json');
  const localState = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : null;
  const backups = existsSync(h.backups) ? readdirSync(h.backups).sort() : [];
  return { status: r.status, out: r.stdout + r.stderr, calls, lines: calls.split('\n'), remoteState, localState, backups };
};

const cleanup = (h) => rmSync(h.root, { recursive: true, force: true });

const at = (r, needle) => r.lines.findIndex((l) => l.includes(needle));
const has = (r, needle) => at(r, needle) >= 0;

// The invariants that hold on every path, whatever happened. On a first
// release `up -d database` and `up -d --no-deps documenso` are the two extra
// forms allowed; everywhere else only the in-place recreate is.
const assertNeverTouchesProject = (r, { first = false } = {}) => {
  for (const line of r.lines.filter((l) => l.includes('docker compose'))) {
    assert.ok(!/\bdown\b/.test(line), `never compose down:\n${line}`);
    const verb = line.match(/ -f \S+ (\S+)/)?.[1];
    assert.ok(['ps', 'config', 'up', 'run'].includes(verb), `only ps, config, up and run:\n${line}`);
    if (/ up /.test(line)) {
      const allowed = first
        ? / up -d (--no-deps --force-recreate documenso|--no-deps documenso|database)$/
        : / up -d --no-deps --force-recreate documenso$/;
      assert.match(line, allowed, `up recreates the app only:\n${line}`);
    }
    if (/ run /.test(line)) {
      assert.match(line, / run --rm --no-deps -T documenso /, `one-off runs are the app service:\n${line}`);
    }
  }
  assert.ok(!/docker (image |system |volume |container |builder )?prune/.test(r.calls), 'never prunes');
  assert.ok(!/docker volume (rm|create|prune)/.test(r.calls), 'never changes volumes');
  assert.ok(!/remote docker (rm|stop|kill)\b/.test(r.calls), 'never removes or stops containers directly');
  assert.ok(!/(rmi|image rm) [^\n]*(postgres|someone-else|sha256:pg|sha256:other)/.test(r.calls), 'other images untouched');
  if (!first) {
    assert.equal(r.remoteState.containers.database?.id, 'c-db', 'the database container is never recreated');
  }
  assert.ok(r.remoteState.tags['someone-else:latest'], 'another project’s tag survives');
};

const assertNothingBuilt = (r) => {
  assert.ok(!has(r, 'local docker build'), `nothing built:\n${r.calls}`);
  assert.ok(!has(r, 'docker push'), 'nothing pushed');
  assert.ok(!has(r, 'remote docker tag'), 'nothing retagged on the host');
};

// -- Arguments ----------------------------------------------------------------

test('no argument prints the usage and does nothing', () => {
  const h = setup();
  const r = run(h, { args: [] });
  assert.equal(r.status, 1);
  assert.match(r.out, /usage: deployment\/deploy.sh production/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('an environment other than production is refused', () => {
  const h = setup();
  const r = run(h, { args: ['staging'] });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: unknown environment 'staging'; the only one is 'production'/);
  assert.equal(r.calls, '');
  cleanup(h);
});

// -- The commit ---------------------------------------------------------------

test('a dirty working tree is refused before anything else', () => {
  const h = setup();
  writeFileSync(join(h.work, 'stray.txt'), 'x');
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: working tree not clean/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('a commit that is not the pushed overlay tip is refused', () => {
  const h = setup();
  writeFileSync(join(h.work, 'local.txt'), 'x');
  git(h.work, 'add -A');
  git(h.work, 'commit -q -m local-only');
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: HEAD \([0-9a-f]{12}\) is not origin\/fantasy-production-overlay/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('the overlay tip is compared after a fetch, so a newer push is seen', () => {
  const h = setup();
  // Someone else pushes a newer overlay commit; this checkout is now behind.
  const other = join(h.root, 'other');
  git(h.root, `clone -q ${join(h.root, 'origin.git')} other`);
  git(other, 'checkout -q fantasy-production-overlay');
  writeFileSync(join(other, 'newer.txt'), 'x');
  git(other, 'add -A');
  git(other, 'commit -q -m newer');
  git(other, 'push -q origin HEAD:fantasy-production-overlay');
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /is not origin\/fantasy-production-overlay/);
  cleanup(h);
});

// -- Host -----------------------------------------------------------------------

test('no host configured: BLOCKED with the set-up instructions', () => {
  const h = setup();
  const r = run(h, { env: { SSH_HOST: '' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: no target host/);
  assert.match(r.out, /\.config\/fantasy-documenso\/ssh-host/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('the host comes from ~/.config/fantasy-documenso/ssh-host when SSH_HOST is unset', () => {
  const h = setup({ hostFile: 'documenso-host-alias' });
  const r = run(h, { env: { SSH_HOST: '' } });
  assert.equal(r.status, 0, r.out);
  assert.ok(has(r, 'local ssh documenso-host-alias true'), r.calls);
  cleanup(h);
});

test('a host value that could inject shell is refused', () => {
  const h = setup();
  const r = run(h, { env: { SSH_HOST: 'host;rm -rf /' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: SSH_HOST is not an ssh destination/);
  assert.equal(r.calls, '');
  cleanup(h);
});

// -- Preflight: order and messages ----------------------------------------------

test('local docker down: BLOCKED before ssh is tried', () => {
  const h = setup({ scenario: { localDockerDown: true } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: docker is not running on this machine/);
  assert.ok(!has(r, 'local ssh'), r.calls);
  cleanup(h);
});

test('host unreachable: BLOCKED, nothing built', () => {
  const h = setup({ sshDown: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: cannot reach deploy-target over ssh/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('env file missing on the host: BLOCKED, nothing built', () => {
  const h = setup({ noEnvFile: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: .*\/\.env\.production does not exist/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('compose file missing on the host: BLOCKED, nothing built', () => {
  const h = setup();
  rmSync(join(h.remote, 'docker'), { recursive: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: .*docker\/production\/compose.yml does not exist/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('app container not running: BLOCKED, nothing built', () => {
  const h = setup({ appRunning: false });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the 'documenso' service is not running exactly one container/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('database container stopped: BLOCKED with the commands to look, and it is not started', () => {
  const h = setup({ dbRunning: false });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the 'database' container exists but is not running \(state: exited\)/);
  assert.match(r.out, /this script will not:/);
  assert.match(r.out, /logs --tail 100 database/);
  assert.ok(!r.calls.includes(' up '), 'nothing is started');
  assertNothingBuilt(r);
  cleanup(h);
});

test('running container started from a digest, not a documenso-fantasy tag: BLOCKED', () => {
  const h = setup({ liveRef: 'documenso/documenso@sha256:abc' });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the running 'documenso' container was started from 'documenso\/documenso@sha256:abc'/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('compose file names another image than the running container: BLOCKED', () => {
  const h = setup({ scenario: { composeImages: ['postgres:15', 'documenso-fantasy:something-else'] } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: docker\/production\/compose.yml no longer names documenso-fantasy:2.14.0-email-template/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('too little disk on the host: BLOCKED, nothing built', () => {
  const h = setup({ freeGb: 5 });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: only 5G free under .*; need 8G \(MIN_FREE_GB\)/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('backup directory inside REMOTE_DIR is refused', () => {
  const h = setup();
  const r = run(h, { env: { BACKUP_DIR: join(h.remote, 'backups') } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: BACKUP_DIR must be outside REMOTE_DIR/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('preflight order: local docker, ssh, host checks, then build', () => {
  const h = setup();
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  const info = at(r, 'local docker info');
  const ssh = at(r, 'local ssh deploy-target true');
  const probe = at(r, 'local ssh deploy-target cat > /dev/null');
  const ps = at(r, 'remote docker compose');
  const df = at(r, 'df -BG');
  const build = at(r, 'local docker build');
  assert.ok(info >= 0 && ssh > info && probe > ssh && ps > probe && df > ps && build > df, r.calls);
  cleanup(h);
});

// -- Transport ------------------------------------------------------------------

test('fast ssh upload, no registry set-up: the image goes over ssh (save, gzip, load)', () => {
  const h = setup();
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /travels by ssh \(ssh upload is fast: 1 MB sent in about [0-9.]+s \(limit 2s\)\)/);
  assert.match(r.out, /If this crawls, stop it \(Ctrl-C\) and re-run with SHIP=registry/);
  assert.ok(has(r, 'local docker save documenso-fantasy:'), r.calls);
  assert.ok(has(r, 'remote docker load'), r.calls);
  assert.ok(!has(r, 'docker push') && !has(r, 'docker pull') && !has(r, 'docker-login'), r.calls);
  cleanup(h);
});

// Was "registry set-up means registry"; since the probe, it takes a slow link too.
test('slow ssh upload + registry set-up: checks the repository, pushes, host pulls with a temporary login', () => {
  const h = setup({ registry: true, sshSlow: true });
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /travels by registry \(ssh upload is slow \(1 MB not sent within 2s\) and this machine is set up for the registry\)/);
  assert.match(r.out, /Registry harnessorg\/documenso is private and the pull token reads it/);
  const anon = at(r, 'local curl -sS --max-time 20 -o /dev/null');
  const build = at(r, 'local docker build');
  const push = at(r, `local docker push harnessorg/documenso:documenso-production-${h.sha}`);
  const login = at(r, 'remote docker-login');
  const pull = at(r, `remote docker pull --platform linux/amd64 harnessorg/documenso:documenso-production-${h.sha}`);
  const retag = at(r, `remote docker tag harnessorg/documenso:documenso-production-${h.sha} documenso-fantasy:${h.sha}`);
  const untag = at(r, `remote docker rmi harnessorg/documenso:documenso-production-${h.sha}`);
  assert.ok(anon >= 0 && build > anon && push > build && login > push && pull > login && retag > pull && untag > retag, r.calls);
  assert.ok(!has(r, 'docker save'), 'no tarball when the registry is used');
  assert.ok(!r.calls.includes('dckr_pat_harness-token'), 'the token is never on a command line');
  assert.ok(!r.out.includes('dckr_pat_harness-token'), 'the token is never printed');
  assert.ok(!r.out.includes('jwt-harness'), 'the JWT is never printed');
  assert.ok(!r.remoteState.tags[`harnessorg/documenso:documenso-production-${h.sha}`], 'registry tag dropped on the host');
  cleanup(h);
});

test('SHIP=ssh overrides a machine set up for the registry', () => {
  const h = setup({ registry: true });
  const r = run(h, { env: { SHIP: 'ssh' } });
  assert.equal(r.status, 0, r.out);
  assert.ok(has(r, 'local docker save'), r.calls);
  assert.ok(!has(r, 'cat > /dev/null'), 'no probe when SHIP is set');
  assert.ok(!has(r, 'hub.docker.com'), 'no registry checks on the ssh path');
  cleanup(h);
});

test('SHIP=registry without the set-up: BLOCKED listing the missing files', () => {
  const h = setup();
  const r = run(h, { env: { SHIP: 'registry' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: SHIP=registry, but the set-up is missing:/);
  assert.match(r.out, /dockerhub-repo/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('an unknown SHIP is refused', () => {
  const h = setup();
  const r = run(h, { env: { SHIP: 'carrier-pigeon' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: SHIP must be 'registry' or 'ssh'/);
  cleanup(h);
});

test('registry checks: a public repository is refused before building', () => {
  const h = setup({ registry: true, sshSlow: true, scenario: { hub: { anon: 200 } } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: harnessorg\/documenso on Docker Hub is public/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('registry checks: a token file readable by others is refused', () => {
  const h = setup({ registry: true, sshSlow: true, tokenMode: 0o644 });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: .*dockerhub-pull-token is mode 644; it must be 600/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('registry checks: a refused pull token is BLOCKED', () => {
  const h = setup({ registry: true, sshSlow: true, scenario: { hub: { login: 401 } } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: Docker Hub refused the pull token for user harnessorg \(status 401\)/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('registry checks: a missing repository is BLOCKED (a push would create it public)', () => {
  const h = setup({ registry: true, sshSlow: true, scenario: { hub: { repo: 404 } } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: harnessorg\/documenso does not exist on Docker Hub/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('registry checks: a repository reported not private is BLOCKED', () => {
  const h = setup({ registry: true, sshSlow: true, scenario: { hub: { private: false } } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: harnessorg\/documenso on Docker Hub is not private/);
  assertNothingBuilt(r);
  cleanup(h);
});

// -- Release ------------------------------------------------------------------

test('happy path: build, ship, rollback point, backup, retag, preview, up, health, promote, clean', () => {
  const h = setup();
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`DEPLOYED: production is running \\S+ \\(${h.sha}\\)`));

  const build = at(r, 'local docker build --platform linux/amd64');
  const predeploy = at(r, `remote docker tag sha256:old documenso-fantasy:predeploy-${h.sha}`);
  const dump = at(r, 'remote docker exec c-db sh -c exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"');
  const retag = at(r, `remote docker tag documenso-fantasy:${h.sha} ${LIVE_REF}`);
  const preview = at(r, 'run --rm --no-deps -T documenso npx prisma migrate status');
  const up = at(r, 'up -d --no-deps --force-recreate documenso');
  const health = at(r, 'remote curl -s --max-time 10 -w');
  const promote = at(r, `remote docker tag documenso-fantasy:predeploy-${h.sha} documenso-fantasy:rollback`);
  const clean = at(r, 'remote docker rmi documenso-fantasy:0123456789ab');
  const localDrop = at(r, `local docker image rm documenso-fantasy:${h.sha}`);
  const order = [build, predeploy, dump, retag, preview, up, health, promote, clean, localDrop];
  assert.ok(
    order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
    `order build<predeploy<dump<retag<preview<up<health<promote<clean<local drop: ${order}\n${r.calls}`,
  );
  assert.match(r.calls, new RegExp(`--label org.opencontainers.image.revision=${h.fullSha}`));
  assert.match(r.calls, /local docker build .* -f docker\/Dockerfile -t documenso-fantasy:[0-9a-f]{12} -\n/);

  // Host state after the release.
  const s = r.remoteState;
  const newId = s.tags[`documenso-fantasy:${h.sha}`];
  assert.ok(newId?.startsWith('sha256:built'), 'the new image is on the host under its commit tag');
  assert.equal(s.tags[LIVE_REF], newId, 'the compose tag names the new image');
  assert.equal(s.containers.documenso.image, newId, 'the app container runs the new image');
  assert.equal(s.tags['documenso-fantasy:rollback'], 'sha256:old', 'rollback is the previously running image');
  assert.ok(!s.tags[`documenso-fantasy:predeploy-${h.sha}`], 'the predeploy tag is consumed');
  assert.ok(!s.tags['documenso-fantasy:0123456789ab'], 'an old commit tag is dropped');
  assert.ok(!s.images['sha256:older'], 'the superseded rollback image is removed by id');
  assert.ok(s.images['sha256:old'], 'the rollback image is kept');
  assert.equal(
    Object.keys(s.tags)
      .filter((t) => t.startsWith('documenso-fantasy:'))
      .sort()
      .join(' '),
    [LIVE_REF, `documenso-fantasy:${h.sha}`, 'documenso-fantasy:rollback'].sort().join(' '),
  );

  // The backup.
  assert.equal(r.backups.length, 1, r.backups.join(' '));
  assert.match(r.backups[0], new RegExp(`^documenso-\\d{8}T\\d{6}Z-${h.sha}\\.sql\\.gz$`));
  const file = join(h.backups, r.backups[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(sh(h.root, `gzip -dc ${file}`), /PostgreSQL database dump complete/);

  // The preview is printed with the URL masked.
  assert.match(r.out, /20261101000000_next/);
  assert.ok(!r.out.includes('harness-secret'), 'a URL in the preview is masked');
  assert.match(r.out, /<url>/);

  // The local machine keeps nothing of this release.
  assert.ok(!r.localState.tags[`documenso-fantasy:${h.sha}`], 'local image tag removed');
  assertNeverTouchesProject(r);
  cleanup(h);
});

test('MIGRATION_PREVIEW=0 skips the one-off container', () => {
  const h = setup();
  const r = run(h, { env: { MIGRATION_PREVIEW: '0' } });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.calls.includes(' run --rm'), r.calls);
  cleanup(h);
});

test('backup fails: nothing on the host changes, the predeploy tag is withdrawn', () => {
  const h = setup({ scenario: { dump: 'fail' } });
  const before = JSON.parse(readFileSync(join(h.root, 'state-remote.json'), 'utf8'));
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /ABORTED: the database backup failed or is incomplete. Nothing was changed/);
  assert.ok(!has(r, `tag documenso-fantasy:${h.sha} ${LIVE_REF}`), 'no retag');
  assert.ok(!r.calls.includes(' up -d'), 'no up');
  assert.deepEqual(r.backups, [], 'no partial backup left');
  const after = r.remoteState;
  delete after.tags[`documenso-fantasy:${h.sha}`];
  for (const id of Object.keys(after.images)) {
    if (id.startsWith('sha256:built')) delete after.images[id];
  }
  assert.deepEqual(after.tags, before.tags, 'tags as before (apart from the shipped image)');
  assert.deepEqual(after.containers, before.containers, 'containers as before');
  assertNeverTouchesProject(r);
  cleanup(h);
});

test('backup without the dump trailer counts as failed', () => {
  const h = setup({ scenario: { dump: 'truncated' } });
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /ABORTED: the database backup failed or is incomplete/);
  assert.ok(!r.calls.includes(' up -d'), 'no up');
  assert.deepEqual(r.backups, []);
  cleanup(h);
});

test('old backups beyond BACKUP_KEEP are removed; other files are not', () => {
  const h = setup({ oldBackups: 6 });
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  const ours = r.backups.filter((f) => f.endsWith('.sql.gz'));
  assert.equal(ours.length, 5, r.backups.join(' '));
  assert.ok(ours.some((f) => f.includes(h.sha)), 'the new backup is kept');
  assert.ok(!ours.includes('documenso-20260100T000000Z-aaaaaaaaaaaa.sql.gz'), 'the oldest went');
  assert.ok(r.backups.includes('unrelated-file.txt'), 'files this script did not write stay');
  cleanup(h);
});

test('health never 200: roll back to the previous image, exit non-zero, name the backup', () => {
  const h = setup({ scenario: { healthNew: { code: 502, status: 'none' } } });
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /RELEASE FAILED: no healthy response from the new image/);
  assert.match(r.out, /Database migrations are NOT rolled back/);
  assert.match(r.out, new RegExp(`database backup taken before this release is ${h.backups}/documenso-\\S+\\.sql\\.gz`));
  assert.match(r.out, /The previous image is serving again/);
  const ups = r.lines.filter((l) => l.includes(' up -d --no-deps --force-recreate documenso'));
  assert.equal(ups.length, 2, 'up once forward, once back');
  const s = r.remoteState;
  assert.equal(s.tags[LIVE_REF], 'sha256:old', 'the compose tag names the old image again');
  assert.equal(s.containers.documenso.image, 'sha256:old', 'the old image is running');
  assert.equal(s.tags['documenso-fantasy:rollback'], 'sha256:older', 'rollback is not advanced');
  assert.ok(!has(r, `tag documenso-fantasy:predeploy-${h.sha} documenso-fantasy:rollback`));
  assert.ok(!r.out.includes('DEPLOYED'));
  assertNeverTouchesProject(r);
  cleanup(h);
});

test('health 200 with status "error" also rolls back', () => {
  const h = setup({ scenario: { healthNew: { code: 200, status: 'error' } } });
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /RELEASE FAILED/);
  assert.equal(r.remoteState.containers.documenso.image, 'sha256:old');
  cleanup(h);
});

test('certificate available before and not after: roll back', () => {
  const h = setup({ scenario: { certOld: true, certNew: false } });
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /RELEASE FAILED: the signing certificate was available before this release and is not now/);
  assert.equal(r.remoteState.containers.documenso.image, 'sha256:old');
  cleanup(h);
});

test('certificate missing before and after: a warning, not a failure', () => {
  const h = setup({ scenario: { certOld: false, certNew: false } });
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARNING: the signing certificate is not available \(before: no\)/);
  cleanup(h);
});

test('an image built for the wrong architecture is refused before anything changes', () => {
  const h = setup({ scenario: { buildArch: 'arm64' } });
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /BLOCKED: documenso-fantasy:[0-9a-f]{12} is built for 'arm64', not amd64/);
  assert.ok(!has(r, 'remote docker tag sha256:old'), 'no rollback point taken');
  assert.ok(!r.calls.includes(' up -d'));
  cleanup(h);
});

test('an unexpected failure after the retag (compose up errors) rolls back through the exit trap', () => {
  const h = setup({ scenario: { upFailsOnce: true } });
  const r = run(h);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /RELEASE FAILED: the release stopped unexpectedly/);
  assert.match(r.out, /Database migrations are NOT rolled back/);
  assert.equal(r.remoteState.tags[LIVE_REF], 'sha256:old', 'the compose tag names the old image again');
  assert.equal(r.remoteState.containers.documenso.image, 'sha256:old');
  assert.equal(r.remoteState.tags['documenso-fantasy:rollback'], 'sha256:older', 'rollback is not advanced');
  assertNeverTouchesProject(r);
  cleanup(h);
});

test('the release is a no-op when the host already runs this commit', () => {
  const h = setup();
  assert.equal(run(h).status, 0);
  writeFileSync(join(h.root, 'calls.log'), '');
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already runs documenso-fantasy:[0-9a-f]{12}; nothing to release/);
  assert.ok(!r.calls.includes(' up -d'), 'no recreate');
  assert.ok(!has(r, 'remote docker exec'), 'no backup');
  cleanup(h);
});

// -- Build heap -----------------------------------------------------------------

test('the build gets NODE_OPTIONS with a 4096 MB heap by default', () => {
  const h = setup();
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /local docker build .*--build-arg NODE_OPTIONS=--max-old-space-size=4096 /);
  cleanup(h);
});

test('BUILD_NODE_HEAP_MB sets the heap', () => {
  const h = setup();
  const r = run(h, { env: { BUILD_NODE_HEAP_MB: '3072' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /--build-arg NODE_OPTIONS=--max-old-space-size=3072 /);
  cleanup(h);
});

test('a BUILD_NODE_HEAP_MB that is not a whole number is refused', () => {
  const h = setup();
  const r = run(h, { env: { BUILD_NODE_HEAP_MB: '4g' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: BUILD_NODE_HEAP_MB must be a whole number, not '4g'/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('too little Docker memory for the heap plus 2 GB: BLOCKED before ssh and build', () => {
  const h = setup({ scenario: { dockerMem: 6 * 1024 * 1024 * 1024 - 1 } });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: Docker has 6143 MB of memory; the build needs BUILD_NODE_HEAP_MB \(4096\) \+ 2048 MB/);
  assert.match(r.out, /Raise the memory limit in Docker Desktop/);
  assert.ok(!has(r, 'local ssh'), r.calls);
  assertNothingBuilt(r);
  cleanup(h);
});

test('exactly the heap plus 2 GB is enough', () => {
  const h = setup({ scenario: { dockerMem: 6 * 1024 * 1024 * 1024 } });
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  cleanup(h);
});

// -- Host states and the first release ------------------------------------------

test('database container gone but its volume left: BLOCKED with the command to start only the database', () => {
  const h = setup({ noDb: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the database volume documenso-production_database is still here, but there is no 'database' container/);
  assert.match(r.out, /up -d --no-deps database/);
  assert.ok(!r.calls.includes(' up '), 'nothing is started');
  assertNothingBuilt(r);
  cleanup(h);
});

test('database gone with its volume, app still there: BLOCKED as a host that never ran the stack', () => {
  const h = setup({ noDb: true, volumes: [] });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: no 'database' container and no volume documenso-production_database: this host has never run this stack/);
  assert.match(r.out, /新服务器上的首次发布/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('a new server without FIRST_RELEASE: BLOCKED pointing at the README, nothing started', () => {
  const h = setup({ fresh: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: there is no 'documenso' container on this host/);
  assert.match(r.out, /FIRST_RELEASE=1/);
  assert.ok(!r.calls.includes(' up '), 'nothing is started');
  assertNothingBuilt(r);
  cleanup(h);
});

test('app container missing without FIRST_RELEASE: BLOCKED pointing at the README', () => {
  const h = setup({ noApp: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: there is no 'documenso' container on this host/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('FIRST_RELEASE=1 on a host that has the app: BLOCKED, this is not a first release', () => {
  const h = setup();
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: FIRST_RELEASE=1, but this host already has a 'documenso' container: this is not a first release/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('ALLOW_EMPTY_DATABASE=1 without FIRST_RELEASE is refused', () => {
  const h = setup();
  const r = run(h, { env: { ALLOW_EMPTY_DATABASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: ALLOW_EMPTY_DATABASE=1 only means something with FIRST_RELEASE=1/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('first release, empty database: started, found empty, BLOCKED before any build; app never started', () => {
  const h = setup({ fresh: true, scenario: { migrations: -1 } });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the database is empty \(no _prisma_migrations records\)/);
  assert.match(r.out, /no users, no API tokens, no documents/);
  assert.match(r.out, /restore the old server's backup first/);
  assert.match(r.out, /FIRST_RELEASE=1 ALLOW_EMPTY_DATABASE=1/);
  assert.ok(has(r, 'up -d database'), r.calls);
  assert.ok(!r.calls.includes('up -d --no-deps documenso'), 'the app is never started');
  assert.ok(!r.remoteState.containers.documenso, 'no app container');
  assertNothingBuilt(r);
  assertNeverTouchesProject(r, { first: true });
  cleanup(h);
});

test('first release, migrations table present but empty: still empty', () => {
  const h = setup({ fresh: true, scenario: { migrations: 0 } });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the database is empty/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('first release, database never healthy: BLOCKED, left running, nothing built', () => {
  const h = setup({ fresh: true, scenario: { dbHealth: 'starting' } });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: 'database' did not become healthy \(last: starting\)/);
  assert.ok(r.remoteState.containers.database, 'the database container stays');
  assertNothingBuilt(r);
  cleanup(h);
});

test('first release, unreadable database: BLOCKED', () => {
  const h = setup({ fresh: true, scenario: { migrations: 'error' } });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: could not read the database/);
  assertNothingBuilt(r);
  cleanup(h);
});

test('first release, a bind-mounted file (the certificate) missing: BLOCKED before the database starts', () => {
  const h = setup({ fresh: true });
  writeFileSync(
    join(h.remote, 'docker', 'production', 'compose.yml'),
    `name: documenso-production\nservices:\n  documenso:\n    volumes:\n      - ${h.root}/no-such-cert.p12:/opt/documenso/cert.p12:ro\n`,
  );
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: docker\/production\/compose.yml mounts host paths that do not exist on this host:/);
  assert.match(r.out, /no-such-cert\.p12/);
  assert.ok(!r.calls.includes(' up '), 'the database is not started');
  assertNothingBuilt(r);
  cleanup(h);
});

test('first release, no bind mount in the compose file: a reminder, not a block', () => {
  const h = setup({ fresh: true });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARNING: .*bind-mounts no host path; check by hand that the signing certificate/);
  cleanup(h);
});

test('first release with restored data: db up, data check, build, ship, backup, app up, health', () => {
  const h = setup({ fresh: true });
  const cert = join(h.root, 'cert.p12');
  writeFileSync(cert, 'fake');
  writeFileSync(
    join(h.remote, 'docker', 'production', 'compose.yml'),
    `name: documenso-production\nservices:\n  documenso:\n    image: ${LIVE_REF}\n    volumes:\n      - ${cert}:/opt/documenso/cert.p12:ro\n`,
  );
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FIRST RELEASE/);
  assert.match(r.out, /bind-mounted host paths present: .*cert\.p12/);
  assert.match(r.out, /database holds Documenso data \(12 applied migrations recorded\)/);
  assert.match(r.out, /no rollback point/);
  const dbUp = at(r, 'up -d database');
  const check = at(r, 'remote psql-stdin');
  const build = at(r, 'local docker build');
  const ship = at(r, 'remote docker load');
  const dump = at(r, 'exec pg_dump');
  const retag = at(r, `remote docker tag documenso-fantasy:${h.sha} ${LIVE_REF}`);
  const appUp = at(r, 'up -d --no-deps documenso');
  const health = at(r, 'remote curl -s --max-time 10 -w');
  const order = [dbUp, check, build, ship, dump, retag, appUp, health];
  assert.ok(
    order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
    `order dbUp<check<build<ship<dump<retag<appUp<health: ${order}\n${r.calls}`,
  );
  assert.equal(r.lines.filter((l) => l.includes(' up -d database')).length, 1, 'the database is started once');
  assert.ok(!r.calls.includes('--force-recreate'), 'nothing to recreate');
  assert.ok(!has(r, 'predeploy-'), 'no rollback point');
  assert.equal(r.backups.length, 1, 'restored data is backed up before the app touches it');
  const s = r.remoteState;
  assert.equal(s.containers.documenso.image, s.tags[`documenso-fantasy:${h.sha}`], 'the app runs the new image');
  assert.equal(s.tags[LIVE_REF], s.tags[`documenso-fantasy:${h.sha}`]);
  assert.ok(!s.tags['documenso-fantasy:rollback'], 'no rollback tag yet');
  assert.ok(r.calls.includes('psql-stdin select to_regclass'), 'the query travels on stdin');
  assert.ok(!/docker exec [^\n]*select/.test(r.calls), 'no SQL on the command line');
  assertNeverTouchesProject(r, { first: true });
  cleanup(h);
});

test('first release on an empty database with ALLOW_EMPTY_DATABASE=1: no backup, release goes on', () => {
  const h = setup({ fresh: true, scenario: { migrations: -1 } });
  const r = run(h, { env: { FIRST_RELEASE: '1', ALLOW_EMPTY_DATABASE: '1' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARNING: the database is empty and ALLOW_EMPTY_DATABASE=1: this release creates a brand-new instance/);
  assert.match(r.out, /no backup to take/);
  assert.ok(!has(r, 'exec pg_dump'), 'no pg_dump');
  assert.deepEqual(r.backups, []);
  assert.ok(has(r, 'up -d --no-deps documenso'));
  assertNeverTouchesProject(r, { first: true });
  cleanup(h);
});

test('first release, health fails: no rollback, no down, database container and volume untouched', () => {
  const h = setup({ fresh: true, scenario: { healthNew: { code: 502, status: 'none' } } });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /RELEASE FAILED: no healthy response from the new image/);
  assert.match(r.out, /No rollback target \(first release\)/);
  assert.match(r.out, /logs --tail 200 documenso/);
  assert.equal(r.lines.filter((l) => / up -d /.test(l) && l.includes('documenso')).length, 1, 'no second up');
  const s = r.remoteState;
  assert.equal(s.containers.database.id, 'c-new-database', 'the database container stays');
  assert.ok(s.volumes.includes('documenso-production_database'), 'its volume stays');
  assert.ok(s.containers.documenso, 'the app container is left for inspection');
  assert.ok(!r.out.includes('DEPLOYED'));
  assertNeverTouchesProject(r, { first: true });
  cleanup(h);
});

test('the existing-host release never asks the database with psql and never starts it', () => {
  const h = setup();
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.ok(!has(r, 'psql'), r.calls);
  assert.ok(!has(r, 'up -d database'), r.calls);
  cleanup(h);
});

// -- Transport probe --------------------------------------------------------------

test('fast ssh upload wins over a registry set-up', () => {
  const h = setup({ registry: true });
  const r = run(h);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /travels by ssh \(ssh upload is fast/);
  assert.ok(has(r, 'local docker save'), r.calls);
  assert.ok(!has(r, 'docker push') && !has(r, 'hub.docker.com'), 'no registry use at all');
  cleanup(h);
});

test('slow ssh upload and no registry: BLOCKED before any build, push or save; probe ended', () => {
  const h = setup({ sshSlow: true });
  const r = run(h);
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: the ssh upload to deploy-target is slow \(1 MB not sent within 2s\), and this machine is not set up for the registry:/);
  assert.match(r.out, /missing .*dockerhub-repo/);
  assert.match(r.out, /SHIP=ssh deployment\/deploy.sh production/);
  assert.ok(!has(r, 'docker build') && !has(r, 'docker push') && !has(r, 'docker save'), r.calls);
  assert.ok(!has(r, 'remote docker'), 'the host is not touched');
  const pid = Number(readFileSync(join(h.root, 'probe-pid'), 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), 'the probe process is gone');
  cleanup(h);
});

test('explicit SHIP=registry does not probe', () => {
  const h = setup({ registry: true });
  const r = run(h, { env: { SHIP: 'registry' } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /travels by registry \(SHIP=registry\)/);
  assert.ok(!has(r, 'cat > /dev/null'), r.calls);
  cleanup(h);
});

test('SHIP=ssh on a slow link ships anyway, without probing', () => {
  const h = setup({ sshSlow: true });
  const r = run(h, { env: { SHIP: 'ssh' } });
  assert.equal(r.status, 0, r.out);
  assert.ok(!has(r, 'cat > /dev/null'), r.calls);
  assert.ok(has(r, 'local docker save'), r.calls);
  cleanup(h);
});

test('SSH_PROBE_MB and SSH_PROBE_SECONDS must be whole numbers', () => {
  const h = setup();
  let r = run(h, { env: { SSH_PROBE_MB: '8M' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: SSH_PROBE_MB must be a whole number, not '8M'/);
  r = run(h, { env: { SSH_PROBE_SECONDS: '1.5' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: SSH_PROBE_SECONDS must be a whole number, not '1.5'/);
  r = run(h, { env: { SSH_PROBE_SECONDS: '0' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /BLOCKED: SSH_PROBE_SECONDS must be at least 1/);
  assert.equal(r.calls, '');
  cleanup(h);
});

test('first release: the probe runs before the database is started', () => {
  const h = setup({ fresh: true, sshSlow: true });
  const r = run(h, { env: { FIRST_RELEASE: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /ssh upload to deploy-target is slow/);
  assert.ok(!r.calls.includes(' up '), 'a slow link with no registry stops before the database starts');
  cleanup(h);
});
