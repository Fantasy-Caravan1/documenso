# Fantasy Documenso 发布流程

在开发机上构建镜像，送到服务器，只替换应用容器。

```bash
deployment/deploy.sh production
```

- `deployment/deploy.sh`：开发机端，macOS 自带的 bash 3.2 可跑。
- `deployment/deploy-remote.sh`：服务器端，由 `deploy.sh` 经 ssh 管道送过去执行（`bash -s`），服务器上不留副本。不要手工运行。
- `deployment/__tests__/`：两个脚本的测试，见文末。

> **这套 Documenso 由生产和 staging 两边的 ERP 共用。** 发布时应用容器会重建，签字页面、ERP 发起签字、webhook 回调都会中断几十秒（启动时还要跑迁移，有新迁移时更久）。挑没人签字的时候发。

这个仓库是公开的：脚本和本文不写服务器地址、仓库账号、任何密钥。这些都放在开发机的 `~/.config/fantasy-documenso/` 里，见下。

## 一次性准备（开发机）

### 1. 目标主机

二选一：

```bash
# 长期：写进配置文件（一行，ssh 目标或 ~/.ssh/config 里的别名）
mkdir -p ~/.config/fantasy-documenso
echo '<ssh 目标或别名>' > ~/.config/fantasy-documenso/ssh-host

# 临时：只对这一次生效
SSH_HOST=<ssh 目标或别名> deployment/deploy.sh production
```

没有默认值。两处都没有时脚本 BLOCKED 并提示怎么配。ssh 要能免密码登录（脚本用 `BatchMode=yes`），登录用户要能用 docker、能写 `BACKUP_DIR`。

### 2. 镜像仓库（推荐）

办公网对 22 端口上行限速（实测 ssh 40 KB/s，HTTPS 7.4 MB/s），Documenso 镜像有 1 GB 量级，走 ssh 管道要几个小时。所以默认走 Docker Hub 私有仓库：

1. 在 Docker Hub 上**先**建一个**私有**仓库（push 到不存在的仓库会自动建成公开的，脚本会拦下这种情况，但别依赖它）。
2. 开发机 `docker login`，用能 push 的 token。
3. 建一个只读（pull）token，写进配置：

```bash
echo '<id>/<name>' > ~/.config/fantasy-documenso/dockerhub-repo
printf '%s\n' '<只读 token>' > ~/.config/fantasy-documenso/dockerhub-pull-token
chmod 600 ~/.config/fantasy-documenso/dockerhub-pull-token
```

pull token 不是同一个账号的时候，用 `REGISTRY_USER=<账号>` 指定。两份文件都在时自动走仓库；缺任何一份就走 ssh 管道。`SHIP=registry` / `SHIP=ssh` 可以强制指定。

## 发布前

1. 改动已合进 `fantasy-production-overlay` 并**已推送**到 `origin`。
2. 本机切到它：`git switch --detach origin/fantasy-production-overlay`（或本地同名分支、已和 origin 一致）。
3. 工作区干净。
4. Docker Desktop 在运行，磁盘够（构建全程在 amd64 模拟下进行，慢，见“已知的未确认项”）。

## 每一步做什么

### 预检（全部在构建之前；任何一项不过都不构建、不推送）

| 顺序 | 检查 | 在哪 |
|---|---|---|
| 1 | 参数必须是 `production` | 开发机 |
| 2 | 工作区干净 | 开发机 |
| 3 | `git fetch origin` 后 HEAD 等于 `origin/fantasy-production-overlay` | 开发机 |
| 4 | 有目标主机（`SSH_HOST` 或 `ssh-host` 文件），格式合法 | 开发机 |
| 5 | 选传输方式（仓库 / ssh） | 开发机 |
| 6 | 本机 docker 可用（`docker info`） | 开发机 |
| 7 | ssh 能连（BatchMode，15 秒超时） | 开发机 |
| 8 | `REMOTE_DIR`、compose 文件、env 文件存在；docker 可用 | 服务器（`MODE=preflight`） |
| 9 | `documenso` 恰好一个容器在运行；`database` 在运行 | 服务器 |
| 10 | 运行中的应用容器是从 `documenso-fantasy:<tag>` 启动的，且 compose 文件现在仍写这个引用 | 服务器 |
| 11 | docker 数据目录所在盘剩余 ≥ `MIN_FREE_GB` | 服务器 |
| 12 | `BACKUP_DIR` 能建、能写 | 服务器 |
| 13 | 走仓库时：仓库格式、token 文件 600、匿名访问不是 200（不是公开仓库）、pull token 能换到 JWT、带 token 访问返回 200 且 `is_private: true` | 开发机 |

### [1/4] 构建

```
git archive <commit> | docker build --platform linux/amd64 \
  --label org.opencontainers.image.revision=<完整 sha> \
  --label org.opencontainers.image.version=<git describe> \
  -f docker/Dockerfile -t documenso-fantasy:<12 位 sha> -
```

构建上下文是 `git archive` 打出的提交本身，不是工作目录：`docker/Dockerfile` 第一步是 `COPY . .`，而 `.dockerignore` 不排除 `.turbo` 缓存和 `.gitignore` 里藏起来的本地文件。`docker/Dockerfile`、`docker/start.sh`、`docker/production/compose.yml` 都不改，提交号靠 label 记进镜像。

服务器是 x86_64，Dockerfile 在 installer 阶段现场编译原生模块（aws-crt、sharp、canvas），runner 阶段直接拷 installer 的 `node_modules`，所以在 Apple Silicon 上整个构建都在模拟下跑。

### [2/4] 传输

- **仓库**：本机打成 `<repo>:documenso-production-<sha>` 推上去；服务器在临时 `DOCKER_CONFIG` 里用只读 token 登录（token 走 ssh 的 stdin，不进命令行，拉完即删配置），`pull` 后改名为 `documenso-fantasy:<sha>`，删掉仓库名的 tag。
- **ssh**：`docker save | gzip -1 | ssh … 'gunzip | docker load'`，带进度条，两端都不落盘。

### [3/4] 服务器上发布（`deploy-remote.sh`，`MODE=release`）

1. 再跑一遍上面服务器端的预检。
2. 确认 `documenso-fantasy:<sha>` 在服务器上，label 等于这次的完整 sha，架构是 amd64。运行中的容器已经是这个镜像时，什么都不做，直接成功。
3. **回滚点**：把**运行中容器**的 image id 打成 `documenso-fantasy:predeploy-<sha>`。从容器取而不是从 tag 取，因为 tag 可能被人动过。同时记下证书状态（`/api/certificate-status`）。
4. **备份数据库**：`docker exec` 进 `database` 容器，用它自己的 `POSTGRES_USER` / `POSTGRES_DB` 跑 `pg_dump`（变量在容器里展开，口令不出现在命令行或输出里），gzip 后写到 `BACKUP_DIR/documenso-<UTC 时间>-<sha>.sql.gz`，权限 600。校验 gzip 完整，且结尾有 pg_dump 的 `dump complete` 标记。失败就删掉半成品、撤掉回滚点 tag、退出，**什么都没改**。之后只保留最近 `BACKUP_KEEP` 份（只删本脚本命名格式的文件）。
5. **改 tag**：新镜像打成 compose 文件里写死的引用（目前是 `documenso-fantasy:2.14.0-email-template`；从运行中容器的 `.Config.Image` 读，不在脚本里写死）。从这里起，任何非正常退出都会自动回滚。
6. **迁移预览**（`MIGRATION_PREVIEW=1`，默认开）：`docker compose run --rm --no-deps -T documenso npx prisma migrate status`，用新镜像起一个一次性容器，环境变量由 compose 自己注入，脚本不经手数据库 URL。输出里的任何 URL 都会被替换成 `<url>`。只打印、不判定（有待执行迁移时 prisma 本身就是非零退出）。
7. **切换**：`docker compose --env-file .env.production -f docker/production/compose.yml up -d --no-deps --force-recreate documenso`。只重建应用服务；**绝不 `down`，不碰 `database` 服务和它的卷**。项目名、服务名、容器名 `documenso-production-documenso-1`、网络 `documenso-production_default` 都不变（ERP 以外部网络方式接在这个网络上，并按容器名调用）。
8. **健康检查**（最多 `HEALTH_RETRIES` 次，每次间隔 `HEALTH_INTERVAL` 秒；容器启动时要先跑迁移）：
   - `http://127.0.0.1:${APP_PORT}/api/health` 返回 200，且顶层 `status` 不是 `error`（证书缺失时是 `warning`，算通过）；
   - 运行中的应用容器的 image id 等于新镜像的 id（证明真的换了版本）；
   - `/api/certificate-status`：发布前可用、发布后不可用 → 算失败；两边都不可用 → 只给警告。
9. **失败就回滚**：回滚点打回 compose 引用的 tag，再 `up -d --no-deps --force-recreate documenso`，等它健康，非零退出，并打印“迁移不会回滚，数据库备份在 <路径>”。
10. **成功后**：回滚点推进成 `documenso-fantasy:rollback`，删掉 predeploy tag。清理只限 `documenso-fantasy` 这个镜像名：保留 compose 引用的 tag、`rollback`、本次 sha，其余 `documenso-fantasy:*` tag 去掉；被挤掉的旧 `rollback` 镜像（以及被改 tag 前 compose 引用指向的镜像，如果它和运行中的不是同一个）在没有任何 tag 时按 image id 删掉。不用 `docker image prune`（同机还有别的项目）。

### [4/4] 清理本机

删掉本机上这次的 `documenso-fantasy:<12 位 sha>` 和仓库名 tag。只删 12 位十六进制 tag，本机上 `documenso-fantasy` 的其他 tag 不动。发布失败时脚本在这之前就退出了，本机镜像留着，重试时不用重新构建（`docker build` 命中缓存）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SSH_HOST` | 无（读 `~/.config/fantasy-documenso/ssh-host`） | ssh 目标或别名 |
| `SHIP` | 自动 | `registry` 或 `ssh` |
| `REGISTRY_USER` | 仓库名斜杠前的部分 | pull token 所属账号 |
| `REMOTE_DIR` | `/opt/apps/Perri/documenso/documenso` | 服务器上 Documenso checkout，compose 命令在这里执行 |
| `COMPOSE_FILE` | `docker/production/compose.yml` | 相对 `REMOTE_DIR` |
| `ENV_FILE` | `.env.production` | 相对 `REMOTE_DIR`，手工维护，脚本只检查存在、不读内容 |
| `BACKUP_DIR` | `/opt/apps/Perri/backups/documenso-deploy` | 必须在 `REMOTE_DIR` 之外；目录 700、文件 600 |
| `BACKUP_KEEP` | `5` | 保留的备份份数 |
| `MIN_FREE_GB` | `8` | 服务器 docker 数据盘最少剩余 |
| `APP_PORT` | `3010` | 宿主机上应用端口（只用于健康检查） |
| `HEALTH_RETRIES` | `30` | 健康检查次数 |
| `HEALTH_INTERVAL` | `5` | 每次间隔秒数 |
| `MIGRATION_PREVIEW` | `1` | `0` 关闭迁移预览 |

所有值在送到服务器前都按白名单字符校验，作为环境变量放在 `bash -s` 前面传过去，不进脚本的 argv。

## BLOCKED / 失败提示一览

| 提示 | 含义 / 处理 |
|---|---|
| `usage: deployment/deploy.sh production` | 没写环境名 |
| `BLOCKED: unknown environment '…'` | 只有 `production` |
| `BLOCKED: REMOTE_DIR / BACKUP_DIR / COMPOSE_FILE / ENV_FILE must be …`、`… must be a whole number` | 环境变量格式不对 |
| `BLOCKED: BACKUP_DIR must be outside REMOTE_DIR` | 备份不能放进 checkout |
| `BLOCKED: working tree not clean` | 先提交推送或 stash |
| `BLOCKED: git fetch origin fantasy-production-overlay failed` | 网络或权限问题，无法确认提交已推送 |
| `BLOCKED: HEAD (…) is not origin/fantasy-production-overlay (…)` | 只发布已推送的 overlay 最新提交；切过去或先推送 |
| `BLOCKED: no target host` | 配 `SSH_HOST` 或 `ssh-host` 文件 |
| `BLOCKED: SSH_HOST is not an ssh destination` | 主机名里有不允许的字符 |
| `BLOCKED: SHIP=registry, but the set-up is missing` / `SHIP must be …` | 仓库配置文件缺失 / SHIP 取值不对 |
| `BLOCKED: docker is not running on this machine` | 启动 Docker Desktop |
| `BLOCKED: cannot reach … over ssh` | 主机、密钥、`~/.ssh/config` |
| `BLOCKED: … does not exist on this host` / `… does not exist.` | 服务器上的 `REMOTE_DIR`、compose 文件或 env 文件不在 |
| `BLOCKED: docker is not usable on this host by this user` | ssh 用户没有 docker 权限 |
| `BLOCKED: the 'documenso' service is not running exactly one container` | 应用没在跑（或跑了多个）。本流程只替换正在跑的服务，不负责拉起停掉的服务，先手工处理 |
| `BLOCKED: the 'database' service is not running` | 数据库没在跑，不能备份，不发布 |
| `BLOCKED: the running 'documenso' container was started from '…', not a fixed documenso-fantasy:<tag> reference` | compose 里应用镜像不是 `documenso-fantasy:<tag>`（比如是 digest），改 tag 的做法用不了 |
| `BLOCKED: … no longer names …` | compose 文件在容器启动后被改过，`up` 会用别的镜像；先手工理清 |
| `BLOCKED: only NG free …` | 服务器磁盘不够；`docker builder prune -af` 不碰镜像 |
| `BLOCKED: cannot create the backup directory …` / `… is not writable by …` | 备份目录权限 |
| `BLOCKED: … must hold one line, <id>/<name>`、`REGISTRY_USER is not …`、`… is mode NNN; it must be 600`、`… does not hold a Docker Hub access token` | 仓库配置文件内容或权限不对 |
| `BLOCKED: … on Docker Hub is public` / `… is not private` | 仓库是公开的，先改成私有 |
| `BLOCKED: Docker Hub refused the pull token …` | token 错，或 token 属于别的账号（设 `REGISTRY_USER`） |
| `BLOCKED: … does not exist on Docker Hub (status 404)` | 先在 Docker Hub 建私有仓库 |
| `BLOCKED: the pull token cannot read …` / `Docker Hub did not confirm …` | token 权限或 Docker Hub 故障 |
| `BLOCKED: Docker Hub refused the pull token on the host.` | 服务器端登录失败（已推送，未发布） |
| `BLOCKED: documenso-fantasy:<sha> is not on this host` / `… is labelled revision …` / `… is built for '…', not amd64` | 传输没落地或镜像不对；服务器上什么都没改 |
| `!! ABORTED: the database backup failed or is incomplete. Nothing was changed.` | 备份失败；服务器上什么都没改（回滚点 tag 已撤） |
| `!! RELEASE FAILED: …` | 切换后不健康，已自动回滚；看后面几行是否 “previous image is serving again” |
| `!! The previous image did NOT come back healthy. Manual intervention required` | 回滚后旧镜像也起不来，见下面手工回滚 / 恢复 |
| `WARNING: the signing certificate is not available` | 证书缺失，发布前就缺，不算失败；签字文件无法封存，需要处理 `/opt/documenso/cert.p12` |

## 手工回滚

服务器上，在 `REMOTE_DIR` 里：

```bash
cd /opt/apps/Perri/documenso/documenso
REF="$(docker inspect -f '{{.Config.Image}}' documenso-production-documenso-1)"   # compose 引用的 tag
docker tag documenso-fantasy:rollback "$REF"
docker compose --env-file .env.production -f docker/production/compose.yml up -d --no-deps --force-recreate documenso
curl -s http://127.0.0.1:3010/api/health
```

**迁移不会随镜像回滚**。新版本跑过的迁移留在库里。旧代码一般能在多了列/表的库上跑；如果不能，就要用备份恢复数据库（下一节）。

## 用备份恢复数据库

会覆盖库里在备份之后发生的一切（签字、新文档、webhook 记录），而且期间 ERP 两边都用不了 Documenso。只在确认需要时做：

```bash
cd /opt/apps/Perri/documenso/documenso
C="docker compose --env-file .env.production -f docker/production/compose.yml"
BACKUP=/opt/apps/Perri/backups/documenso-deploy/documenso-<时间>-<sha>.sql.gz

# 1. 先停应用（只停应用，不 down）
$C stop documenso

# 2. 恢复前再备份一次当前库（以防恢复错）
docker exec documenso-production-database-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > /opt/apps/Perri/backups/documenso-deploy/before-restore-$(date -u +%Y%m%dT%H%M%SZ).sql.gz

# 3. 清空并恢复（备份是普通 SQL；用容器自己的用户名和库名）
docker exec documenso-production-database-1 sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
gzip -dc "$BACKUP" | docker exec -i documenso-production-database-1 sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# 4. 把镜像退回到备份时的版本（备份文件名里的 sha 是当时要发布的新版本；
#    备份时运行的是它之前的版本，通常就是 documenso-fantasy:rollback），再起应用
docker tag documenso-fantasy:rollback "$(docker inspect -f '{{.Config.Image}}' documenso-production-documenso-1)"
$C up -d --no-deps --force-recreate documenso
```

第 3 步假设库里只有 `public` 这一个业务 schema（Documenso 默认如此）；恢复前先 `\dn` 确认。

## 测试

```bash
node --test deployment/__tests__/deploy.test.mjs
bash -n deployment/deploy.sh deployment/deploy-remote.sh
```

不需要 `npm install`。测试在临时 git 仓库里跑 `deploy.sh`，用 PATH 里的替身（`__tests__/stubs.mjs`）代替 docker、ssh、curl、df；ssh 替身把远端命令在本机执行，所以 `deploy-remote.sh` 也真的跑一遍，只是面对的是模拟的服务器状态。它证明的是每条路径的**形状**（调了什么、什么顺序、什么从不调用），不证明真实的 docker、构建或服务器行为。

## 已知的未确认项

- 服务器上的 compose 文件是否有未提交的本地改动；本流程不改它，但 `up` 用的是服务器上那一份。
- 现在跑的 `documenso-fantasy:2.14.0-email-template` 是怎么建的没有记录，不确定它包含 overlay 的哪些提交（尤其后两个：空字段修复、`restart: unless-stopped`），也不确定自家 Prisma 迁移（只允许手写签名）是否已在生产库执行。首次用本流程发布时，迁移预览会列出待执行的迁移。
- `BACKUP_DIR` 默认 `/opt/apps/Perri/backups/documenso-deploy`：ssh 用户能不能写、这块盘够不够放、是否已有别的 Documenso 数据库备份，都要在服务器上确认。
- Docker Hub 仓库是否已建、是否私有。
- 在 M3 上模拟构建的耗时和稳定性；Docker Desktop 的内存（8 GB）是否够。
- 服务器上的 `docker compose` 版本是否支持 `ps --status`、`config --images`（Compose v2 都支持）。
- ssh 连接在发布中途断开时：脚本已整体读入后才执行，自动回滚靠 bash 的 EXIT trap；断在 `up` 之后、健康检查之前时是否能完整回滚，没有在真机上验证过。
