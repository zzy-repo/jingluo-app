package com.example.deepseekchat;

import android.os.Build;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * Capacitor 宿主 Activity。
 *
 * <p>本类只做一件事之外的原样保留（四个 registerPlugin），外加一件事：
 * **接管渲染进程死亡**（Issue #44）。
 *
 * <p>背景：Capacitor 8.6.2 的 {@link com.getcapacitor.WebViewListener#onRenderProcessGone}
 * 默认 {@code return false}，{@link com.getcapacitor.BridgeWebViewClient#onRenderProcessGone}
 * 于是也返回 false（见 BridgeWebViewClient.java:92-104：{@code result} 只被各 listener
 * 的返回值 OR 上去）。返回 false 的语义是「这次死亡没有任何 WebView 接管」，Chromium 据此
 * 直接杀掉整个宿主进程 —— logcat 里就是
 * {@code aw_browser_terminator.cc(112)] Render process (N) kill (OOM or update) wasn't handed
 * by all associated webviews, killing application.}。修之前全工程 0 处覆写，用户看到的就是
 * 「用着用着整个 App 没了，切回来白屏」。
 *
 * <p>修法：注册一个返回 true 的 listener（不替换 {@code BridgeWebViewClient}，否则会丢掉
 * shouldInterceptRequest / shouldOverrideUrlLoading 等钩子），返回 true 阻止系统杀进程，
 * 再由 {@link RenderProcessGoneGuard} 决定怎么把界面重建回来：
 * <ul>
 *   <li>前台时：{@code recreate()} 整层重建（死掉的渲染进程不可复用，WebView 必须换新的）；</li>
 *   <li>后台时（本条缺陷最常见的现场：退到桌面被系统回收）：推迟到下一次 {@code onResume}
 *       重建，用户切回来看到的是重新加载好的界面，而不是白屏；</li>
 *   <li>死亡/自愈都写 logcat + SharedPreferences（{@link RenderProcessEventStore}），
 *       后者由 {@link DiagnosticsDevicePlugin#renderProcessEvents} 交回 JS 诊断日志。</li>
 * </ul>
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "RenderProcessGone";

    /** 渲染进程接管策略（重入保护 / post 调度 / 异常兜底都在里面）。 */
    private RenderProcessGoneGuard renderProcessGuard;
    /** 渲染进程死时 Activity 不在前台：把重建推迟到下一次 onResume。 */
    private boolean rebuildPending;
    /** 是否处于 resumed 状态（决定能否立刻 recreate）。 */
    private boolean resumed;

    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(ExportTextPlugin.class);
        registerPlugin(DiagnosticsDevicePlugin.class);
        // 设备指纹单独一个插件（Issue #243）：诊断插件按契约不读任何标识，
        // 身份的事留在 DeviceFingerprintPlugin 里，免得哪天顺手把标识写进诊断日志。
        registerPlugin(DeviceFingerprintPlugin.class);
        registerPlugin(CheckoutBrowserPlugin.class);
        super.onCreate(savedInstanceState);
        installRenderProcessGoneGuard();
    }

    /**
     * 注册渲染进程死亡接管。
     *
     * <p>{@code getBridge()} 判空是必需的：{@code BridgeActivity.onCreate} 在
     * {@code setContentView(R.layout.capacitor_bridge_layout_main)} 抛异常时会走
     * {@code setContentView(R.layout.no_webview); return;} 分支，此时 {@code bridge == null}。
     * 不判空就是 NPE，会把本来还能用的降级界面变成崩溃。
     */
    private void installRenderProcessGoneGuard() {
        final Bridge bridge = getBridge();
        if (bridge == null) {
            Log.w(TAG, "bridge == null（no_webview 降级分支）：未安装渲染进程接管");
            RenderProcessEventStore.append(this, "render_process_guard_not_installed", false, "bridge == null");
            return;
        }
        final WebView webView = bridge.getWebView();
        if (webView == null) {
            Log.w(TAG, "bridge.getWebView() == null：未安装渲染进程接管");
            RenderProcessEventStore.append(this, "render_process_guard_not_installed", false, "webView == null");
            return;
        }

        renderProcessGuard = new RenderProcessGoneGuard(
            new RenderProcessGoneGuard.Dispatcher() {
                @Override public void post(Runnable task) {
                    // 必须在 UI 线程晚于当前回调执行：回调线程里直接 recreate 语义不稳。
                    webView.post(task);
                }
            },
            new RenderProcessGoneGuard.Recorder() {
                @Override public void record(String event, boolean didCrash, String detail) {
                    recordRenderProcessEvent(event, didCrash, detail);
                }
            },
            new RenderProcessGoneGuard.Rebuilder() {
                @Override public void rebuild() {
                    rebuildAfterRenderProcessGone();
                }
            }
        );

        bridge.addWebViewListener(new WebViewListener() {
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.w(TAG, "onRenderProcessGone：接管中（返回 true，避免 aw_browser_terminator 杀掉应用）");
                return renderProcessGuard.handle(didCrashOf(detail), describe(detail));
            }
        });

        Log.i(TAG, "渲染进程接管已安装（onRenderProcessGone -> true）");
    }

    private void recordRenderProcessEvent(String event, boolean didCrash, String detail) {
        // 双写：logcat（现场取证）+ SharedPreferences（新渲染进程起来后交回 JS 诊断日志）。
        Log.w(TAG, event + " didCrash=" + didCrash + " detail=" + detail);
        RenderProcessEventStore.append(this, event, didCrash, detail);
    }

    /** 重建界面：前台直接 recreate，后台推迟到 onResume。 */
    private void rebuildAfterRenderProcessGone() {
        if (isFinishing() || isDestroyed()) {
            Log.w(TAG, "界面重建跳过：Activity 已在销毁");
            return;
        }
        if (!resumed) {
            // 典型现场：App 在后台被系统回收渲染进程。立刻 recreate 会被系统拒绝
            // （onSaveInstanceState 之后），推迟到用户切回来时重建最稳。
            rebuildPending = true;
            Log.w(TAG, "界面重建推迟到下一次 onResume（当前在后台）");
            return;
        }
        Log.w(TAG, "界面重建：recreate() 整层重建 WebView");
        recreate();
    }

    @Override public void onResume() {
        super.onResume();
        resumed = true;
        if (rebuildPending) {
            rebuildPending = false;
            Log.w(TAG, "onResume：执行推迟的界面重建");
            RenderProcessEventStore.append(this, "render_process_rebuild_on_resume", false, "deferred rebuild");
            rebuildAfterRenderProcessGone();
        }
    }

    @Override public void onPause() {
        resumed = false;
        super.onPause();
    }

    private static boolean didCrashOf(RenderProcessGoneDetail detail) {
        return detail != null && detail.didCrash();
    }

    private static String describe(RenderProcessGoneDetail detail) {
        if (detail == null) {
            return "no-detail";
        }
        String text = "didCrash=" + detail.didCrash();
        if (Build.VERSION.SDK_INT >= 26) {
            text += ",priorityAtExit=" + detail.rendererPriorityAtExit();
        }
        return text;
    }
}
