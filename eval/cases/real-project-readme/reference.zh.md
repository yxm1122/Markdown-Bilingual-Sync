# Signal Relay：Webhook 转发 CLI

Signal Relay 可将一个端点收到的 Webhook 转发到多个目标，并提供重试、重放和本地审计日志。它既可作为单一二进制文件运行，也可作为 Node.js 包使用，因此同一份配置在笔记本电脑和生产环境中都能生效。

**状态：**稳定 · **版本：**1.4.2 · **运行时：**Node.js 20+ · [发布说明](https://example.com/signal-relay/releases)

## 功能

- 每条路由最多向 20 个目标扇出投递，每个目标可单独设置重试策略。
- 持久化队列可在重启后继续工作，并提供用于补投遗漏事件的 `replay` 命令。
- 对入站请求进行签名校验，对出站请求进行 HMAC 签名。
- 结构化 JSON 日志包含请求 id，可端到端追踪单个事件。
- 本地缓存和预览界面保留最近 100 次投递记录，离线时也能查看。
- 按工作区隔离路由、密钥和审计记录，适合多人共用一台主机。

## 安装

Signal Relay 需要 Node.js 20 或更高版本。请从公共包仓库安装 CLI：

```bash
npm install --global signal-relay
signal-relay --version
```

容器镜像发布在 `registry.example.com/signal-relay`；请将配置目录挂载到 `/etc/signal-relay`，并通过环境变量传入密钥。

## 快速开始

创建路由、启动监听器，然后发送一条测试事件：

```bash
signal-relay init --workspace ./demo
signal-relay route add orders \
  --from https://example.com/hooks/orders \
  --to https://example.com/services/billing
signal-relay serve --port 8787
```

在另一个终端中提交示例负载。CLI 会输出一行摘要，并将事件写入本地缓存：

```bash
curl -X POST http://localhost:8787/hooks/orders \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_1042","type":"order.created"}'
```

启用重试之前，可运行 `signal-relay preview --workspace ./demo` 查看最近十次投递。

## 配置

配置保存在 `relay.toml` 中。CLI 参数的优先级高于配置文件，环境变量的优先级又高于两者：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :---: | --- | :--- |
| `workspace` | string | `./` | 存放路由、日志和本地缓存的目录 |
| `retry.max_attempts` | integer | `6` | 每个目标在事件被搁置前的尝试次数 |
| `retry.backoff` | string | `exponential` | 退避策略：`linear`、`exponential` 或 `fixed` |
| `queue.size` | integer | `10000` | 写入磁盘前驻留内存的事件数 |
| `signing.secret_env` | string | `RELAY_SIGNING_KEY` | 保存 HMAC 密钥的环境变量名 |
| `log.level` | string | `info` | 可选值为 `debug`、`info`、`warn` 或 `error` |

## 故障排查

- **事件一直停留在队列中。**运行 `signal-relay status`，确认每个目标都能在 5 秒超时内响应 `HEAD` 请求。
- **签名校验失败。**确认发送方和中继服务读取的是同一个 `RELAY_SIGNING_KEY`，并且只有在双方都更新后才轮换密钥。
- **缓存无限制增长。**请调低 `queue.size`，或在维护窗口内定期执行 `signal-relay cache prune --older-than 7d`。

## 延伸阅读

跨大版本升级前，请先阅读[迁移指南](https://example.com/signal-relay/migrate)，并查阅[部署检查清单](https://example.com/signal-relay/deploy)了解生产环境限制。[^limits]

[^limits]: 该清单列出了受支持的操作系统以及 1 MiB 的最大事件大小。
