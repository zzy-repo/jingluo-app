# 设置 → 数据管理 → 抖音号（360×740）

## 这是什么

设置面板「数据管理」页里新增的**抖音号 `shiro_0824`** 展示项：值本身是一个可点的胶囊（强调色描边 + 等宽字体 + 复制图标），点一下复制到剪贴板，并弹一句轻提示。

**取证方式：Chromium 视口截图**（`scripts/shot-mobile.mjs`，`deviceScaleFactor: 2` + `isMobile` + `hasTouch` + `locale: zh-CN`），设备参数 360×740（更窄的旧机型档）。
**这不是真机 / Android WebView 截图**，不能替代 adb 真机取证；真机上的字体回退、系统级剪贴板弹窗、WebView 的 `navigator.clipboard` 行为均未覆盖（见文末未测边界）。

复现：

```bash
env INTERNAL_BUILD=1 NODE_ENV=production npx rspack build -c rspack.config.ts
node scripts/shot-mobile.mjs --page=settings-douyin --viewport=390,360
```

## 图片

| 文件 | 内容 |
| --- | --- |
| `settings-douyin-01-settings-data-douyin-360.png` | 整页设置（数据管理），**抖音号那一行在视口内可见** |
| `settings-douyin-02-douyin-row-closeup-360.png` | 该行局部特写，看强调色 / 等宽字体 / 胶囊形状 |
| `settings-douyin-03-douyin-copied-toast-360.png` | 点击之后：顶部 toast「抖音号已复制」 |

## 量到的数字（`metrics.json`，同一次运行）

| 项 | 值 |
| --- | --- |
| 胶囊文本 | `shiro_0824` |
| 胶囊尺寸 | 145 × 44 px（手机端点击区 44px 达标） |
| 胶囊位置 | x=191, y=594（视口 360×740，`inViewport: true`） |
| 胶囊颜色 / 描边 | `rgb(57, 100, 254)`，圆角 `100px` |
| 号码字体 | `ui-monospace, SFMono-Regular, Menlo, monospace`，15px / 600 |
| 左侧文字列 | 312 × 22 px（整行宽 312）——**窄 30px 后仍未被挤成窄条** |
| 行盒子 | 312 × 120 px，无横向溢出（`horizontalOverflow: false`） |
| 复制结果 | toast `抖音号已复制`；`navigator.clipboard.readText()` = `shiro_0824` |
| 控制台错误 | `[]` |

## 视觉自判（对照 #57 的回归）

- **最窄档也没塌**：360 下 `label` 仍是 312px 单行（22px 高），胶囊 145px 完整放进 312px 行宽，说明 `.wrapActionsCell` 的换行策略在这档同样生效，没有出现 #57 那种「动作区把文本列压到 8px」的竖排。
- **醒目但不喧宾夺主**：号码用强调色 + 等宽半粗，胶囊与同页「上传 / 下载 / 查看 / 写反馈」同一套圆角与高度；无动画、无图片、无整块背景，不是广告条。
- 胶囊右边缘与其它行的按钮右边缘对齐，没有比别的行更靠外。

## 未测边界

1. **真机 / Android WebView 未测**（无 adb、无设备）：系统级剪贴板弹窗、WebView 对 `navigator.clipboard.writeText` 的权限策略、以及真机的字体重排都未覆盖；只在 Chromium 上验证了 `readText()` 读回 `shiro_0824`。
2. **复制失败分支未截图**：Chromium 里授予了 clipboard 权限，走不到「复制失败」那条 toast；该分支只有单测（`tests/unit/douyin-account.test.mjs` 断言失败时 `key: copyFailed` + `type: error`），没有界面截图。
3. **深色主题未截图**：只截了 `colorScheme: light`。深色下强调色 token 换成 `--dsw-static-blue-400`，对比度未量。
4. **en 语言界面未截图**：英文文案只在单测里断言存在且非中文；英文描述更长，排版未在界面上核对。
5. **超长 / 缩放场景未测**：系统字体放大、浏览器 125%/150% 缩放、横屏都未覆盖。
6. **只测了 390 与 360 两档**：平板宽度（768 / 1024）和桌面档没有截图，桌面端走的是另一套 `.text{padding-right:48px}` 规则（本次未改）。
7. **剪贴板权限被拒的路径未在浏览器里跑**：只在单测覆盖了成功/失败到提示的映射，没在真实拒绝态下点过。
