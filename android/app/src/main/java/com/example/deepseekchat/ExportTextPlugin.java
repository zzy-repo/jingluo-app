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

/**
 * 文件保存出口（SAF）：先写 App 私有临时文件，用户选好位置且全部字节写完才一次性拷到目标。
 *
 * <p>两种模式，走同一套 start / write* / finish 流程：
 * <ul>
 *   <li><b>文本</b>（{@code text/plain}、{@code application/json}）：沿用原有 8MB 上限，反馈日志导出用；</li>
 *   <li><b>二进制</b>（{@code application/zip}，{@code binary=true} + {@code writeBinaryChunk}）：
 *       历史会话归档用。上限 {@link #MAX_BINARY_BYTES}（200MB，与导入侧
 *       {@code importLimit.DEFAULT_MAX_IMPORT_BYTES} 同一个数）：导出产物必须能被本 App 的
 *       「导入历史对话」读回，所以**导出上限不能大于导入上限** —— 大一点就会产出
 *       「导得出、导不回」的包（(200MB, 220MB] 死区，issue #336）。
 *       <b>权威判断在 TS 侧</b>（{@code history/zipWriter.ts} 的 {@code MAX_EXPORT_BYTES} + {@code writeArchive}
 *       在打开 SAF 之前就拦），这里只是纯兜底：万一上游漏判，也别让超过 200MB 的字节落到用户选的文件里。</li>
 * </ul>
 *
 * <p>失败语义：目标位置在 {@code finish} 之前一个字节都不写，中途失败只删临时文件，磁盘上不会留半截产物；
 * {@code finish} 拷到一半失败时把目标 URI 也删掉，避免用户看到「大小不对的归档」。
 */
@CapacitorPlugin(name = "ExportText")
public class ExportTextPlugin extends Plugin {
    /** 文本出口上限（原有行为，反馈日志等小文件）。 */
    private static final long MAX_BYTES = 8L * 1024 * 1024;
    /**
     * 二进制出口上限（兜底）：与导入侧 200MB 相等，理由见类注释。
     * 权威判断在 TS 侧（{@code history/zipWriter.ts} 的 {@code MAX_EXPORT_BYTES}）：那边在打开 SAF 之前就拒，
     * 用户不会先选好位置再看到「文件过大」；这里只保证任何情况下都不会写超。
     */
    private static final long MAX_BINARY_BYTES = 200L * 1024 * 1024;
    private static final String MIME_TEXT = "text/plain";
    private static final String MIME_JSON = "application/json";
    private static final String MIME_ZIP = "application/zip";

    private File activeFile;
    private FileOutputStream activeOutput;
    private Uri destination;
    private long activeBytes;
    /** 本次导出是否为二进制模式（决定上限与允许的编码方式）。 */
    private boolean binaryMode;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        if (activeOutput != null) { call.reject("已有导出正在进行", "BUSY"); return; }
        String name = call.getString("name", "deepseek-export.txt").replaceAll("[^a-zA-Z0-9._-]", "_");
        String mimeType = call.getString("mimeType", MIME_TEXT);
        boolean binary = Boolean.TRUE.equals(call.getBoolean("binary", false));
        boolean textMime = MIME_TEXT.equals(mimeType) || MIME_JSON.equals(mimeType);
        // 二进制模式只接受归档包：别的类型没有对应的写入路径，宁可直接拒绝也不写坏文件
        if (binary ? !MIME_ZIP.equals(mimeType) : !textMime) { call.reject("文件类型不支持", "INVALID_MIME"); return; }
        try {
            activeFile = new File(getContext().getCacheDir(), "export-" + UUID.randomUUID() + ".part");
            activeOutput = new FileOutputStream(activeFile);
            activeBytes = 0;
            binaryMode = binary;
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
        if (binaryMode) { call.reject("本次导出不是文本模式", "WRONG_MODE"); return; }
        byte[] bytes = call.getString("data", "").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (activeBytes + bytes.length > MAX_BYTES) { call.reject("文本超过 TXT 导出上限", "TOO_LARGE"); return; }
        try { activeOutput.write(bytes); activeBytes += bytes.length; call.resolve(); }
        catch (Exception error) { call.reject("写入 TXT 失败", "WRITE_FAILED"); }
    }

    /**
     * 二进制分块：{@code data} 是 base64（原生侧用 {@code Base64.DEFAULT} 解码，容忍换行）。
     * 分块边界由 JS 侧定（48KiB 原始字节），单次过桥的数据量与包体无关。
     */
    @PluginMethod
    public synchronized void writeBinaryChunk(PluginCall call) {
        if (activeOutput == null) { call.reject("没有正在进行的导出", "NO_EXPORT"); return; }
        if (!binaryMode) { call.reject("本次导出不是二进制模式", "WRONG_MODE"); return; }
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException error) { call.reject("二进制分块解码失败", "BAD_CHUNK"); return; }
        if (activeBytes + bytes.length > MAX_BINARY_BYTES) { call.reject("归档超过 200MB 导出上限（与导入上限一致）", "TOO_LARGE"); return; }
        try { activeOutput.write(bytes); activeBytes += bytes.length; call.resolve(); }
        catch (Exception error) { call.reject("写入归档失败", "WRITE_FAILED"); }
    }

    @PluginMethod
    public synchronized void finish(PluginCall call) {
        if (activeOutput == null || activeFile == null || destination == null) { call.reject("没有正在进行的导出", "NO_EXPORT"); return; }
        String savedName = displayName(destination);
        try {
            activeOutput.flush(); activeOutput.getFD().sync(); activeOutput.close(); activeOutput = null;
            try (FileInputStream input = new FileInputStream(activeFile); android.os.ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(destination, "w"); FileOutputStream output = new FileOutputStream(descriptor.getFileDescriptor())) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.flush();
            }
            cleanup(); JSObject result = new JSObject(); result.put("status", "saved"); result.put("name", savedName); call.resolve(result);
        } catch (Exception error) {
            // 拷到一半失败：目标位置已经出现不完整文件，删掉它，别留给用户一个「打不开的归档」
            try { getContext().getContentResolver().delete(destination, null, null); } catch (Exception ignored) {}
            cleanup(); call.reject("写入文件失败", "WRITE_FAILED");
        }
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

    /** 目标位置显示名（SAF 可能按重名规则改名，界面提示要用真实落盘名）。取不到时返回 null。 */
    private String displayName(Uri uri) {
        try (android.database.Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) { return cursor.getString(index); }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private void cleanup() {
        try { if (activeOutput != null) activeOutput.close(); } catch (Exception ignored) {}
        activeOutput = null; if (activeFile != null) activeFile.delete(); activeFile = null; destination = null; activeBytes = 0; binaryMode = false;
    }
}
