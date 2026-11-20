package com.example.deepseekchat;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 更新下载器。默认只做「匿名 + 白名单目标」的 APK 传输：地址由 {@link UpdateEndpoint} 校验，
 * 请求头只有一份白名单（{@code X-DL-Token} / {@code Authorization}，Issue #639）——
 * 下载器不是通用 HTTP 客户端，不让调用方决定发什么头、发到哪去。
 *
 * <p>内测包（internal 变体）走私有端点：清单从 {@code BuildConfig.DL_PRIVATE_URL} 取（令牌在
 * {@code DL_PRIVATE_TOKEN}），包从同一台机器的 {@code /api/v1/releases/internal/download} 取。
 * 令牌在构建期由同一份环境变量注入，**任何日志 / 异常消息 / 回传字段都不带它**（#639 验收）。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final String TAG = "AppUpdate";
    private static final long MAX_BYTES = 50L * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicReference<Transfer> active = new AtomicReference<>();
    private final AtomicBoolean installerBusy = new AtomicBoolean(false);

    private static final class Transfer {
        final String id;
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        Transfer(String id) { this.id = id; }
    }

    private long code(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    @PluginMethod
    public void installed(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("version", info.versionName);
            result.put("versionCode", code(info));
            android.content.pm.ApplicationInfo app = getContext().getPackageManager().getApplicationInfo(getContext().getPackageName(), PackageManager.GET_META_DATA);
            result.put("artifactVariant", app.metaData == null ? "unknown" : app.metaData.getString("com.example.deepseekchat.ARTIFACT_VARIANT", "unknown"));
            call.resolve(result);
        } catch (Exception error) { call.reject("读取当前版本失败", "INSTALLED_VERSION"); }
    }

    /**
     * 按 {@link UpdateEndpoint#MANIFEST_BASES} 的固定顺序取清单：首个成功即生效，全失败才算失败。
     *
     * <p>#639 起多一步：internal 包在构建期真的配了私有端点（{@code privateManifest.enabled=true}
     * + 令牌）时，**先**读私有清单，失败**静默**回退公网 —— 与 JS 侧 #622 的纪律逐条对齐。
     *
     * <p>为什么这一步必须在原生侧做（而不是只靠 JS 的 {@code fetchManifest}）：公网
     * {@code releases.json} 里按 #614 的裁决**没有** internal 条目，而 WebView 里的 fetch 又过不去
     * 私有端点（该端点不返回 CORS 头，{@code OPTIONS} 直接 405）。于是「JS 选私有清单里的版本」
     * 在真机上根本走不到 —— 私有一行必须由原生网络栈取回，这是 #639 复现出的第 4 处缺口。
     */
    @PluginMethod
    public void manifest(PluginCall call) {
        worker.execute(() -> {
            JSObject privateManifest = privateManifest();
            if (privateManifest != null) {
                call.resolve(privateManifest);
                return;
            }
            for (String base : UpdateEndpoint.MANIFEST_BASES) {
                try {
                    JSObject result = new JSObject();
                    result.put("body", fetchManifest(UpdateEndpoint.manifestUrl(base), null));
                    // 回传生效的 base：清单里的 file 是相对路径，必须拼在「真的回了清单」的那台上，
                    // 否则回退到旧机后还拿新机域名拼，下载就是 404。
                    result.put("base", base);
                    call.resolve(result);
                    return;
                } catch (Exception error) { /* 换下一个 base */ }
            }
            call.reject("检查更新失败，请稍后重试", "MANIFEST_NETWORK");
        });
    }

    /**
     * 私有清单（#639）。**任何失败都返回 null**（= 静默回退公网），不记日志、不把令牌写进任何
     * 可见地方：私有端点的存在性与令牌有效性都不该出现在日志 / 界面里（#622 §安全）。
     */
    private JSObject privateManifest() {
        if (!UpdateEndpoint.privateManifestEnabled()) return null;
        try {
            JSObject result = new JSObject();
            result.put("body", fetchManifest(UpdateEndpoint.privateManifestUrl(), UpdateEndpoint.privateToken()));
            // 私有包的相对 file 属于私有端点这台机器（与公网两台 base 同机，但不要靠巧合）
            result.put("base", UpdateEndpoint.privateManifestBase());
            return result;
        } catch (Exception error) {
            return null;
        }
    }

    /** 取清单正文。{@code token} 非空时只作为 {@code X-DL-Token} 请求头发出去，绝不进异常消息。 */
    private String fetchManifest(String url, String token) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
            if (token != null && !token.isEmpty()) {
                connection.setRequestProperty(UpdateEndpoint.HEADER_PRIVATE_TOKEN, token);
            }
            if (connection.getResponseCode() != 200) throw new Exception("MANIFEST_HTTP");
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 2 * 1024 * 1024) throw new Exception("MANIFEST_TOO_LARGE");
                    output.write(buffer, 0, count);
                }
            }
            return output.toString("UTF-8");
        } finally { if (connection != null) connection.disconnect(); }
    }

    private File cache(String hash) throws Exception {
        if (hash == null || !hash.matches("[a-f0-9]{64}")) throw new Exception("INVALID_HASH");
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("CACHE_DIRECTORY");
        return new File(directory, hash + ".apk");
    }

    private Signature[] signatures(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= 28) {
            return info.signingInfo == null ? new Signature[0] : info.signingInfo.getApkContentsSigners();
        }
        return info.signatures == null ? new Signature[0] : info.signatures;
    }

    /** Revalidate every reuse/install; a cache filename alone is not evidence. */
    private void verify(File file, String hash, long size, long versionCode, Transfer transfer) throws Exception {
        if (size <= 0 || size > MAX_BYTES || file.length() != size) throw new Exception("SIZE_MISMATCH");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[32768];
            int count;
            while ((count = input.read(bytes)) != -1) {
                if (transfer != null && transfer.cancelled) throw new Exception("CANCELLED");
                digest.update(bytes, 0, count);
            }
        }
        StringBuilder hex = new StringBuilder();
        for (byte value : digest.digest()) hex.append(String.format("%02x", value & 255));
        if (!MessageDigest.isEqual(hex.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                hash.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new Exception("HASH_MISMATCH");
        PackageManager manager = getContext().getPackageManager();
        int flags = PackageManager.GET_META_DATA | (Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
        PackageInfo apk = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), flags);
        if (apk == null || !current.packageName.equals(apk.packageName)) throw new Exception("PACKAGE_MISMATCH");
        String marker = "com.example.deepseekchat.ARTIFACT_VARIANT";
        String installedVariant = current.applicationInfo == null || current.applicationInfo.metaData == null ? "unknown" : current.applicationInfo.metaData.getString(marker, "unknown");
        String apkVariant = apk.applicationInfo == null || apk.applicationInfo.metaData == null ? "unknown" : apk.applicationInfo.metaData.getString(marker, "unknown");
        if (!(installedVariant.equals("internal") || installedVariant.equals("standard")) || !installedVariant.equals(apkVariant)) throw new Exception("VARIANT_MISMATCH");
        if (code(apk) != versionCode || code(apk) <= code(current)) throw new Exception("VERSION_MISMATCH");
        Signature[] expected = signatures(current), actual = signatures(apk);
        if (expected.length == 0 || expected.length != actual.length ||
                !Arrays.asList(expected).containsAll(Arrays.asList(actual))) throw new Exception("SIGNATURE_MISMATCH");
    }

    private long requiredLong(PluginCall call, String field) throws Exception {
        Object raw = call.getData().opt(field);
        if (!(raw instanceof Number)) throw new Exception("INVALID_" + field);
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value != Math.floor(value) || value <= 0 || value > 9007199254740991d)
            throw new Exception("INVALID_" + field);
        return ((Number) raw).longValue();
    }

    /**
     * 唯一的进度帧出口（#376）。满格（received == total）只有两个调用点，且都在 verify() 之后：
     * 真下载收尾与缓存复用命中。校验失败 / 取消一律不发满格，JS 侧按 reject 显示失败。
     */
    private void reportProgress(String id, long received, long total) {
        JSObject progress = new JSObject();
        progress.put("id", id); progress.put("received", received); progress.put("total", total);
        notifyListeners("downloadProgress", progress);
    }

    /**
     * 把调用方给的头写进连接（Issue #639）。**只有 {@link UpdateEndpoint#canonicalDownloadHeader}
     * 认的两枚能过**（{@code X-DL-Token} / {@code Authorization}，大小写不敏感，统一按白名单里的
     * 规范写法设置）；其它一律忽略并记一条 warn。
     *
     * <p>warn **只记头名**：值里可能就是令牌本身（#639 验收：令牌不得进日志）。同理，
     * 值不合法时也只报头名，不回显内容。
     *
     * <p>为什么不让 JS 随便塞头：这个下载器只有一个用途。放行任意头等于给将来开一条
     * 「带任意凭据向本机发请求」的通道，而这种东西一旦被写进某个调用点，没人会再回头审。
     */
    private void applyHeaders(PluginCall call, HttpURLConnection connection) {
        JSObject headers;
        try {
            headers = call.getObject("headers");
        } catch (Exception malformed) {
            Log.w(TAG, "下载请求头不是对象，已忽略");
            return;
        }
        if (headers == null) return;
        java.util.Iterator<String> names = headers.keys();
        while (names.hasNext()) {
            String name = names.next();
            String canonical = UpdateEndpoint.canonicalDownloadHeader(name);
            if (canonical == null) {
                Log.w(TAG, "下载请求头不在白名单内，已忽略：" + name);
                continue;
            }
            if (!UpdateEndpoint.isSafeDownloadHeaderValue(headers.optString(name, ""))) {
                Log.w(TAG, "下载请求头的值不合法，已忽略：" + canonical);
                continue;
            }
            connection.setRequestProperty(canonical, headers.optString(name, ""));
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.length() > 100) { call.reject("下载请求无效", "INVALID_ID"); return; }
        Transfer transfer = new Transfer(id);
        if (!active.compareAndSet(null, transfer)) { call.reject("已有下载正在进行", "BUSY"); return; }
        worker.execute(() -> {
            File temporary = null;
            try {
                String hash = call.getString("sha256");
                long size = requiredLong(call, "size"), versionCode = requiredLong(call, "versionCode");
                if (size > MAX_BYTES) throw new Exception("INVALID_SIZE");
                File target = cache(hash);
                // A corrupt cache is discarded and downloaded again; signed/hashed cache is reused.
                if (target.exists()) {
                    try {
                        verify(target, hash, size, versionCode, transfer);
                        if (transfer.cancelled) throw new Exception("CANCELLED");
                        // 缓存命中同样是「已校验、可安装」的终态：补一帧满格，别让进度停在 0（#376）
                        reportProgress(id, size, size);
                        JSObject result = new JSObject(); result.put("cached", true); call.resolve(result); return;
                    } catch (Exception invalid) {
                        if (transfer.cancelled) throw invalid;
                        if (!target.delete()) throw new Exception("CACHE_CLEANUP");
                    }
                }
                URL url = new URL(call.getString("url", ""));
                // 白名单规则集中在 UpdateEndpoint：https 放行配置里的两台分发机，裸 http 只放行首选机。
                // 具体主机从 config/endpoints.json 派生（#269），本类不写任何地址。允许明文不会让伪造包
                // 装进设备：Android 安装器强制校验 APK 签名，本类的 verify() 还先比对包名 / versionCode /
                // SHA-256 / 同一签名，明文只能让更新失败或被抑制。
                if (!UpdateEndpoint.allowsDownloadUrl(url)) throw new Exception("INVALID_URL");
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                transfer.connection = connection;
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setRequestProperty("Accept-Encoding", "identity");
                applyHeaders(call, connection);
                if (transfer.cancelled) throw new Exception("CANCELLED");
                if (connection.getResponseCode() != 200) throw new Exception("DOWNLOAD_HTTP");
                long declared = connection.getContentLengthLong();
                if (declared >= 0 && declared != size) throw new Exception("SIZE_MISMATCH");
                temporary = new File(target.getParentFile(), hash + ".part");
                long received = 0, lastEvent = 0;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temporary)) {
                    byte[] buffer = new byte[32768]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (transfer.cancelled) throw new Exception("CANCELLED");
                        received += count;
                        if (received > size) throw new Exception("SIZE_MISMATCH");
                        output.write(buffer, 0, count);
                        long now = android.os.SystemClock.elapsedRealtime();
                        // 循环里只发 received < size 的帧（#376）：满格 = 「校验通过、可安装」，
                        // 不能由「字节凑齐了」推导——校验在循环之后，失败是常态之一（错 SHA / 异签 / 异变体）。
                        if (received < size && now - lastEvent >= 100) {
                            reportProgress(id, received, size); lastEvent = now;
                        }
                    }
                    output.getFD().sync();
                }
                // 校验之前不对外宣称「下完了」：这一帧 100% 只在 verify() 通过 + 落成最终文件名之后补发。
                verify(temporary, hash, size, versionCode, transfer);
                if (transfer.cancelled) throw new Exception("CANCELLED");
                if (!temporary.renameTo(target)) throw new Exception("CACHE_RENAME");
                reportProgress(id, size, size);
                JSObject result = new JSObject(); result.put("cached", false); call.resolve(result);
            } catch (Exception error) {
                call.reject(transfer.cancelled ? "已取消下载" : "下载或校验失败，请重试", transfer.cancelled ? "CANCELLED" : error.getMessage());
            } finally {
                if (temporary != null && temporary.exists()) temporary.delete();
                if (transfer.connection != null) transfer.connection.disconnect();
                active.compareAndSet(transfer, null);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Transfer transfer = active.get();
        if (transfer != null && transfer.id.equals(call.getString("id"))) {
            transfer.cancelled = true;
            if (transfer.connection != null) transfer.connection.disconnect();
        }
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (!installerBusy.compareAndSet(false, true)) { call.reject("安装请求正在处理", "BUSY"); return; }
        worker.execute(() -> {
            try {
                File file = cache(call.getString("sha256"));
                verify(file, call.getString("sha256"), requiredLong(call, "size"), requiredLong(call, "versionCode"), null);
                getActivity().runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getContext().getPackageName()));
                            startActivityForResult(call, settings, "permissionReturned");
                            return;
                        }
                        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(uri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(intent);
                        installerBusy.set(false);
                        JSObject result = new JSObject(); result.put("status", "installer-opened"); call.resolve(result);
                    } catch (Exception error) {
                        installerBusy.set(false); call.reject("打开安装界面失败，请重试", "INSTALL_FAILED");
                    }
                });
            } catch (Exception error) {
                installerBusy.set(false); call.reject("安装包校验失败，请重新下载", error.getMessage());
            }
        });
    }

    /** Permission grant never auto-installs: return to confirmation and require another explicit tap. */
    @ActivityCallback
    private void permissionReturned(PluginCall call, ActivityResult activityResult) {
        installerBusy.set(false);
        if (call == null) return;
        boolean granted = Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject result = new JSObject(); result.put("status", "permission-required"); result.put("granted", granted);
        call.resolve(result);
    }

    @Override protected void handleOnDestroy() {
        Transfer transfer = active.get();
        if (transfer != null) { transfer.cancelled = true; if (transfer.connection != null) transfer.connection.disconnect(); }
        worker.shutdownNow();
    }
}
