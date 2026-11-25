# 安全与脱敏说明

本仓库由本机实战产物整理后公开，**所有真实密钥与个人信息已移除**：

| 类型 | 处理 |
|---|---|
| 桥鉴权 key | 全部替换为 `REPLACE_WITH_YOUR_FORWARD_KEY`，运行时由 `settings.json` 的 `forwardKey` 或环境变量 `OFM_API_KEY` 提供（见 `src/ollama-bridge.mjs`） |
| 外部救援 apiKey | `examples/rescue-providers.example.json` 内为 `sk-REPLACE-ME` |
| 真实 `settings.json` / `rescue-providers.json` / `models.json` | **未纳入仓库**，并已加入 `.gitignore` |
| 本机绝对路径 `/Users/...` | 全部改为 `$REPO_ROOT`、`$HOME`、`__REPO_ROOT__` 占位 |
| launchd plist | 作为 `.plist.example` 模板提供，安装脚本渲染真实路径 |

部署注意：

1. `settings.json` 与 `rescue-providers.json` 含密钥，权限设为仅本人可读（macOS `chmod 600`；Windows 脚本已尝试收紧 ACL）。
2. 桥默认只监听 `127.0.0.1`，**不要**直接暴露到公网；如需远程访问请自行加反向代理与鉴权。
3. 第三方免费模型与救援通道各有服务条款，使用前请自行确认合规性。
4. 发现误提交的密钥：立即轮换，并用 `git filter-repo` 清理历史。
