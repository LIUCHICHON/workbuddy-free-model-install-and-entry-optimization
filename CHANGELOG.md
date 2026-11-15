# Changelog

## 1.0.0 (2026-11-15)

- 首个公开版本：把原先彼此独立的 **macOS 工程版** 与 **Windows 一键安装包** 合并为一个跨平台仓库。
- 核心逻辑统一到 `src/`，Mac/Windows 共用同一份桥代码；平台差异下沉到 `platforms/`。
- 中文文件名改为英文通用命名；`.bat`/`.ps1` 统一 CRLF + UTF-8 BOM，`.sh` 统一 LF，由 `.gitattributes` 约束。
- 清除全部真实密钥、本机绝对路径与用户名；配置改为 `examples/*.example.json` 模板。
- launchd plist 改为占位符模板，新增 `install-launchd.sh` 自动渲染安装。
- `start-standalone.sh` 重写为设备无关版（`OFM_STANDALONE_DIR`）。
- `healthcheck.sh` / `probe.sh` / `selfcheck.sh` 改为从 `OFM_FORWARD_KEY` 或模型表取 key，不再内置任何 key。
- 新增 `README.md` / `README.en.md` / `docs/ARCHITECTURE.md` / `docs/MACOS.md` / `docs/SECURITY.md` / `LICENSE` / `.gitignore` / `.gitattributes`。
