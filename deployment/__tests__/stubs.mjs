// Recording stand-ins for docker, ssh, curl and df, used by deploy.test.mjs.
//
// Two docker "machines" share one stub: the laptop (state-local.json) and the
// host (state-remote.json). The ssh stub runs the remote command on this
// machine with HARNESS_SIDE=remote, so deploy-remote.sh executes for real
// against the host's state. Every call is appended to calls.log as
// "<side> <tool> <args>". Nothing here talks to a network or a database.

export const DOCKER_STUB = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HARNESS_ROOT;
const side = process.env.HARNESS_SIDE === 'remote' ? 'remote' : 'local';
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
const statePath = path.join(root, 'state-' + side + '.json');
const registryPath = path.join(root, 'registry.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.log'), side + ' docker ' + args.join(' ') + '\n');

const load = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const state = load(statePath, { tags: {}, images: {}, containers: {}, next: 1 });
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (s) => process.stdout.write(s);
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};
const readStdin = () => {
  try {
    return fs.readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
};
const resolve = (ref) => {
  if (state.images[ref]) return ref;
  if (state.tags[ref]) return state.tags[ref];
  return null;
};
const repoOf = (ref) => ref.slice(0, ref.lastIndexOf(':'));
const tagsOf = (id) => Object.keys(state.tags).filter((t) => state.tags[t] === id);
const format = (fmt, image, id) => {
  if (fmt === '{{.Id}}') return id;
  if (fmt === '{{.Size}}') return String(image.size || 1000);
  if (fmt === '{{.Architecture}}') return image.arch || 'amd64';
  if (fmt === '{{len .RepoTags}}') return String(tagsOf(id).length);
  if (fmt.includes('org.opencontainers.image.revision')) return image.labels['org.opencontainers.image.revision'] || '';
  return '';
};
const option = (list, name) => {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
};

const cmd = args[0];

if (cmd === 'info') {
  if (side === 'local' && scenario.localDockerDown) fail('Cannot connect to the Docker daemon');
  const fmt = option(args, '--format') || '';
  out(fmt.includes('DockerRootDir') ? (scenario.dockerRoot || '/') + '\n' : '29.0.0\n');
  process.exit(0);
}

if (cmd === 'build') {
  readStdin();
  if (scenario.buildFails) fail('build failed');
  const labels = {};
  args.forEach((a, i) => {
    if (a === '--label') {
      const [k, ...v] = args[i + 1].split('=');
      labels[k] = v.join('=');
    }
  });
  const id = 'sha256:built' + state.next++;
  state.images[id] = { labels, arch: scenario.buildArch || 'amd64', size: 2000 };
  state.tags[option(args, '-t')] = id;
  save();
  process.exit(0);
}

if (cmd === 'image' && args[1] === 'inspect') {
  const fmt = option(args, '-f') || option(args, '--format');
  const ref = args[args.length - 1];
  const id = resolve(ref);
  if (!id) fail('No such image: ' + ref);
  out(format(fmt, state.images[id], id) + '\n');
  process.exit(0);
}

if (cmd === 'tag') {
  const id = resolve(args[1]);
  if (!id) fail('No such image: ' + args[1]);
  state.tags[args[2]] = id;
  save();
  process.exit(0);
}

if (cmd === 'rmi' || (cmd === 'image' && args[1] === 'rm')) {
  const ref = cmd === 'rmi' ? args[1] : args[2];
  if (state.tags[ref]) {
    delete state.tags[ref];
    save();
    process.exit(0);
  }
  if (state.images[ref]) {
    if (tagsOf(ref).length > 0) fail('image is referenced in multiple repositories');
    if (Object.values(state.containers).some((c) => c.image === ref)) fail('image is being used by a container');
    delete state.images[ref];
    save();
    process.exit(0);
  }
  fail('No such image: ' + ref);
}

if (cmd === 'images') {
  const repo = args[1];
  for (const t of Object.keys(state.tags)) {
    if (repoOf(t) === repo) out(t.slice(repo.length + 1) + '\n');
  }
  process.exit(0);
}

if (cmd === 'push') {
  const id = resolve(args[1]);
  const registry = load(registryPath, {});
  registry[args[1]] = { id, image: state.images[id] };
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  process.exit(0);
}

if (cmd === 'login') {
  const token = readStdin().toString().trim();
  if (!process.env.DOCKER_CONFIG) fail('login outside a temporary DOCKER_CONFIG');
  fs.appendFileSync(path.join(root, 'calls.log'), side + ' docker-login token-length=' + token.length + '\n');
  process.exit(0);
}

if (cmd === 'pull') {
  const ref = args[args.length - 1];
  const registry = load(registryPath, {});
  if (!registry[ref]) fail('manifest unknown');
  state.images[registry[ref].id] = registry[ref].image;
  state.tags[ref] = registry[ref].id;
  save();
  process.exit(0);
}

if (cmd === 'save') {
  const id = resolve(args[1]);
  out(JSON.stringify({ ref: args[1], id, image: state.images[id] }));
  process.exit(0);
}

if (cmd === 'load') {
  const saved = JSON.parse(readStdin().toString());
  state.images[saved.id] = saved.image;
  state.tags[saved.ref] = saved.id;
  save();
  out('Loaded image: ' + saved.ref + '\n');
  process.exit(0);
}

if (cmd === 'inspect') {
  const fmt = option(args, '-f');
  const c = Object.values(state.containers).find((x) => x.id === args[args.length - 1]);
  if (!c) fail('No such container');
  out((fmt === '{{.Config.Image}}' ? c.ref : c.image) + '\n');
  process.exit(0);
}

if (cmd === 'exec') {
  if (scenario.dump === 'fail') fail('pg_dump: error: connection failed', 1);
  out('-- PostgreSQL database dump\nCREATE TABLE "User" ();\n');
  if (scenario.dump !== 'truncated') out('-- PostgreSQL database dump complete\n');
  process.exit(0);
}

if (cmd === 'compose') {
  let i = 1;
  while (args[i] === '--env-file' || args[i] === '-f') i += 2;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const service = rest[rest.length - 1];
  if (sub === 'ps') {
    const c = state.containers[service];
    if (c && (c.running || !rest.includes('--status'))) out(c.id + '\n');
    process.exit(0);
  }
  if (sub === 'config') {
    out((scenario.composeImages || ['postgres:15', scenario.liveRef]).join('\n') + '\n');
    process.exit(0);
  }
  if (sub === 'run') {
    out('Datasource "db": PostgreSQL database "documenso" at "postgresql://documenso:harness-secret@database:5432/documenso"\n');
    out('1 migration found in prisma/migrations\nFollowing migration have not yet been applied:\n20261101000000_next\n');
    process.exit(1);
  }
  if (sub === 'up') {
    const svc = rest[rest.length - 1];
    const c = state.containers[svc];
    const id = resolve(c.ref);
    state.containers[svc] = { ...c, id: 'c' + state.next++, image: id, running: true };
    save();
    process.exit(0);
  }
  process.exit(0);
}

process.exit(0);
`;

export const CURL_STUB = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HARNESS_ROOT;
const side = process.env.HARNESS_SIDE === 'remote' ? 'remote' : 'local';
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.log'), side + ' curl ' + args.join(' ') + '\n');
const url = args.find((a) => /^https?:/.test(a)) || '';
const writeOut = args.includes('-w') ? args[args.indexOf('-w') + 1] : '';
if (args.includes('-K')) {
  try {
    fs.readFileSync(0);
  } catch {}
}
const reply = (body, code) => {
  if (args.includes('-o')) {
    process.stdout.write(String(code));
  } else if (writeOut.includes('http_code')) {
    process.stdout.write(body + '\n' + code);
  } else {
    process.stdout.write(body);
  }
  process.exit(0);
};
const hub = scenario.hub || {};
if (url.startsWith('https://hub.docker.com/v2/auth/token')) {
  reply(hub.login === 200 || hub.login === undefined ? '{"access_token":"jwt-harness"}' : '{}', hub.login || 200);
}
if (url.startsWith('https://hub.docker.com/v2/repositories/')) {
  if (args.includes('-K')) reply('{"is_private":' + (hub.private === false ? 'false' : 'true') + '}', hub.repo || 200);
  reply('{}', hub.anon || 404);
}
const state = JSON.parse(fs.readFileSync(path.join(root, 'state-remote.json'), 'utf8'));
const app = state.containers.documenso;
const image = app && state.images[app.image];
const isNew = image && image.labels && image.labels['org.opencontainers.image.revision'] === scenario.fullSha;
const h = isNew ? scenario.healthNew || { code: 200, status: 'ok' } : { code: 200, status: 'ok' };
const cert = isNew ? scenario.certNew : scenario.certOld;
if (url.endsWith('/api/health')) {
  reply('{"status":"' + h.status + '","timestamp":"t","checks":{"database":{"status":"ok"}}}', h.code);
}
if (url.endsWith('/api/certificate-status')) {
  reply('{"isAvailable":' + (cert === false ? 'false' : 'true') + ',"timestamp":"t"}', 200);
}
reply('', 404);
`;

export const SSH_STUB = String.raw`#!/usr/bin/env bash
while [ "$1" = -o ]; do shift 2; done
host="$1"; shift
printf 'local ssh %s %s\n' "$host" "$(printf '%s' "$*" | head -c 80 | tr '\n' ' ')" >> "$HARNESS_ROOT/calls.log"
if [ "$*" = true ]; then
  [ -f "$HARNESS_ROOT/ssh-down" ] && exit 255
  exit 0
fi
HARNESS_SIDE=remote exec bash -c "$*"
`;

export const DF_STUB = String.raw`#!/usr/bin/env bash
echo "$HARNESS_SIDE df $*" >> "$HARNESS_ROOT/calls.log"
echo " Avail"
echo " $(cat "$HARNESS_ROOT/free-gb")G"
`;
