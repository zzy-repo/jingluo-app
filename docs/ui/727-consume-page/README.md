# #727 验收取证

`main@ccd4dfff` 上 #727 的实现（#758）已合入，本目录补的是**它缺的验收取证**与一个真实缺陷的修复。

## 1. 360 档：设置导航第三项「账户与消费」被裁切（已修）

`main` 上 `.navItem` 是 `flex: 1 0 auto; min-width: 108px`。加了第三项之后，
360×740 档三项的**内容宽度**合计 328px > 导航可视宽 320px，于是导航变成横向滚动、
第三项正好顶在屏幕右边缘被切掉（「账户与消…」）。

| | before | after |
| --- | --- | --- |
| 整屏 | `nav-360-before.png` | `nav-360-after.png` |
| 导航特写（判据都在这张） | `nav-360-before-closeup.png` | `nav-360-after-closeup.png` |

同一台机器上量到的数字（`page.evaluate` 读 `scrollWidth` / `getBoundingClientRect`）：

| 指标 | before | after |
| --- | --- | --- |
| 导航 `clientWidth` | 320 | 320 |
| 导航 `scrollWidth` | **344**（溢出 24） | **320**（不溢出不滚动） |
| 第三项右边缘 | **360**（= 视口右边界，被切） | **336**（留 24px 右边距） |
| 第三项宽度 | 112（内容宽，挤不动） | 111（三项平分一行） |

修法只有那一条规则：`.navItem` 的 `flex: 1 0 auto` → `flex: 1 1 auto`、`min-width: 108px` → `92px`
（`320 = 3 × 97~111 + 间距`，三项平分；两项时 `flex-grow: 1` 撑满，行宽与改动前一致）。

## 2. 复现命令

```bash
node scripts/build.mjs --internal
# 360×740、自有渠道（入口只在这条渠道出现）、打开设置，量导航与第三项
# 判据：nav.scrollWidth === nav.clientWidth && entry.right < viewportWidth
```

> 本目录的截图均为**浏览器视口截图**（390/360 两档 + `deviceScaleFactor: 2`），不是真机截图。
