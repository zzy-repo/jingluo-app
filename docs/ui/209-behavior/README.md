# 类别 4：行为 / 布局假设的动态验证（#209）

这一类假设静态检测测不出来。「CSS 里写了 `overflow-y: auto`」跟「内容真的能滚」是两件事：
容器可能被 flex 压成 0 高、`touchmove` 可能被拦掉、`100vh` 可能不等于可视高度。
唯一可信的做法是**设置之后读回实际值** —— 本目录就是这套读回流程与原始读数。

## 采集环境（重要：不是真机）

| 项 | 值 |
| --- | --- |
| 设备 | **Android Emulator API30（x86_64，非真实手机）**，AVD `compat-api30`，无窗口模式 |
| WebView | `com.google.android.webview` **83.0.4103.106**（`dumpsys webviewupdate` 读回） |
| UA | `… Version/4.0 Chrome/83.0.4103.106 Mobile Safari/537.36` |
| `CSS.supports('height','100dvh')` | **false** |
| 应用 | 本仓库 debug APK（`assembleDebug`），包名 `com.example.deepseekchat` |
| 宽度档 | 360（`wm size 540x1200` + `wm density 240`）、390（`wm size 585x1300`）、412（`wm size reset`，物理 1080x1920 @ 420） |

截图文件名里的 `-home / -settings / -confirm` 分别对应首页、设置弹窗初始、删除确认弹窗。
**所有截图都来自上面这台模拟器，不是真机截图。**

> `-settings-swiped` 那三张**没有收录**：`-no-window` + swiftshader 下紧随手势之后的
> `adb exec-out screencap` 拿到的是尚未重绘的旧帧，三档都跟滑动前的图**逐字节相同**
> （md5 一致），留着就是拿重复帧冒充证据。假设 3 的证据是 JSON 里的 `scrollTop` 读数，不是截图。

## 复现

```bash
# 前提：模拟器已启动、debug APK 已安装、adb 在 PATH
export MSYS_NO_PATHCONV=1
node docs/ui/209-behavior/measure.mjs before 360 390 412
```

`measure.mjs` 对每个宽度：改 `wm size/density` → 冷启应用 → 挂 CDP → 读视口快照 →
弹出软键盘再读一次 → 打开设置 → 探针（按钮行 / 滚动宿主 / 卡片盒模型）→
`adb shell input swipe` 打真实触摸 → 再探针 → 打开删除确认弹窗再探针 → 写
`before-wv83-<width>.json`；最后汇总成 `before-summary.json`。

两个容易踩的坑，脚本里都写了注释：

1. **`adb shell input swipe` 吃的是显示像素，不是 CSS 像素。** `getBoundingClientRect()`
   拿到的是 CSS px，必须乘 `devicePixelRatio`（240dpi→1.5，420dpi→2.625）再送 adb。
   漏了这步会在 412 档量出「滑不动」的假结论 —— 手势落点整个偏到弹窗外面去了。
2. **CDP 合成的 wheel 事件不算证据**（#30 就是这么复现失败的：事件全到、`scrollTop` 纹丝不动，
   而合成 wheel 绕过 `touchmove` 拦截，看起来能滚）。所以滑动一律走 `input swipe`。

## 四条假设的读数

### 假设 1「窄屏按钮会换行」

判据（先定后测）：按钮行横向跨度超过容器可用宽度、或按钮文字被裁、或按钮被压到窄于 44px ⇒ 不成立。

| 宽度 | 按钮行 | 按钮数 | 跨度 / 可用 | 溢出 | 换行 | 最窄按钮 | 最矮按钮 | 文字被裁 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 360 | General / Data（top 128） | 2 | 312 / 320 | 0 | 否 | 154 | 40 | 否 |
| 360 | Upload / Clear（top 564） | 2 | 152 / 312 | 0 | 否 | 72 | 36 | 否 |
| 360 | Send feedback / Check log coverage（top 1072） | 2 | 281.8 / 312 | 0 | 否 | 122.2 | 44 | 否 |
| 360 | Cancel / Delete all chats（确认弹窗 top 400） | 2 | 206.9 / 280 | 0 | 否 | 72.6 | — | 否 |
| 390 | General / Data（top 128） | 2 | 342 / 350 | 0 | 否 | 169 | 40 | 否 |
| 390 | Upload / Clear（top 564） | 2 | 152 / 342 | 0 | 否 | 72 | 36 | 否 |
| 390 | Send feedback / Check log coverage（top 1036） | 2 | 281.8 / 342 | 0 | 否 | 122.2 | 44 | 否 |
| 390 | Cancel / Delete all chats（top 434） | 2 | 206.9 / 310 | 0 | 否 | 72.6 | — | 否 |
| 412 | General / Data（top 128） | 2 | 364.2 / 372.2 | 0 | 否 | 180.1 | 40 | 否 |
| 412 | Upload / Clear（top 563） | 2 | 152 / 364.2 | 0 | 否 | 72 | 36 | 否 |
| 412 | Send feedback / Check log coverage（top 1033） | 2 | 281.8 / 364.2 | 0 | 否 | 122.2 | 44 | 否 |
| 412 | Cancel / Delete all chats（top 366） | 2 | 206.9 / 332 | 0 | 否 | 72.6 | — | 否 |

**结论：成立（结果层面），但机制不是「换行」。** 12 条多按钮行**一条都没有换行** ——
`Modal.module.css:128` 的 `.footer` 根本没有 `flex-wrap`。它成立靠的是「放得下」：
内容最宽的一行 `Send feedback / Check log coverage` 跨度恒为 281.8px，在 360 上距容器
可用宽度 312px 只剩 **30.2px（9.7%）** 余量。余量一旦被吃光，因为没有 `flex-wrap`，
结果是溢出而不是换行。

（`412` 上的 `General / Data` 行跨度 364.2 ≈ 可用 372.2，不是挤压，该行是
`justify-content: space-between`，跨度天然跟着容器走；`overflowPx` 才是挤压的判据，为 0。）

### 假设 2「弹窗内容超出会滚动」

| 宽度 | 弹窗卡片高 | 滚动宿主 | 宿主 `clientHeight` | `scrollHeight` | 被藏住 | `overflow-y` | `min-height` | `touch-action` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 360 | 664 | `content-_85c1b` | 528 | 1138 | 610 | auto | 0px | auto |
| 390 | 731.3 | `content-_85c1b` | 595 | 1102 | 507 | auto | 0px | auto |
| 412 | 596.2 | `content-_85c1b` | 460 | 1098 | 638 | auto | 0px | auto |

**结论：成立。** 三档宽度下都存在真实的 `scrollHeight > clientHeight`，而且**溢出元素自己的
计算值**就是 `overflow-y: auto`（浏览器算出来的，不是从声明推断的）。弹窗卡片
（`content-_83af2 dialog-_85c1b`）本身 `overflow-y: visible`，靠内层滚动 —— 这正是
`AppUpdateField.module.css` 那套模板（`max-height` 在卡片上、`overflow-y` 在内层）的形状。

`min-height: 0px` 是实测值，但要说清楚：内层宿主 `overflow-y: auto` ≠ `visible`，
按 flex 的自动最小尺寸规则它本来就取 0，所以 #172 那个 `min-height: 0` 是保险丝，不是承重件。

### 假设 3「触摸滑动会滚容器」

手势一律是 `adb shell input swipe`（真实触摸事件），坐标已按 `devicePixelRatio` 换算成显示像素。

| 宽度 | dpr | 起止坐标（显示像素） | 宿主 `scrollTop` 前 → 后 | 位移 | 滑到末端后剩余 | 末端内容可见 |
| --- | --- | --- | --- | --- | --- | --- |
| 360 | 1.5 | (270, 897) → (270, 491) | 0 → 328.7 | **328.7** | 0 | true |
| 390 | 1.5 | (292.5, 978.8) → (292.5, 536.3) | 0 → 377.3 | **377.3** | 0.3 | true |
| 412 | 2.625 | (572, 1373) → (572, 830) | 0 → 180.2 | **180.2** | −0.1 | true |

**结论：成立。** 一次真实滑动就产生 180~377px 的 `scrollTop` 位移，连滑三次到底后
末端节点（`Delete` 按钮，`lastTop` 1220.5）进入可视区，`remainingScroll` 归零。
容器 `touch-action: auto`（默认值），没被锁成 `none`/`pan-x`，`viewport.ts` 里
`usePreventPageScroll` 沿祖先链找到了这个 `overflow: auto` 的宿主所以没有 `preventDefault`。

### 假设 4「`100vh` 等于可视高度」

| 宽度 | 静息 `100vh` | 静息 `visualViewport.height` | 差 | 键盘态 `100vh` | 键盘态 `visualViewport.height` | 差 | `dvh` 支持 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 360 | 728 | 728 | **0** | 479.3 | 479.3 | **0** | false |
| 390 | 795.3 | 795.3 | **0** | 546 | 546 | **0** | false |
| 412 | 660.2 | 660.2 | **0** | 378.3 | 378.3 | **0** | false |

（键盘态 `imeShown` 由 `dumpsys input_method` 的 `mInputShown=true` 确认，不是看 CSS 猜的。）

**结论：成立，且是「机制性成立」。** `AndroidManifest.xml:19` 是
`android:windowSoftInputMode="adjustResize"` —— 软键盘弹出时 Activity 把 **WebView 窗口本身**
改小（728 → 479.3），`100vh` 跟着窗口走，所以两者恒等。这不是 `100dvh` 的功劳：
`CSS.supports('height','100dvh')` 实测 false，代码里所有 `@supports (…100dvh)` 分支在
WebView 83 上整条不生效，真正起作用的是带 `100vh` 缺省值的那条声明。

## 未测边界

- **全程模拟器（Android Emulator API30 / x86_64），不是真机。** 真机的浏览器地址栏收起/展开、
  厂商 ROM 的分屏与手势导航、异形屏安全区都没有覆盖；`100vh` 在真机 edge-to-edge 全屏下
  是否仍等于可视高度，本目录测不出来。
- **`PaymentRecords` / `PaymentTrailDialog` / `PurchaseRecordsDialog` 三个弹窗未测**：
  它们依赖登录态下的订单数据，模拟器上是空态，弹不出有内容的列表 → 未测（原因：无数据）。
  它们跟已测的设置弹窗不同：`max-height` 写的是裸 `100vh`、没有 `@supports (100dvh)` 兜底，
  `.actions` 里 `PaymentRecords:139` / `PaymentTrailDialog:49` 也没有 `flex-wrap`。
- **`100vh` 只在 `adjustResize` 下成立。** 若某天 Activity 改成 `adjustPan` 或全屏 edge-to-edge，
  这条结论立即失效，而代码里没有对「100vh 是否等于可视高度」做任何运行时探测（只有
  `--modal-viewport-height` / `--app-viewport-height` 两个变量读 `visualViewport`）。
- **字号放大 / 系统字体缩放未测**：`Modal.module.css:.footer` 没有 `flex-wrap`，
  实测余量只剩 30.2px；文字放大后的表现属于本单未覆盖的越界场景。
- WebView 91 / 109 档没测，本单只针对 83 这条主战场。
- **滑动后的截图缺档**：`-no-window` + swiftshader 下紧随手势后的 `screencap` 返回未重绘的旧帧
  （与滑动前逐字节相同），所以「滑完长什么样」没有截图，只有 `scrollTop` 读数与末端节点坐标。
