package com.example.deepseekchat;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Read-only, minimal device facts for diagnostics; never reads identifiers or account data. */
@CapacitorPlugin(name = "DiagnosticsDevice")
public class DiagnosticsDevicePlugin extends Plugin {
    private String version(PackageInfo info) {
        if (info == null) return "unknown";
        return info.versionName == null ? "unknown" : info.versionName;
    }
    @PluginMethod
    public void snapshot(PluginCall call) {
        try {
            JSObject out = new JSObject();
            out.put("androidRelease", Build.VERSION.RELEASE == null ? "unknown" : Build.VERSION.RELEASE);
            out.put("androidSdk", Build.VERSION.SDK_INT);
            out.put("manufacturer", Build.MANUFACTURER == null ? "unknown" : Build.MANUFACTURER);
            out.put("brand", Build.BRAND == null ? "unknown" : Build.BRAND);
            out.put("model", Build.MODEL == null ? "unknown" : Build.MODEL);
            PackageManager pm = getContext().getPackageManager();
            String webPackage = "unknown", webVersion = "unknown";
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo wi = WebView.getCurrentWebViewPackage();
                if (wi != null) { webPackage = wi.packageName; webVersion = version(wi); }
            } else {
                // API <26 has no authoritative current-provider API. Do not guess from installed packages.
                webPackage = "unknown";
                webVersion = "unknown";
            }
            out.put("webviewPackage", webPackage);
            out.put("webviewVersion", webVersion);
            DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            out.put("density", dm.density);
            out.put("fontScale", getContext().getResources().getConfiguration().fontScale);
            out.put("screenWidth", dm.widthPixels);
            out.put("screenHeight", dm.heightPixels);
            call.resolve(out);
        } catch (Exception error) {
            call.reject("读取设备信息失败", "DEVICE_INFO_UNAVAILABLE");
        }
    }
}
