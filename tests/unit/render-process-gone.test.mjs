// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #44：WebView 渲染进程死亡必须被宿主接管（onRenderProcessGone -> true），
// 否则 Chromium 直接杀掉整个应用（aw_browser_terminator.cc:112）。
//
// 修复前这里全部 red：全工程 0 处覆写 onRenderProcessGone，Capacitor 的 WebViewListener
// 默认返回 false，于是我在模拟器上 kill -9 渲染进程，应用进程瞬间消失。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8')
const JAVA = 'android/app/src/main/java/com/example/deepseekchat'

test('MainActivity takes over onRenderProcessGone and never hands it back', async () => {
  const source = await read(`${JAVA}/MainActivity.java`)
  assert.match(source, /class MainActivity extends BridgeActivity/)
  const start = source.indexOf('@Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail)')
  assert.ok(start > 0, '必须覆写回调')
  // 关键契约：回调的结果来自 guard.handle()，该方法恒返回 true；方法体内不允许出现 return false。
  const body = source.slice(start, source.indexOf('});', start))
  assert.match(body, /return renderProcessGuard\.handle\(/)
  assert.doesNotMatch(body, /return false/, '回 false 等于交回系统 → 应用被杀')
  assert.match(source, /addWebViewListener\(/, '注册 listener 而不是替换 BridgeWebViewClient')
  assert.doesNotMatch(source, /setWebViewClient\(/, '替换 client 会丢掉 local server / 请求拦截钩子')
})

test('recovery is hardened: null bridge, reentrancy, post, recreate guard', async () => {
  const source = await read(`${JAVA}/MainActivity.java`)
  // BridgeActivity 在 setContentView 失败时走 no_webview 分支，此时 getBridge() == null。
  assert.match(source, /getBridge\(\)/)
  assert.match(source, /if \(bridge == null\)/)
  assert.match(source, /if \(webView == null\)/)
  // recreate() 必须 post 到 UI 线程晚一步执行，不能在回调线程里直接调。
  assert.match(source, /webView\.post\(task\)/)
  assert.match(source, /recreate\(\)/)
  // 后台被系统回收是最常见现场：重建要能推迟到 onResume。
  assert.match(source, /onResume\(\)/)
  assert.match(source, /rebuildPending/)
  // 诊断双写：logcat 现场取证 + SharedPreferences 交回 JS。
  assert.match(source, /Log\.w\(TAG/)
  assert.match(source, /RenderProcessEventStore\.append/)
  assert.match(source, /detail\.didCrash\(\)/)
})

test('the decision layer is pure Java and always returns true', async () => {
  const source = await read(`${JAVA}/RenderProcessGoneGuard.java`)
  assert.doesNotMatch(source, /^\s*import android\./m, '纯 Java 才能在 JVM 单测里跑（无设备验证）')
  assert.match(source, /public boolean handle\(final boolean didCrash/)
  const handleBody = source.slice(source.indexOf('public boolean handle(final boolean didCrash'))
  assert.match(handleBody, /recovering\) \{[\s\S]*?return true;/, '重入时也必须回 true')
  assert.match(handleBody, /catch \(RuntimeException error\)[\s\S]*?return true;/, '异常时也必须回 true')
  assert.match(handleBody, /return true;\s*\}\s*$|return true;/)
  assert.match(source, /EVENT_CRASH/)
  assert.match(source, /EVENT_KILLED/)
  assert.match(source, /EVENT_IGNORED/)
  assert.match(source, /EVENT_REBUILD_FAILED/)
})

test('recovery is visible in diagnostics (native record -> JS log)', async () => {
  const plugin = await read(`${JAVA}/DiagnosticsDevicePlugin.java`)
  assert.match(plugin, /@PluginMethod\s+public void renderProcessEvents\(PluginCall call\)/)
  assert.match(plugin, /RenderProcessEventStore\.read/)

  const collector = await read('src/services/diagnostics/collector.ts')
  assert.match(collector, /drainNativeRenderProcessEvents/)
  assert.match(collector, /renderProcessEvents\(\)/)
  assert.match(collector, /record\('warning'/, '渲染进程事件要落进诊断缓冲')
  assert.match(collector, /await drainNativeRenderProcessEvents\(\)/, '启动时搬运一次')
})

test('a JVM regression test exists for the guard contract', async () => {
  const test_source = await read('android/app/src/test/java/com/example/deepseekchat/RenderProcessGoneGuardTest.java')
  assert.match(test_source, /crashIsAlwaysClaimedByReturningTrue/)
  assert.match(test_source, /reentrantCallbacksDoNotRebuildTwice/)
  assert.match(test_source, /rebuildFailureStillKeepsTheClaimAndResetsState/)
  assert.match(test_source, /dispatchFailureStillKeepsTheClaim/)
})
