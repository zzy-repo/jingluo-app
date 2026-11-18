package com.example.deepseekchat;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
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

/** Anonymous public APK transport only: never accepts headers, tokens, or arbitrary destinations. */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
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

    @PluginMethod
    public void manifest(PluginCall call) {
        worker.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL("https://dl.rose7.cn/releases.json").openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
                if (connection.getResponseCode() != 200) throw new Exception("MANIFEST_HTTP");
                java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 2 * 1024 * 1024) throw new Exception("MANIFEST_TOO_LARGE");
                        output.write(buffer, 0, count);
                    }
                }
                JSObject result = new JSObject(); result.put("body", output.toString("UTF-8")); call.resolve(result);
            } catch (Exception error) { call.reject("检查更新失败，请稍后重试", "MANIFEST_NETWORK"); }
            finally { if (connection != null) connection.disconnect(); }
        });
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
                        JSObject result = new JSObject(); result.put("cached", true); call.resolve(result); return;
                    } catch (Exception invalid) {
                        if (transfer.cancelled) throw invalid;
                        if (!target.delete()) throw new Exception("CACHE_CLEANUP");
                    }
                }
                URL url = new URL(call.getString("url", ""));
                if (!url.getProtocol().equals("https") || !url.getHost().equals("dl.rose7.cn") ||
                        (url.getPort() != -1 && url.getPort() != 443) || url.getUserInfo() != null ||
                        url.getQuery() != null || url.getRef() != null ||
                        !url.getPath().matches("/apk/[a-zA-Z0-9._-]+\\.apk")) throw new Exception("INVALID_URL");
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                transfer.connection = connection;
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setRequestProperty("Accept-Encoding", "identity");
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
                        if (now - lastEvent >= 100 || received == size) {
                            JSObject progress = new JSObject(); progress.put("id", id);
                            progress.put("received", received); progress.put("total", size);
                            notifyListeners("downloadProgress", progress); lastEvent = now;
                        }
                    }
                    output.getFD().sync();
                }
                verify(temporary, hash, size, versionCode, transfer);
                if (transfer.cancelled) throw new Exception("CANCELLED");
                if (!temporary.renameTo(target)) throw new Exception("CACHE_RENAME");
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
