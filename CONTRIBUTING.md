# 贡献指南

1. Fork 本仓库并新建分支（`feat/xxx` 或 `fix/xxx`）。
2. 保持「核心逻辑在 `src/`、平台差异在 `platforms/`」的分层；新增平台脚本不要写死路径或密钥。
3. 提交前自检：
   ```bash
   for f in src/*.mjs tests/*.mjs; do node --check "$f"; done
   for f in platforms/macos/*.sh; do bash -n "$f"; done
   node tests/run-regression.mjs
   ```

4. **不要提交** `settings.json`、`rescue-providers.json`、`models.json` 或任何真实密钥。
5. 文档改动请同步更新中英文 README 与 `docs/`。

Issue / PR 请用中文或英文均可。
