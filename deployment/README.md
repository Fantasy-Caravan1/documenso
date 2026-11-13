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

没有默认值。两处都没有时脚本 BLOCKED 并提示怎么配。可以填 `~/.ssh/config` 里的别名（例如带 `ProxyJump` 的，见下面“目标拓扑”）、`user@host`、主机名或 IP；不能含空白、引号或 `$`。ssh 要能免密码登录（脚本用 `BatchMode=yes`），登录用户要能用 docker、能写 `BACKUP_DIR`。

### 目标拓扑：生产服务器不对外开放 ssh

计划中的布局。生产服务器和开发服务器**都是新建的机器**；现在跑这套 Documenso 的服务器是第三台，即下文的“旧服务器”，搬迁完成后退出。

- **生产服务器**（新）：跑 Documenso，以及 ERP 和 club 的生产容器。22 端口不对外开放。和开发服务器在同一内网。前提：它仍能出网，可以从 Docker Hub 拉 `postgres:15`，走仓库传输时也能从私有仓库拉镜像。
- **开发服务器**（新，也是 staging 服务器）：可以从外面 ssh，跑 ERP 和 club 的 staging，经内网访问生产服务器上的 Documenso（见下面的“staging 经内网访问 Documenso”）。
- **开发机**：开发可能迁到本地，在本地构建镜像，经开发服务器送到生产服务器。
- 到生产服务器的登录和文件传输都经过开发服务器。有两种走法，**走法一是主路径**。

**如果 staging 服务器是旧服务器的完整复制（可能这么做，未定）**，复制出来的机器开机时会带着：

- 这套 Documenso 的应用容器和数据库容器。compose 里是 `restart: unless-stopped`，开机后会自己起来。
- 数据卷 `documenso-production_database` 的一份副本。

这等于出现了**第二个带着生产数据的 Documenso 实例**。它可能用同一份 SMTP 凭证发信，也可能用同一张签署证书签出文件。Documenso 的生产实例只应存在于生产服务器上。所以在复制品联网之前，要把它上面的以下东西停用并删除：

- 应用容器、数据库容器、数据卷；
- `/opt/apps/Perri/documenso/documenso/.env.production`；
- 签署证书 `/opt/documenso/cert.p12`。

做之前要确认：

- 复制的方式能不能做到“先断网开机、处理完再联网”；
- 复制品上还有哪些服务带 `restart` 策略，会跟着自己起来（ERP、club 的生产容器同理）；
- 旧服务器上的数据库备份（`BACKUP_DIR`）要不要一并删除。

这里只是提醒，脚本不做这件事。

**走法一（主路径）：从开发机经跳板。** 在开发机的 `~/.ssh/config` 里给生产服务器配一个别名，`HostName` 写它的内网地址，`ProxyJump` 指向开发服务器：

```sshconfig
Host <开发服务器别名>
    HostName <开发服务器的公网地址或域名>
    User <用户>
    IdentityFile ~/.ssh/<密钥>

Host <生产服务器别名>
    HostName <生产服务器的内网地址>
    User <用户>
    IdentityFile ~/.ssh/<密钥>
    ProxyJump <开发服务器别名>
```

然后把 `SSH_HOST`（或 `~/.config/fantasy-documenso/ssh-host`）填成 `<生产服务器别名>`。脚本照常 `ssh <别名>`，不需要知道跳板的存在。拷证书、`.env.production`、备份时用 `scp`，同样写这个别名。

本地构建后：

- 在公司网络下，测速判慢，镜像本体走 Docker Hub 私有仓库，由生产服务器自己拉。经跳板走的只是命令通道（预检、发布、仓库的 pull token）。
- 不在公司时，测速判快，镜像经跳板走 ssh 管道。

测速逻辑不变。经跳板时，瓶颈是开发机到开发服务器这一段（内网那一段快得多），测速量到的就是这一段，所以“在公司走仓库、在外面走 ssh”的结论照样成立。

**走法二：直接在开发服务器上发。** 在开发服务器上放一份 `fantasy-production-overlay` 的干净 checkout，在那里运行 `deployment/deploy.sh production`，`SSH_HOST` 填生产服务器的内网地址或别名。好处：

- 构建是原生 x86，不经模拟；
- 传输走内网，测速会判快，自动走 ssh 管道；
- 不依赖开发机的网络。

前提见上面“传输方式”一节里同内网主机那一条。

两种走法都连不上时，脚本的 BLOCKED 提示会提醒：生产服务器不对外开放 22 端口，要用带 `ProxyJump` 的别名，或在开发服务器上运行。

**staging 经内网访问 Documenso（方向已定，搬迁前要准备好）**：Documenso 搬到生产服务器后，staging 的 ERP 在开发服务器上，不再和 Documenso 同主机。按业主给的方向，需要准备：

- **staging 访问 Documenso**：
  - Documenso 仍只发布在生产服务器的 `127.0.0.1:3010`，compose 不改。
  - 在生产服务器上，由主机的 nginx 加一个**只绑生产服务器内网地址**的监听（例如 `<生产服务器的内网地址>:<端口>`），转发到 `127.0.0.1:3010`。
  - 安全组和防火墙只对开发服务器放行这个端口。
  - staging ERP 的 Documenso 内部地址改成 `http://<生产服务器的内网地址>:<端口>`。
  - 这份 nginx 配置属于主机配置，不在本仓库里。
- **Documenso 回调 staging**：在 Documenso 里配给 staging 的 webhook URL，以及 `.env.production` 的 `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS`，都要改成开发服务器的内网地址，即 staging ERP 在内网上的回调监听。因为 Documenso 默认拒绝私网地址，所以 bypass 设置里必须列出它。
- **生产 ERP 不变**：它和 Documenso 在同一台主机上，仍按容器名走 Docker 网络 `documenso-production_default`。

以上只是方向，没有在任何主机上配置或验证过。

### 2. 镜像仓库（在公司发布时需要）

办公网对 22 端口上行限速（实测 ssh 40 KB/s，HTTPS 7.4 MB/s），Documenso 镜像有 1 GB 量级，从公司走 ssh 管道要几个小时。所以在公司发布需要 Docker Hub 私有仓库：

1. 在 Docker Hub 上**先**建一个**私有**仓库（push 到不存在的仓库会自动建成公开的，脚本会拦下这种情况，但别依赖它）。
2. 开发机 `docker login`，用能 push 的 token。
3. 建一个只读（pull）token，写进配置：

```bash
echo '<id>/<name>' > ~/.config/fantasy-documenso/dockerhub-repo
printf '%s\n' '<只读 token>' > ~/.config/fantasy-documenso/dockerhub-pull-token
chmod 600 ~/.config/fantasy-documenso/dockerhub-pull-token
```

pull token 不是同一个账号的时候，用 `REGISTRY_USER=<账号>` 指定。传输方式怎么选见下一节。

### 3. 传输方式：按实测选

没设 `SHIP` 时，脚本在确认 ssh 能连上之后、做任何构建之前，往目标主机的 `cat > /dev/null` 送 `SSH_PROBE_MB`（默认 8）MB 的 `/dev/urandom` 数据（不可压缩，ssh 的压缩帮不上忙），限时 `SSH_PROBE_SECONDS`（默认 8）秒：

- 限时内送完算**快** → 走 ssh 管道，即使仓库配置齐全也一样。
- 没送完（探测进程被结束）或 ssh 出错算**慢** → 仓库配置齐全就走仓库；没配置仓库就在构建前 BLOCKED。

显式的 `SHIP=registry` / `SHIP=ssh` 优先，这时不测速。脚本会打印选了哪种、依据是什么。走 ssh 管道时还会提醒：限速可能先快后慢，传得很慢可以 Ctrl-C，带 `SHIP=registry` 重跑。

三种情况：

- **不在公司**（家里、外面）：ssh 上行正常，测速判快，走 ssh 管道。不用配仓库。
- **在公司**：22 端口被限速，测速判慢，走 Docker Hub 仓库，需要先按上一节配好。没配就 BLOCKED。
- **从和目标同一内网的 AWS 主机发**：`SSH_HOST` 用目标的内网地址，测速判快，走 ssh 管道（内网 scp 级速度）。那台主机是 x86_64，构建是原生的、不经模拟（上游说约两分钟），`docker info` 的内存检查取到的是整机内存，逻辑照样成立。前提：那台主机要有 docker（含 buildx）、git、perl，有 `fantasy-production-overlay` 的干净 checkout，并且能 ssh 到目标、在目标上直接用 docker。脚本没有只在 macOS 上成立的写法（`stat` 先试 GNU 形式，测速用后台进程加 kill，不依赖 `timeout`）。


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
| 5 | `SHIP` 取值；`SHIP=registry` 时仓库配置文件都在 | 开发机 |
| 6 | 本机 docker 可用（`docker info`）；Docker 内存 ≥ `BUILD_NODE_HEAP_MB` + 2048 MB | 开发机 |
| 7 | ssh 能连（BatchMode，15 秒超时） | 开发机 |
| 7a | 没设 `SHIP` 时测 ssh 上行速度并选传输方式；慢且没配仓库就 BLOCKED。在服务器端预检之前，所以 `FIRST_RELEASE=1` 时也在起数据库、查空库之前 | 开发机 → 服务器 |
| 8 | `REMOTE_DIR`、compose 文件、env 文件存在；docker 可用 | 服务器（`MODE=preflight`） |
| 9 | 应用容器：没设 `FIRST_RELEASE` 时必须存在且恰好一个在运行；设了 `FIRST_RELEASE=1` 时必须不存在 | 服务器 |
| 9a | `database`：在运行 → 通过；容器在但停着 → BLOCKED（不替人启动）；容器没了但卷 `<项目名>_database` 还在 → BLOCKED（给只起数据库的命令）；容器和卷都没有 → 没设 `FIRST_RELEASE` 时 BLOCKED，设了则留到第 12a 步启动 | 服务器 |
| 10 | 运行中的应用容器是从 `documenso-fantasy:<tag>` 启动的，且 compose 文件现在仍写这个引用 | 服务器 |
| 11 | docker 数据目录所在盘剩余 ≥ `MIN_FREE_GB` | 服务器 |
| 10a | 仅 `FIRST_RELEASE=1`：compose 引用的镜像 tag 从 `compose config --images` 里取唯一的 `documenso-fantasy:<tag>`；compose 文件里挂载的宿主机路径（证书）都存在 | 服务器 |
| 12 | `BACKUP_DIR` 能建、能写 | 服务器 |
| 12a | 仅 `FIRST_RELEASE=1`：`database` 没有容器时 `docker compose … up -d database`（**预检里唯一改动主机的一步**，只起这一个服务），等 healthcheck 变 healthy；然后查库里 `_prisma_migrations` 是否有记录。空库 → BLOCKED，除非 `ALLOW_EMPTY_DATABASE=1` | 服务器 |
| 13 | 走仓库时：仓库格式、token 文件 600、匿名访问不是 200（不是公开仓库）、pull token 能换到 JWT、带 token 访问返回 200 且 `is_private: true` | 开发机 |

### [1/4] 构建

```
git archive <commit> | docker build --platform linux/amd64 \
  --label org.opencontainers.image.revision=<完整 sha> \
  --label org.opencontainers.image.version=<git describe> \
  --build-arg NODE_OPTIONS=--max-old-space-size=<BUILD_NODE_HEAP_MB> \
  -f docker/Dockerfile -t documenso-fantasy:<12 位 sha> -
```

构建上下文是 `git archive` 打出的提交本身，不是工作目录：`docker/Dockerfile` 第一步是 `COPY . .`，而 `.dockerignore` 不排除 `.turbo` 缓存和 `.gitignore` 里藏起来的本地文件。提交号靠 label 记进镜像。`docker/start.sh`、`docker/production/compose.yml` 不改；`docker/Dockerfile` 只改了一处，见下。

服务器是 x86_64，Dockerfile 在 installer 阶段现场编译原生模块（aws-crt、sharp、canvas），runner 阶段直接拷 installer 的 `node_modules`，所以在 Apple Silicon 上整个构建都在模拟下跑。

**Node 堆（`BUILD_NODE_HEAP_MB`，默认 4096）**：V8 的默认堆上限跟着可见内存走。Docker Desktop 的 VM 只有 8 GB 时，默认 old space 约 2 GB；2026-11-13 实测，remix 的 typecheck（`react-router typegen && tsc`）在 QEMU 模拟下跑了约 10 分钟后在 2040 MB 处堆耗尽（exit 134）。所以：

- `docker/Dockerfile` 在 installer 阶段 `RUN turbo run build …` 前加了一行 `ARG NODE_OPTIONS`（带一行注释）。没有默认值、没有 `ENV`：不传 `--build-arg` 时和上游完全一样；传了只在构建期生效，不进最终镜像（runner 阶段没有这个 ARG）。这是 overlay 对 Dockerfile 的唯一改动，把 overlay 挪到新上游版本时记得带上。
- `deploy.sh` 构建时传 `--build-arg NODE_OPTIONS=--max-old-space-size=$BUILD_NODE_HEAP_MB`，并在预检时要求 `docker info` 的 `MemTotal` ≥ `BUILD_NODE_HEAP_MB` + 2048 MB（留给内核、buildkit、模拟器和其他进程）。不够就 BLOCKED：在 Docker Desktop（Settings > Resources）调大内存，或调小 `BUILD_NODE_HEAP_MB`。

**实测（2026-11-13，M3 / 16 GB，Docker Desktop 29.9.3，VM 8 GB，QEMU 模拟，`BUILD_NODE_HEAP_MB=4096`）**：构建成功，用时 1208 秒（约 20 分钟）。其中 `turbo run build` 用了 1098 秒（含 tsc）；`npm prune` 54 秒；runner 阶段的 `prisma generate` 24 秒。这次 `npm ci` 命中了上一次失败构建留下的缓存，冷构建时它约 158 秒，所以冷构建大约 23 分钟。镜像 1.38 GB，架构 amd64，revision label 正确，镜像的 env 和 history 里都没有 `NODE_OPTIONS`。在 `--network none` 的容器里检查过：sharp 0.34.5（libvips 8.17.3）、`@napi-rs/canvas`、`skia-canvas`、`aws-crt`、`@node-rs/bcrypt`、`@prisma/client` 都能加载；Prisma 的 musl query engine 能加载，schema engine 能运行。没有起完整应用，也没连数据库。

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
| `SHIP` | 自动（测速） | `registry` 或 `ssh`；设了就不测速 |
| `SSH_PROBE_MB` | `8` | 测速送多少 MB（整数，≥ 1） |
| `SSH_PROBE_SECONDS` | `8` | 测速限时秒数（整数，≥ 1） |
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
| `FIRST_RELEASE` | `0` | `1` = 新服务器上的首次发布（见下一节） |
| `ALLOW_EMPTY_DATABASE` | `0` | `1` = 首次发布时明知库是空的也继续（新建一个全新实例）；只能和 `FIRST_RELEASE=1` 一起用 |
| `DB_HEALTH_RETRIES` | `30` | 首次发布起数据库后等 healthy 的次数 |
| `DB_HEALTH_INTERVAL` | `5` | 每次间隔秒数 |
| `BUILD_NODE_HEAP_MB` | `4096` | 构建期 Node 的 `--max-old-space-size`（MB，整数，≥ 512）；Docker 内存需 ≥ 它 + 2048 MB |

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
| `BLOCKED: the ssh upload to … is slow (…), and this machine is not set up for the registry:` | ssh 上行太慢又没配仓库。配好 `~/.config/fantasy-documenso/dockerhub-repo` 和 `dockerhub-pull-token`，或明知很慢仍走 ssh：`SHIP=ssh deployment/deploy.sh production` |
| `BLOCKED: SSH_PROBE_MB / SSH_PROBE_SECONDS must be a whole number …` / `… at least 1` | 测速参数不对 |
| `BLOCKED: docker is not running on this machine` | 启动 Docker Desktop |
| `BLOCKED: Docker has N MB of memory; the build needs BUILD_NODE_HEAP_MB (…) + 2048 MB.` | 调大 Docker Desktop 内存，或调小 `BUILD_NODE_HEAP_MB` |
| `BLOCKED: cannot reach … over ssh` | 主机、密钥、`~/.ssh/config` |
| `BLOCKED: … does not exist on this host` / `… does not exist.` | 服务器上的 `REMOTE_DIR`、compose 文件或 env 文件不在 |
| `BLOCKED: docker is not usable on this host by this user` | ssh 用户没有 docker 权限 |
| `BLOCKED: the 'documenso' service is not running exactly one container` | 应用没在跑（或跑了多个）。本流程只替换正在跑的服务，不负责拉起停掉的服务，先手工处理 |
| `BLOCKED: the 'database' container exists but is not running (state: …)` | 数据库容器停了。先看日志查原因，再自己起（提示里给了命令）；脚本不替人启动 |
| `BLOCKED: the database volume <项目>_database is still here, but there is no 'database' container.` | 卷还在、容器没了。按提示只起数据库、核对数据后重跑 |
| `BLOCKED: no 'database' container and no volume …: this host has never run this stack.` | 这台主机没跑过这套栈；看“新服务器上的首次发布”，带 `FIRST_RELEASE=1` |
| `BLOCKED: there is no 'documenso' container on this host. …` | 同上，新服务器要带 `FIRST_RELEASE=1` |
| `BLOCKED: FIRST_RELEASE=1, but this host already has a 'documenso' container: this is not a first release.` | 去掉 `FIRST_RELEASE` |
| `BLOCKED: ALLOW_EMPTY_DATABASE=1 only means something with FIRST_RELEASE=1.` | 两个要一起用 |
| `BLOCKED: … must name exactly one documenso-fantasy:<tag> image for 'documenso'` | 首次发布时 compose 里的应用镜像不是唯一一个 `documenso-fantasy:<tag>` |
| `BLOCKED: … mounts host paths that do not exist on this host:` | 首次发布前证书等挂载文件没放好 |
| `WARNING: … bind-mounts no host path …` / `… mounts paths built from variables …` | 取不到或解析不了挂载路径，人工确认证书在位 |
| `BLOCKED: 'database' did not become healthy (last: …)` | 首次发布起的数据库没变 healthy；容器留着，看日志 |
| `BLOCKED: could not read the database …` | 查 `_prisma_migrations` 失败 |
| `BLOCKED: the database is empty (no _prisma_migrations records).` | **空库**。继续会建出一个没有用户、API token、文档、webhook 配置的全新实例，ERP 签署会全部失败。搬迁就先恢复旧服务器的备份；确实要新建才带 `FIRST_RELEASE=1 ALLOW_EMPTY_DATABASE=1` |
| `WARNING: the database is empty and ALLOW_EMPTY_DATABASE=1 …` | 已获允许的空库：不做备份，继续 |
| `!! No rollback target (first release).` | 首次发布健康检查不过：没有旧镜像可回。应用容器留着看日志；数据库容器和卷不动；迁移不回滚 |
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

## 新服务器上的首次发布 / 把实例搬到新服务器

新服务器上没有 postgres 镜像、没有 `database` 容器、没有数据卷，也没有应用容器。普通发布会在预检时 BLOCKED，需要用 `FIRST_RELEASE=1`。

**最要防的是在空库上把应用起起来。** `start.sh` 会把迁移跑完，健康检查也会通过，看起来一切正常，但用户、API token、文档、webhook 配置全都没有，ERP 的签署会全部失败。所以首次发布会先查库里有没有 `_prisma_migrations` 记录：空库一律 BLOCKED，除非显式带上 `ALLOW_EMPTY_DATABASE=1`。

### 1. 新服务器上先放好

- docker 和 docker compose v2；ssh 用户能直接用 docker（不经 sudo）。
- `REMOTE_DIR`（默认 `/opt/apps/Perri/documenso/documenso`）下的 `docker/production/compose.yml`（overlay 版本），以及手工维护的 `.env.production`。
- 签名证书 `/opt/documenso/cert.p12`，即 compose 里挂载的路径。首次发布会检查 compose 文件里挂载的宿主机路径是否存在。这一步读的是 compose 文件原文，不是 `docker compose config`，所以不会打印 env 的值。
- `BACKUP_DIR` 能写。

证书、`.env.production`、数据库备份这几样文件，从旧服务器经内网 scp 到新服务器最快。新服务器不对外开放 ssh 时，用“目标拓扑”里配的别名（经开发服务器跳板）。在开发机上通过两个别名中转：

```bash
# <旧服务器别名>、<生产服务器别名> 都是 ~/.ssh/config 里的别名；后者带 ProxyJump
scp -3 <旧服务器别名>:/opt/apps/Perri/documenso/documenso/.env.production \
       <生产服务器别名>:/opt/apps/Perri/documenso/documenso/.env.production
scp -3 <旧服务器别名>:/opt/documenso/cert.p12 <生产服务器别名>:/tmp/cert.p12   # 再在生产服务器上放到 /opt/documenso/ 并设好权限
```

或者在能同时 ssh 到两台机器的开发服务器上直接 `scp`，走内网，最快。传完检查两个文件的权限：`.env.production` 和证书都只给需要的用户读。

### 2. 搬数据（新建实例时跳过，改用 `ALLOW_EMPTY_DATABASE=1`）

旧服务器上取一份备份。可以直接用最近一次发布留下的 `BACKUP_DIR/documenso-*.sql.gz`；要最新的数据，就先停掉旧应用，免得备份之后又有新签字：

```bash
cd /opt/apps/Perri/documenso/documenso
docker compose --env-file .env.production -f docker/production/compose.yml stop documenso   # 不是 down
docker exec documenso-production-database-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > /tmp/documenso-move.sql.gz
gzip -t /tmp/documenso-move.sql.gz && gzip -dc /tmp/documenso-move.sql.gz | tail -n 3   # 应以 dump complete 结尾
```

拷到新服务器，然后在新服务器上**只起数据库**并恢复：

```bash
scp -3 <旧服务器别名>:/tmp/documenso-move.sql.gz <生产服务器别名>:/tmp/documenso-move.sql.gz
```

再在新服务器上：

```bash
cd /opt/apps/Perri/documenso/documenso
C="docker compose --env-file .env.production -f docker/production/compose.yml"
$C up -d database
until [ "$(docker inspect -f '{{.State.Health.Status}}' documenso-production-database-1)" = healthy ]; do sleep 2; done
gzip -dc /tmp/documenso-move.sql.gz | docker exec -i documenso-production-database-1 sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# 核对：应有记录，条数与旧库一致
docker exec documenso-production-database-1 sh -c \
  'psql -X -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from _prisma_migrations"'
```

用户名、库名、口令都由容器自己的环境变量提供，不出现在命令行里。新卷是空的，不需要先 DROP。

### 3. 发布

```bash
FIRST_RELEASE=1 deployment/deploy.sh production
```

和普通发布的不同：

- 预检里，如果没有 `database` 容器，脚本会自己 `up -d database`，只起这一个服务（`postgres:15` 由服务器自己从 Docker Hub 拉），等 healthy 后查空库。这是预检里唯一改动主机的一步，放在构建之前，免得白等 20 分钟构建才发现库是空的。按上面第 2 步恢复过数据时，数据库已经在跑，这一步会跳过。
- compose 引用的镜像 tag 从 `compose config --images` 里取，即唯一一个 `documenso-fantasy:<tag>`。这个选项只输出镜像名。
- 没有回滚点，也没有发布前的证书状态。库里有数据就照常先备份；空库（已获允许）跳过备份。
- 起应用用 `up -d --no-deps documenso`。
- 健康检查不过时，打印 `No rollback target (first release)` 和看日志的命令，以非零退出。不 `down`，不动数据库容器和卷。

### 4. 两点提醒

- **先发 Documenso，再起 ERP。** ERP 的应用容器以 external 方式接在 `documenso-production_default` 网络上，这个网络由 Documenso 的 compose 建出来。网络不存在时，ERP 的 compose 起不来。
- **核对网关地址。** 这个网络在新主机上的网关地址可能和旧主机不同，而旧地址被写在 Documenso 的 webhook URL 和 `.env.production` 的 `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` 里。搬完用下面的命令核对，不一致就同时改 webhook 设置和 bypass 设置：

  ```bash
  docker network inspect documenso-production_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
  ```

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
- 服务器上的 `docker compose` 版本是否支持 `ps --status`、`config --images`（Compose v2 都支持）。
- ssh 连接在发布中途断开时：脚本已整体读入后才执行，自动回滚靠 bash 的 EXIT trap；断在 `up` 之后、健康检查之前时是否能完整回滚，没有在真机上验证过。
- 测速的默认值（8 MB / 8 秒，即约 1 MB/s 以上算快）是按“公司 40 KB/s、外面和内网远快于此”定的；限速若先放行一段再收紧，8 MB 可能测不出来，这时按 ssh 管道开始时的提示中断后带 `SHIP=registry` 重跑，或调大 `SSH_PROBE_MB`。
