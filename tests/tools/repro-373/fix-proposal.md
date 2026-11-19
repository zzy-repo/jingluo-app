# Issue #373 最小修复方案（未应用，仅留档；本分支只做复现）

复现结论见 `tests/tools/repro-373/result.json`：B / B2 / D / E / F 复现，A / C 正确。
症状「进度条满格 + 按钮=确认下载」= 下载结束（失败/取消）后 **progress 没有被清空**，
而 `ready` 只在成功分支才置 true；两者是两条独立通路，进度满格被误读成「可安装」。

## 补丁 1（P0，够关闭本单）：结束态一律清空进度

```diff
--- a/src/components/settings/AppUpdateField.tsx
+++ b/src/components/settings/AppUpdateField.tsx
@@ -262,6 +262,9 @@ export const AppUpdateField = () => {
     } catch (error) {
       if (mounted.current) {
+        // 进度条只描述「正在下载的字节」：下载结束（失败/取消）后必须清空，
+        // 否则会留下「5.2 MB / 5.2 MB + 确认下载」的假象（#373）。
+        setProgress(undefined)
         if (controller.signal.aborted) {
           setOutcome(undefined)
           setMessage('已取消下载，可重新下载。')
@@ -302,6 +305,7 @@ export const AppUpdateField = () => {
     } catch (error) {
       if (mounted.current) {
         setReady(false)
+        // 安装阶段校验失败 = 缓存包不可信，同样不能留满格进度
+        setProgress(undefined)
         showFailure(error, channel, release.version)
```

严格说这仍然只是「别把进度当状态」的止血：`ready` 与 `progress` 仍是两条通路。
彻底口径（建议随 #367 的 P0 用例一起做）：把 `idle / downloading / verifying / ready / installing / failed`
做成单一 state，按钮文案只读这个 state，`progress` 只作为该 state 的附属数据，
`received === total` **永远不推导**可安装。

## 补丁 2（P1）：busy 期间重复点击不应再下发一次下载

场景 E 实测：同一 tick 连点两次 → 向原生发了 **2 次** `download`（第 2 次被原生 `BUSY` 拒绝），
最终按钮状态虽然回到了「安装更新」，但中途 `busy` 会被第 2 次的 `finally` 提前落回 false，
属于「看起来能点、其实在跑别的操作」。

```diff
--- a/src/components/settings/AppUpdateField.tsx
+++ b/src/components/settings/AppUpdateField.tsx
@@ -74,6 +74,8 @@ export const AppUpdateField = () => {
   const operation = useRef<AbortController>()
+  /** state 异步，busy 挡不住同一 tick 的第二次点击（#373 场景 E） */
+  const downloading = useRef(false)
@@ -218,7 +220,7 @@ export const AppUpdateField = () => {
   const download = async () => {
-    if (!release || busy) {
+    if (!release || busy || downloading.current) {
       return
     }
+    downloading.current = true
@@ -278,6 +281,7 @@ export const AppUpdateField = () => {
     } finally {
+      downloading.current = false
       if (mounted.current && operation.current === controller) {
         setBusy(false)
       }
```

## 补丁 3（原生端，根因侧）：100% 进度不能早于校验

`AppUpdatePlugin.java:183-199` 在拷贝循环里 `received == size` 就发最后一次进度事件，
`verify()` 在其后才跑：

```java
if (now - lastEvent >= 100 || received == size) { ... notifyListeners("downloadProgress", progress); }
...
verify(temporary, hash, size, versionCode, transfer);   // ← 这里失败才 reject
```

所以任何校验失败（HASH / SIZE / PACKAGE / SIGNATURE / VERSION / VARIANT）在真机上必然
「先看到 5.2/5.2，再收到失败」。建议把 `received == size` 的那一帧移到 `verify()` 通过之后
（或改成 `received == size` 时只发 `received < size` 的收尾帧 + 校验通过后再补一帧 100%）。
