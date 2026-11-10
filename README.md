# HF Drive

一个自托管的 Web 网盘：**界面跑在 Cloudflare Workers，文件实体存在你自己的 HuggingFace 私有仓库，元数据存在 Cloudflare R2。**

第一次打开会引导你设置管理员账号密码，并绑定 HuggingFace Token 与仓库名 —— 之后不需要再碰任何控制台配置。

```
浏览器
  │
  ├── Cloudflare Worker（静态资源 + /api/*）
  │        ├── Cloudflare R2（自动创建）→ 账号配置、文件索引、分享链接、会话
  │        └── HuggingFace 私有 Dataset 仓库 → 文件分片实体（8MB/片，走 git-lfs）
  └── 首次访问 → 设置向导 → 自动创建 private dataset 仓库
```

---

## 功能

**文件管理**
- 上传文件 / 上传整个文件夹（保留目录结构）/ 拖拽上传（支持拖入文件夹）
- 大文件分片上传（8MB/片），2 路文件并发 + 2 路分片并发，失败自动重试、可续传
- 下载单个文件、多选打包 ZIP、整个文件夹打包 ZIP（流式打包，不占内存，支持中文文件名）
- 新建文件夹、重命名、移动、复制、收藏、搜索（全局模糊搜索）
  - 复制是「同仓库秒复制」：只把已有 LFS 对象的 oid 提交到新路径，不搬运字节，1GB 文件也是秒级完成，且不额外占空间
- 列表 / 网格两种视图，按名称、大小、时间、类型排序
- 多选（Shift 连选、⌘/Ctrl 加选）、右键菜单、拖拽移动到文件夹
- 回收站：删除 → 还原 → 彻底删除（彻底删除会同时清掉 HuggingFace 仓库里的分片）
- 存储用量统计（文件 / 回收站分开计算）

**预览**
- 图片、视频（支持拖动进度条，走 Range 请求）、音频、PDF
- 文本 / 代码在线查看，Markdown 渲染
- 其它类型显示下载入口；预览内可左右切换同目录文件

**分享**
- 生成分享链接，可设提取密码、有效期（1 小时 / 1 天 / 7 天 / 30 天 / 永久）
- 可关闭下载（只允许在线浏览）
- 文件夹分享支持匿名浏览子文件、打包下载
- 分享管理页：查看访问次数、复制链接、取消分享

**安全**
- 首次访问设置向导，密码用 PBKDF2-SHA256（21 万次迭代 + 随机盐）存储。
  > Workers 运行时的 WebCrypto 限制单次 PBKDF2 迭代数 **不得超过 10 万**，
  > 所以实现上拆成 3 轮串联派生（10 万 + 10 万 + 1 万，上一轮输出作为下一轮口令），
  > 累计工作量与一次跑 21 万次等价，不会触发 `Pbkdf2 failed: iteration counts above 100000`。
- 服务端随机会话 Token（存 R2，30 天过期，登出立即吊销），HttpOnly + Secure Cookie
- 登录失败限流：15 分钟内 8 次失败锁定 15 分钟（按 IP）
- HuggingFace Token 只存在 R2，永不下发到浏览器；下载全部经 Worker 代理，不暴露直链
- 修改密码时自动注销其它设备

**界面**
- 亮 / 暗色主题（跟随系统，可手动切换）
- 响应式，手机可用（侧边栏抽屉、工具栏图标化）
- 快捷键：`/` 搜索、`⌘A` 全选、`Delete` 删除、`F2` 重命名、`Backspace` 返回上级、`Esc` 取消

---

## 部署（Cloudflare 控制台连接 GitHub）

### 0. 前置条件

1. 一个 Cloudflare 账号，**并且已经在控制台打开过一次 R2 页面并同意开通**（免费额度就够）。
   > ⚠️ 这是最常见的部署失败原因：没开通 R2 时，自动创建存储桶会直接失败。
2. 一个 HuggingFace 账号，以及一个 **write 权限**的 Access Token：
   <https://huggingface.co/settings/tokens/new?tokenType=write>
3. 本仓库推到你的 GitHub。

### 1. 推到 GitHub

```bash
git init
git add .
git commit -m "init: HF Drive"
git branch -M main
git remote add origin https://github.com/<你>/hf-drive.git
git push -u origin main
```

### 2. 在 Cloudflare 创建 Worker 并连接仓库

控制台 → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**，选择刚推的仓库，然后按下面填写：

| 配置项 | 值 |
| --- | --- |
| Project name | **`hf-drive`**（必须与 `wrangler.jsonc` 里的 `name` 完全一致） |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
| Root directory | 留空（仓库根目录） |

点 **Deploy**。部署时会自动：

- 创建一个名为 `hf-drive-…` 的 R2 存储桶，并绑定为 `env.BUCKET`
- 上传 `public/` 下的静态资源并绑定为 `env.ASSETS`

**不需要配置任何环境变量或 Secret** —— HuggingFace Token 在应用内的设置向导里填。

> ⚠️ 两个必须知道的坑：
> 1. **通过 Dashboard 部署时，R2 桶会被创建、绑定生效，但桶 ID 不会写回仓库里的 `wrangler.jsonc`**。
>    以后如果你想改用本地 `wrangler deploy`，要先去 Dashboard 复制桶名/ID 填进配置，
>    否则 wrangler 会认为「没有桶」而再建一个新的 —— 你会以为数据丢了（其实还在旧桶里）。
> 2. 想换 Worker 名字，等于换一套新资源（新桶、空数据）。改名请在部署前决定。

### 3. 打开域名完成初始化

部署完访问 `https://hf-drive.<你的子域>.workers.dev`，会进入三步向导：

1. 设置管理员用户名 + 密码（至少 8 位）
2. 填 HuggingFace Access Token（会自动校验）
3. 填仓库名（默认 `hf-drive-storage`）→ 点「创建并进入」

提交时会自动：校验 Token → 创建 **private** dataset 仓库（不存在才创建）→ 写一个 `.hfd/repo.json` 验证写权限 → 保存配置 → 直接登录。

---

## 数据是怎么存的

| 数据 | 位置 |
| --- | --- |
| 账号、密码哈希、HF Token、会话 | R2 `sys/config.json`、`sys/sessions/*` |
| 文件树（名称、大小、父子关系、收藏、回收站） | R2 `sys/index.json` |
| 分享链接 | R2 `sys/shares.json` |
| 上传中的分片进度 | R2 `sys/uploads/<文件ID>/*` |
| **文件实体** | HF 仓库 `chunks/<文件ID>/000000.bin`、`000001.bin`…（以 git-lfs 对象存放） |
| 文件自描述元数据 | HF 仓库 `meta/<文件ID>.json`（文件名 + 目录路径） |
| 索引快照 | HF 仓库 `_backup/index.json.gz`（自动，最多 60 秒一次） |

### 为什么分片必须走 git-lfs

HF 现在默认给新仓库开启 **Xet** 存储，服务端会直接拒收「用普通 git blob 提交的二进制内容」：

```
Your push was rejected because it contains binary files.
Please use https://huggingface.co/docs/hub/xet to store binary files.
Offending files: - chunks/f_6v090x1x2y1u/000000.bin
```

所以每个分片的上传是标准 LFS 三步（`src/lib/hf.js` → `uploadChunkLfs`）：

1. `POST /datasets/{repo}.git/info/lfs/objects/batch`，用分片的 SHA-256 换预签名地址
2. `PUT` 到预签名地址，把 8MB 二进制直接传给 HF 的对象存储（不经 Worker 中转）
3. `POST /api/datasets/{repo}/commit/main`，用 `{"key":"lfsFile","value":{path,algo,oid,size}}` 把对象挂到路径上

顺带得到两个好处：

- **天然去重**：内容相同的分片，batch 会返回 `actions: null`，此时跳过 PUT 只提交引用，不占额外空间
- **不占 Worker 内存/带宽**：二进制直传对象存储，Worker 只搬运 8MB 请求体

初始化时还会写一个 `.gitattributes`（`*.bin filter=lfs diff=lfs merge=lfs -text`），
这样即便以后有人用 `git push` 直推，也会被 LFS 接管而不是被 Xet 拦下。

所以：

- **删掉 Worker / R2 不会丢文件**，文件还在 HuggingFace 仓库里；重新部署后到「设置 → 从仓库重建索引」就能把文件扫回来，**文件名和目录结构也能还原**（靠 `_backup/index.json.gz` 快照）。
- **删掉 HuggingFace 仓库会丢文件**（索引还在，但下载会 404）。
- 想整站搬家：把 R2 里 `sys/` 下的几个 JSON 备份走即可。

### 灾难恢复能做到什么程度

| 场景 | 能恢复什么 |
| --- | --- |
| R2 索引丢失，但 `_backup/` 快照还在（默认情况） | 文件名、目录层级、收藏状态、文件内容 —— 100% 还原 |
| 快照也没了，只剩 `meta/<id>.json` | 文件名和目录层级仍可从 meta 还原 |
| 连 meta 都没有（很老的部署） | 只能恢复出内容，名字是 `恢复的文件 xxxxxx` |

快照在每次索引写入后异步刷新，**最多 60 秒延迟**（`handleApi` 里用 `waitUntil` 触发，不拖慢请求）。
它就是一个 gzip 后的 index.json，压缩率很高：实测 5000 个节点的索引 **1305KB → 44KB（29.6 倍）**，gzip 本身只要 18ms；
1 万个文件约 90KB。也可以在「设置 → 立即备份索引」手动刷一次。

上传第一个分片时，会把 `meta/<id>.json`（文件名 + 目录路径）**混在同一次 LFS commit 里**提交，不额外产生请求；
重命名/移动会同步更新它，永久删除时跟着分片一起清掉。

### R2 会占多少空间

**只占元数据，不占文件内容。** 而且元数据大小只和「文件个数」有关，跟「文件多大」完全无关 —— 存 1 个 50GB 文件和存 1 个 1KB 文件，R2 占用是一样的。

`sys/index.json` 实测体积（每条含名称、大小、父子、收藏、回收站标记）：

| 文件数量 | index.json |
| --- | --- |
| 100 | 28 KB |
| 1,000 | 278 KB |
| 10,000 | 2.8 MB |
| 50,000 | 13.6 MB |

也就是说 1 万个文件的网盘，R2 存储占用约 **3 MB**，是免费额度（10 GB）的 0.03%。

不会无节制增长的三处：

- **上传临时标记**（`sys/uploads/<id>/*.json`，每个分片一个几十字节的小文件）在「上传完成」和「取消上传」时都会被 `cleanupUpload()` 整目录删掉，不会残留。
- **过期会话**（`sys/sessions/<token>.json`）在登录时顺带惰性清扫，24 小时最多扫一次，只删 `exp` 已过期的。
- **登录限流记录**（`sys/throttle/<ip>.json`）在登录成功后立即删除。

真正需要留意的是 **Class A 写入次数**（免费 100 万次/月）。索引是单个 JSON，每次改名/移动/收藏都是「读出来 + 整个重写」，而每个分片上传还会写一个临时标记：

| 操作 | R2 写入次数 |
| --- | --- |
| 改名 / 移动 / 收藏 1 次 | 1（重写 index.json） |
| 上传 1 个文件（100MB，13 个分片） | 约 15（13 个分片标记 + 1 次完成 + 1 次索引） |
| 上传 1 个文件（1GB，128 个分片） | 约 130 |
| 下载 / 预览 | 0（索引命中缓存，分片直接读 HuggingFace） |

按 100 万次/月算，够每月上传 **7 TB 左右**，个人使用完全碰不到上限。

---

## 本地开发

```bash
npm install
npx wrangler dev          # 本地 http://localhost:8787，R2 用本地模拟（.wrangler/ 目录）
```

本地不需要任何环境变量，初始化流程和线上一样（会真的调用 HuggingFace API，需要 Token）。

语法检查 / 部署预演：

```bash
node --check src/index.js
npx wrangler deploy --dry-run --outdir=.wrangler/dry-run
```

---

## 性能

针对「每个请求都要打几次 R2」「下载是串行的」「点一下重绘整个列表」这三处做了优化：

| 优化 | 做法 | 实测（注入 R2 12ms / HF TTFB 80ms 的基准） |
| --- | --- | --- |
| 元数据缓存 | 每个 isolate 内对配置、会话、索引、分享做短 TTL 缓存，写路径主动回填；索引 TTL 2s，跨 isolate 最多容忍 2s 延迟 | 列表接口 **40ms → 1ms**，R2 操作 3 → 0 |
| 下载流水线 | 分片预取：消费当前 8MB 分片的同时把下一片的请求发出去，把「串行等 RTT」变成流水线 | 24MB 下载 **549ms → 309ms**（约 -44%） |
| 预览缓存 | 文件按 ID 存放、内容不可变，`?inline=1` 响应改为 `private, max-age=86400` | 列表滚动/重绘不再重复下载缩略图 |
| 选中态增量更新 | 点选只切 class 与 checkbox，不再重建整个列表 DOM | 点击延迟降到亚毫秒级，缩略图不再闪烁 |
| 长列表渲染 | `.ft-row { content-visibility: auto }`，跳过屏幕外行的布局与绘制 | 数百行列表滚动更顺 |
| 上传并发 | 3 文件 × 3 分片并发，429 单独走更长退避 | 大文件上传吞吐提升约 50% |
| 复制零搬运 | 同仓库复制复用已有 LFS oid，只做 1 次 tree 查询 + 1 次 commit | 1GB 文件复制从「下载再上传」变为亚秒级 |
| 分享计数合并写 | 访问计数先进内存，30 秒合并写一次；管理页把未落盘的增量也算上 | 热门分享被刷 1000 次，R2 写入从 1000 次降到 ~2 次 |

基准脚本思路（可自行复现）：用带固定延迟的桩 R2 + 桩 HF 跑 `worker.fetch`，对比「每请求前清空缓存」与「热缓存」两种情况的耗时与 R2 操作次数。

---

## 已知限制

- **单文件上限 50GB**；单次 ZIP 打包上限 3.6GB（未做 zip64）。
- **每个分片 = 3 次 HuggingFace 请求**（LFS batch + 直传 + commit），所以上传 1GB 文件会产生 384 次请求。HF 对 commit 有速率限制，本项目已做退避重试，但超大文件上传会比较慢（这也是分片选 8MB 而不是 1MB 的原因）。
- **复制文件**默认走「同仓库秒复制」（不搬字节，无体积限制）；只有拿不到分片 oid 时（例如仓库未返回 LFS 元数据、或单文件分片数超过 1000）才退回「下载再上传」，此时单次上限 2GB。
- **HuggingFace 仓库文件数量**：1GB 文件 = 128 个文件。HF 对仓库文件数有软限制，个人网盘量级（几千个文件）没问题。
- 元数据是单个 JSON（带 etag 乐观锁重试），几万个文件以内都很轻快。
- 预览图片直接用原图当缩略图（没有服务端缩图能力），超大图会慢一点。
- 忘记密码：删掉 R2 里的 `sys/config.json` 重新走初始化向导，然后用「从仓库重建索引」恢复文件列表。

---

## 设计取舍：这些地方为什么这么做

自托管网盘最容易踩的坑，一半来自架构，一半来自「看起来能省一次请求」。这里把几个关键取舍写清楚，方便你判断要不要改。

| 点 | 现状 | 为什么不改 / 怎么缓解 |
| --- | --- | --- |
| **索引是单个 JSON** | `sys/index.json` 全量读改写，带 etag 乐观锁 + 8 次重试 | 1 万文件 2.8MB，读写都在几十毫秒。改成按目录分片会让「移动/重命名/统计用量」全部退化成多次跨分片事务，复杂度暴涨而收益为零。真到十万文件级再拆。 |
| **索引写入放大** | 每次改名/移动重写整个 index.json | 这是单 JSON 的必然代价，但已把「分享访问计数」从「每次访问写一次」改成「内存累加 + 30 秒合并写一次」，热门分享链接不会再打爆 Class A 限额。 |
| **R2 桶 ID 不回写 wrangler.jsonc** | Dashboard 部署的固有限制 | 代码层无解。README 部署章节已用 ⚠️ 标出：改用本地 `wrangler deploy` 前，必须先把桶名填回配置，否则会新建空桶。 |
| **ZIP 上限 3.6GB** | 未实现 zip64（32 位偏移上限 4GB） | 打包前会先算总大小，超限直接返回 413 并提示分批，不会「传到一半才失败」。真要突破得手写 zip64 的 ZIP64 EOCD + 扩展字段，收益不抵复杂度 —— 大文件夹本来就该分批下。 |
| **所有下载都过 Worker** | 不经 CDN 直连 | 这是**故意的**：HF Token 只存在 R2，直链一旦下发就等于把私有仓库暴露出去。代价是延迟比对象存储直连高一个 RTT，换来的是「链接无法被转发、无法被爬」。分片预取流水线已经把串行等待摊平（24MB 下载 330ms）。 |
| **分享有效期是小时级** | 1 小时 / 1 天 / 7 天 / 30 天 / 永久 | 产品选择，不是精度缺陷。过期由服务端每次请求校验，且 `/info` 和 `/unlock` 现在都返回 `Cache-Control: no-store`，不会被浏览器或中间层缓存出「过期还能打开」的假象。 |
| **分片大小服务端校验** | 服务端比对 `Content-Length` 与预期值 | 前端本来就用服务端返回的 `chunkSize` 切片，切错概率极低；真正影响体验的是「传错了还傻等重试」，已修：`uploader.js` 对 4xx（除 429）立即失败，只对网络错误 / 5xx / 429 退避重试。 |
| **重建索引丢文件名** | 已修 | 见上一节：索引快照 + 每文件 meta 双保险，默认能 100% 还原名字和目录。 |

---

## 常见问题

**部署后 500 / 提示缺少 R2 绑定**
账号没开通 R2。去控制台 R2 页面点一次开通，然后重新部署。

**初始化时提示「创建/写入私有仓库失败」**
Token 不是 write 权限，或者同名仓库属于别人。换 Token 或改个仓库名。

**报错 `Pbkdf2 failed: iteration counts above 100000 are not supported`**
部署的是修复前的旧代码。把最新代码推到 GitHub 重新部署即可（该限制已通过分轮派生规避）。

**上传报错 `Your push was rejected because it contains binary files`**
部署的是修复前的旧代码（当时分片用 base64 内联在 commit 里，被 HF 的 Xet 规则拦下）。
最新代码已改为标准 git-lfs 上传，重新部署即可。仓库里已有的 `.bin` 分片不受影响，无需清理。

**上传卡在某个分片**
HF 限流，等一会儿点上传面板里的「重试」即可，已上传的分片不会重复上传。

**分享页打不开**
分享过期或文件已删除；也可以在「分享链接」页看状态。

**换仓库后旧文件不见了**
换仓库不会迁移数据，旧文件还在原仓库。想继续用原来的，把仓库名改回去。

---

## 技术栈

- Cloudflare Workers（无框架，ES Module Worker）+ Static Assets
- Cloudflare R2（自动创建绑定）
- HuggingFace Hub HTTP API（`/api/repos/create`、`/api/datasets/{repo}/commit/main`、`/resolve`、git-lfs `/info/lfs/objects/batch`）
- 前端：原生 ES Module + 手写 CSS，零构建、零运行时依赖
- ZIP：自己实现的 store 模式流式打包（带 data descriptor + UTF-8 文件名标记）
