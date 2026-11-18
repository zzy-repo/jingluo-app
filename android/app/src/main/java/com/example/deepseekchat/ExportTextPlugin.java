package com.example.deepseekchat;

import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.UUID;

@CapacitorPlugin(name = "ExportText")
public class ExportTextPlugin extends Plugin {
    private static final long MAX_BYTES = 8L * 1024 * 1024;
    private File activeFile;
    private FileOutputStream activeOutput;
    private Uri destination;
    private long activeBytes;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        if (activeOutput != null) { call.reject("已有导出正在进行", "BUSY"); return; }
        String name = call.getString("name", "deepseek-export.txt").replaceAll("[^a-zA-Z0-9._-]", "_");
        String mimeType = call.getString("mimeType", "text/plain");
        if (!mimeType.equals("text/plain") && !mimeType.equals("application/json")) { call.reject("文件类型不支持", "INVALID_MIME"); return; }
        try {
            activeFile = new File(getContext().getCacheDir(), "export-" + UUID.randomUUID() + ".part");
            activeOutput = new FileOutputStream(activeFile);
            activeBytes = 0;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(call, intent, "exportResult");
        } catch (Exception error) { cleanup(); call.reject("打开保存位置失败", "START_FAILED"); }
    }

    @PluginMethod
    public synchronized void writeChunk(PluginCall call) {
        if (activeOutput == null) { call.reject("没有正在进行的导出", "NO_EXPORT"); return; }
        byte[] bytes = call.getString("data", "").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (activeBytes + bytes.length > MAX_BYTES) { call.reject("文本超过 TXT 导出上限", "TOO_LARGE"); return; }
        try { activeOutput.write(bytes); activeBytes += bytes.length; call.resolve(); }
        catch (Exception error) { call.reject("写入 TXT 失败", "WRITE_FAILED"); }
    }

    @PluginMethod
    public synchronized void finish(PluginCall call) {
        if (activeOutput == null || activeFile == null || destination == null) { call.reject("没有正在进行的导出", "NO_EXPORT"); return; }
        try {
            activeOutput.flush(); activeOutput.getFD().sync(); activeOutput.close(); activeOutput = null;
            try (FileInputStream input = new FileInputStream(activeFile); android.os.ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(destination, "w"); FileOutputStream output = new FileOutputStream(descriptor.getFileDescriptor())) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.flush();
            }
            cleanup(); JSObject result = new JSObject(); result.put("status", "saved"); call.resolve(result);
        } catch (Exception error) { cleanup(); call.reject("写入 TXT 失败", "WRITE_FAILED"); }
    }

    @PluginMethod
    public synchronized void abort(PluginCall call) { cleanup(); call.resolve(); }

    @ActivityCallback
    private synchronized void exportResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            cleanup(); JSObject response = new JSObject(); response.put("status", "cancelled"); call.resolve(response); return;
        }
        destination = result.getData().getData();
        JSObject response = new JSObject(); response.put("id", UUID.randomUUID().toString()); call.resolve(response);
    }

    private void cleanup() {
        try { if (activeOutput != null) activeOutput.close(); } catch (Exception ignored) {}
        activeOutput = null; if (activeFile != null) activeFile.delete(); activeFile = null; destination = null; activeBytes = 0;
    }
}
