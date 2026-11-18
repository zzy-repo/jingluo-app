# DeepSeek App

一个可自填 **服务地址 / 模型 / API Key** 的 DeepSeek Android 客户端（Web 前端 + Capacitor 套壳）。

## 来源与许可（重要）

本项目基于 **[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)**（MIT License）二次开发。

- 原始代码版权归 **DeepSeek** 及其贡献者所有，原始 `LICENSE` 文件完整保留、未做修改。
- 本仓库的所有改动同样以 **MIT License** 发布。
- 本项目是**二次开发的衍生作品，不是原创项目**，请勿移除或篡改上游版权声明。

## 本项目改造点

1. **模型配置本地化**：`Service URL` / `Model` / `API Key` 三项不再硬编码，改为在设置界面内填写并保存在浏览器 localStorage，可随意切换自建或第三方 OpenAI 兼容网关，无需改代码重新打包。
2. **Android 套壳**：使用 [Capacitor](https://capacitorjs.com/) 将构建产物打包为原生 Android 应用（`android/`）。
3. **APK 构建与发布**：`build-apk.sh` 负责构建；**发布走手动清单**（[`docs/RELEASE-MANUAL.md`](docs/RELEASE-MANUAL.md)），不提供一键发版脚本 —— 见下方说明。

## 使用

```bash
pnpm install
pnpm dev            # 本地开发
./build-apk.sh      # 构建 debug APK
./build-apk.sh release   # 构建 release APK
# 发布：按 docs/RELEASE-MANUAL.md 的手动清单逐步执行（无一键脚本）
```

设置页填写：

| 配置项 | 说明 |
| --- | --- |
| Service URL | 兼容 OpenAI 协议的 API 根地址，例如 `https://api.deepseek.com` |
| Model | 模型名，例如 `deepseek-chat` |
| API Key | 你的密钥，仅保存在本机 |

### 配置存储位置

配置仅保存在浏览器 / WebView 的 `localStorage`（三个 key），不上传任何服务器：

- `chat-demo:base-url` — 服务地址（Service URL）
- `chat-demo:model` — 模型名
- `chat-demo:api-key` — API Key

> 键名沿用上游 `chat-demo:` 前缀，以便与旧版本数据兼容，因此升级后无需重新填写配置。

清除应用数据或卸载应用会一并清除，需重新填写。

## 目录结构

```
src/                前端源码（React）
android/            Capacitor Android 工程
build-apk.sh        APK 构建脚本
docs/               设计与测试文档
docs/RELEASE-MANUAL.md  发版手动清单
package.json        版本号唯一来源（version / androidVersionCode）
dist/               构建产物（不纳入版本控制）
```

## License

MIT，见 [LICENSE](./LICENSE)。原始版权归 DeepSeek，本项目改动同样以 MIT 发布。
