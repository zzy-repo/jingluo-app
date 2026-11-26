# ios/ —— Capacitor iOS 壳（Issue #873）

Web 代码就是仓库根 `dist/` 的产物，这里只放**原生壳**。Android 那侧的同位物见 `../android/`。

## 哪些是生成物（别手改）

| 路径 | 谁生成 | 手改会怎样 |
| --- | --- | --- |
| `App/App/public/` | `pnpm exec cap sync ios`（从 `dist/` 拷） | 下次 sync 被覆盖；`ios/.gitignore` 已忽略，不入库 |
| `App/App/capacitor.config.json`、`App/App/config.xml` | 同上（从 `capacitor.config.ts` 生成） | 同上，已忽略 |
| `App/CapApp-SPM/Package.swift` | 同上（插件清单，路径指进 `node_modules/.pnpm/…`） | 下次 sync 被覆盖；依赖升级后必须重跑 sync，否则 SPM 找不到包 |
| `capacitor-cordova-ios-plugins/` | 同上 | 已忽略 |
| `App/App.xcodeproj/project.pbxproj` | `cap add ios`（模板） | 只有两个键由脚本改写，见下一节；其余手改会被下一次生成覆盖 |

`App/App/AppDelegate.swift`、`SceneDelegate.swift`、`Info.plist`、`Base.lproj/*.storyboard` 是**真源码**，改这里。

## 版本号：唯一来源是 `package.json`

`xcodebuild` 不读 JSON，所以 iOS 这条链由脚本接：

```
package.json  version            →  MARKETING_VERSION        （CFBundleShortVersionString）
package.json  androidVersionCode →  CURRENT_PROJECT_VERSION  （CFBundleVersion / build 号）
```

```bash
pnpm run ios:version        # 把 pbxproj 改写成 package.json 的值
pnpm run check:ios-version  # 门禁：漂了就红（CI + pnpm dev-check 都会跑）
```

**改版本号请改 `package.json`**，别手改 pbxproj —— 手改出来的第二份值下次生成又分叉一次。
上架版本必须是 1~3 段点分数字（`1.4.0-beta.8` 这种 `CFBundleShortVersionString` 传不上去），
脚本遇到非数字版本会 exit 2 让人判，不会偷偷截断后缀。

## 图标

```bash
pnpm run gen:ios-icon   # docs/ui/app-icon/icon-512.png → App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
pnpm run check:icon     # 四边各 2px 不许有白像素（#266），iOS 那张也在检查范围内
```

`cap add ios` 带进来的是 **Capacitor 模板图**（装上手机是 Capacitor 的 logo），这里已换成品牌图。
`docs/ui/app-icon/source.png` 是**带白框的预览图**（四角 253 白），不能直接缩放，原因写在脚本头。

## 日常

```bash
pnpm build                  # 先出 dist/（注意：sync 只是拷贝，dist 旧了壳里就是旧前端）
pnpm exec cap sync ios      # 拷 web 产物 + 重写插件清单
```

然后用 Xcode 打开 `App/App.xcodeproj` 跑。**本机只有 CommandLineTools、没有 Xcode**（`xcodebuild` 直接报错），
所以本地编译/真机验证做不了。

## 已知缺口（别当成已验）

- **明文传输**：`Info.plist` 里没有 `NSAppTransportSecurity`，而 Android 是 `usesCleartextTraffic="true"` +
  `allowMixedContent: true`。仓库现状有明文链路（`config/endpoints.staging.json` 的 `http://…`、
  `allowInsecureUpdateTransport: true` 的 http 更新、用户在设置里自填的 `http://` 地址 ——
  `src/services/api/apiConfig.ts` 明确接受 `http:`），这些在 iOS 上会被 ATS 拦。属未修能力缺口。
- **启动图**：`Assets.xcassets/Splash.imageset/` 还是 Capacitor 模板图（本单只换了 AppIcon）。
- **插件**：`@capacitor/browser` 走 SPM 已接上；Android 那侧九个自研 Java 插件（含 `ExternalFile`）
  没有 Swift 实现，JS 侧在 `platform === 'ios'` 时直接降级返回。
- **打包 CI**：按项目决定暂时不做 iOS 出包流水线（#873 的第 5 项暂缓），所以「能编译」目前**没有任何自动化证据**。
