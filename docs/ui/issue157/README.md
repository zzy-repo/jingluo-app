# Issue #157 证据：重新下单覆盖单号 + 服务端兜底 `latest_fulfilled`

P0：付款成功、卡也发了，App 界面一直停在「等待支付」。两笔真实账（Issue 原文）：

```
CP202611182105334E806605   CREATED    ← App 一直轮询这一单（未支付）
CP202611182359489D46C638   FULFILLED  ← 实际付款的是这单（卡 MUSE-3CYP-5NA3-AHSE-A3SR）
```

## 根因（file:line）

见 PR #178 描述。一句话：**存档写了，但轮询没跟上**（旧轮询不取消、`onUpdate` 写回闭包里的旧单号），
`latest_fulfilled` 也从来没解析过。所以服务端看到的是「App 一直在查那张没人付的旧单」。

## 文件

| 文件 | 内容 |
| --- | --- |
| `red-order-overwrite.txt` | 修复前（干净 `origin/main` = b395ca7，另建 detach 工作树跑）原始输出：**通过 26 / 失败 32** |
| `green-order-overwrite.txt` | 修复后同一套用例原始输出：**通过 58 / 失败 0** |
| `unit-layer.txt` | `node tests/run-layer.mjs unit` 原始输出（main + 本 PR）：**68 files, PASS 68, FAIL 0** |
| `issue157-01-first-order-pending-{390,360}.png` | 第一单建好、未支付（订单区显示单号 …E806605） |
| `issue157-02-second-order-fulfilled-{390,360}.png` | **连下两单后**：订单区是第二单（已发卡 / 单号 …9D46C638 / 上一笔未支付订单已失效 / 卡密 ••••A3SR） |
| `issue157-03-latest-fulfilled-{390,360}.png` | 查询单仍「待支付」，但服务端兜底带出「你还有一笔已完成的订单」+ 卡密 ••••A3SR · 单号 …9D46C638 + 一键兑换 |
| `issue157-04-web-return-390.png` | 网页版回跳（`?no=&order_token=`）后按回跳单号查单，一次都没查旧单 |

## 怎么复跑

```bash
DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
node tests/integration/ours-order-overwrite.test.mjs   # 58 项（修复前 26 通过 / 32 失败）
node tests/unit/ours-order-overwrite.test.mjs          # 34 项
node tests/run-layer.mjs unit                          # 68 文件全绿
```

## #157 合并后的收尾（这个 PR 干的事）

#178 被 squash 合并进 main 时只带走了第一笔 commit，于是 main 上留下两件事：

1. `tests/integration/` 下的 `ours-webpay.test.mjs` **是红的**（2 条断言还按旧返回结构写：
   `consumeOrderReturn` 现在多返回 `replacedUnpaidOrder`）。已同步断言 → 50 项全过。
   （该文件后来随 #368 清理「断言已删接口的死测试层」整层删除（#391，2026-11-19）——
   这里记的是当次取证时的路径，**它已经不在仓库里**，别再照着它找文件。）
2. 修复前后的原始输出、`docs/ui/issue157/README.md`、以及集成用例里的截图兜底（修复前
   `scrollIntoViewIfNeeded` 会直接抛异常，把「失败」变成「崩」）没进 main。补在这里。

## 这是打桩，不是真机

`window.Capacitor` 是浏览器里模拟的安卓桥，收银台 / `/api/order` / `/api/redeem` / `/redeem-card`
全是桩数据（用 Issue 原文那两笔单号），**没有建过真单、没有打真收银台**。

未测边界：

- 真机弱网（付款回调延迟 10 秒）**没跑** —— 本机没有可用真机/弱网环境。桩里用「第一次查 pending、
  之后才 fulfilled」模拟回调延迟，但这**不等于真机通过**。
- 线上 `latest_fulfilled` 只用一个没有已完成订单的账号确认过该字段**不出现**（符合契约）；
  「同 customer 有一笔已完成单」的非空形态只在打桩里验证。
- 换 device_id（重装 / 清数据）后新旧订单不在同一 customer 名下，兜底救不了 —— 另一个问题。
