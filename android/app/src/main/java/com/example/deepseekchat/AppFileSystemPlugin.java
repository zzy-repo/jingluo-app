package com.example.deepseekchat;

import android.os.StatFs;
import android.system.ErrnoException;
import android.system.OsConstants;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.UUID;

/**
 * 应用内部文件系统（#907）：只服务 {@code getFilesDir()/app-fs} 下的相对路径。
 *
 * <p>原子写：同目录临时文件 → {@code FileOutputStream.getFD().sync()} → {@code renameTo} 覆盖。
 * 任何一步失败都删除临时文件，目标文件保持原样（rename 在同一文件系统上是原子的）。
 *
 * <p>错误码：{@code QUOTA}（ENOSPC，磁盘满）/ {@code UNAVAILABLE}（路径逃逸、目录不可用）/ {@code IO}（其余）。
 * TS 侧按 code 映射成 {@code FsError.kind}。
 *
 * <p>{@link #capabilities} 返回方法清单、{@link #ping} 做运行时探针（私有目录可建、可写），
 * 供 TS 侧 {@code probeNativePlugin} 在首次 I/O 前判定，不靠「调了看会不会炸」。
 */
@CapacitorPlugin(name = "AppFileSystem")
public class AppFileSystemPlugin extends Plugin {
    /** 私有目录下的根子目录：与 cache / 外部导入的临时目录分开，不互相清扫。 */
    static final String ROOT_DIR = "app-fs";
    /** 与 TS 侧 {@code FS_TMP_SUFFIX} 同一串：list 不返回、调用方不能拿它命名。 */
    static final String TMP_SUFFIX = ".fstmp";

    /** 本插件对外提供的方法清单；与 TS 侧 {@code REQUIRED_METHODS} 对应，新增方法时两边同步。 */
    private static final String[] METHODS = {"writeAtomic", "read", "list", "remove", "freeBytes", "ping"};

    private File root() {
        return new File(getContext().getFilesDir(), ROOT_DIR);
    }

    /** 相对路径 → 根内的真实文件。绝对路径、{@code ..}、空段、NUL、反斜杠一律拒绝。 */
    private File resolve(String relative) throws IOException {
        if (relative == null) {
            throw new IOException("path must be a string");
        }
        if (relative.indexOf('\0') >= 0 || relative.indexOf('\\') >= 0 || relative.startsWith("/")) {
            throw new IOException("illegal path");
        }
        if (relative.endsWith(TMP_SUFFIX)) {
            throw new IOException("illegal path");
        }
        String[] segments = relative.isEmpty() ? new String[0] : relative.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                throw new IOException("illegal path");
            }
        }
        File file = new File(root(), relative);
        String rootPath = root().getCanonicalPath();
        String filePath = file.getCanonicalPath();
        if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) {
            throw new IOException("path escapes root");
        }
        return file;
    }

    /** 异常链里出现 ENOSPC 才算配额；其余 I/O 一律 IO。 */
    private static boolean isNoSpace(Throwable error) {
        for (Throwable cursor = error; cursor != null; cursor = cursor.getCause()) {
            if (cursor instanceof ErrnoException && ((ErrnoException) cursor).errno == OsConstants.ENOSPC) {
                return true;
            }
            String message = cursor.getMessage();
            if (message != null && message.toLowerCase(java.util.Locale.ROOT).contains("no space left")) {
                return true;
            }
        }
        return false;
    }

    private void rejectIO(PluginCall call, String fallback, Exception error) {
        if (isNoSpace(error)) {
            call.reject("no space left on device", "QUOTA", error);
        } else {
            call.reject(fallback, "IO", error);
        }
    }

    @PluginMethod
    public void writeAtomic(PluginCall call) {
        String relative = call.getString("path");
        String encoded = call.getString("data", "");
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("bad base64", "IO");
            return;
        }
        File target;
        try {
            target = resolve(relative);
        } catch (IOException error) {
            call.reject("illegal path", "UNAVAILABLE");
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            call.reject("cannot create parent directory", "UNAVAILABLE");
            return;
        }
        File temp = new File(target.getParentFile(), target.getName() + "." + UUID.randomUUID() + TMP_SUFFIX);
        FileOutputStream output = null;
        try {
            output = new FileOutputStream(temp);
            output.write(bytes);
            output.flush();
            output.getFD().sync();
            output.close();
            output = null;
            if (!temp.renameTo(target)) {
                throw new IOException("rename failed");
            }
            call.resolve();
        } catch (Exception error) {
            rejectIO(call, "write failed", error);
        } finally {
            if (output != null) {
                try { output.close(); } catch (IOException ignored) {}
            }
            if (temp.exists()) {
                temp.delete();
            }
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        File target;
        try {
            target = resolve(call.getString("path"));
        } catch (IOException error) {
            call.reject("illegal path", "UNAVAILABLE");
            return;
        }
        JSObject result = new JSObject();
        if (!target.isFile()) {
            result.put("exists", false);
            call.resolve(result);
            return;
        }
        try (FileInputStream input = new FileInputStream(target)) {
            byte[] bytes = new byte[(int) target.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) {
                    break;
                }
                offset += count;
            }
            result.put("exists", true);
            result.put("data", android.util.Base64.encodeToString(bytes, 0, offset, android.util.Base64.NO_WRAP));
            call.resolve(result);
        } catch (IOException error) {
            rejectIO(call, "read failed", error);
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        File target;
        try {
            target = resolve(call.getString("dir", ""));
        } catch (IOException error) {
            call.reject("illegal path", "UNAVAILABLE");
            return;
        }
        JSArray entries = new JSArray();
        File[] children = target.isDirectory() ? target.listFiles() : null;
        if (children != null) {
            java.util.Arrays.sort(children, (left, right) -> left.getName().compareTo(right.getName()));
            for (File child : children) {
                if (!child.isFile() || child.getName().endsWith(TMP_SUFFIX)) {
                    continue;
                }
                JSObject entry = new JSObject();
                entry.put("name", child.getName());
                entry.put("size", child.length());
                entry.put("modifiedAt", child.lastModified());
                entries.put(entry);
            }
        }
        JSObject result = new JSObject();
        result.put("entries", entries);
        call.resolve(result);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        File target;
        try {
            target = resolve(call.getString("path"));
        } catch (IOException error) {
            call.reject("illegal path", "UNAVAILABLE");
            return;
        }
        deleteRecursively(target);
        call.resolve();
    }

    private void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        file.delete();
    }

    @PluginMethod
    public void freeBytes(PluginCall call) {
        JSObject result = new JSObject();
        try {
            File dir = root();
            if (!dir.isDirectory() && !dir.mkdirs()) {
                call.resolve(result);
                return;
            }
            StatFs stats = new StatFs(dir.getAbsolutePath());
            result.put("bytes", stats.getAvailableBytes());
        } catch (Exception ignored) {
            // 取不到就返回空对象：TS 侧映射成 undefined，不把「不知道还剩多少」当成失败
        }
        call.resolve(result);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSArray methods = new JSArray();
        for (String method : METHODS) {
            methods.put(method);
        }
        JSObject result = new JSObject();
        result.put("methods", methods);
        call.resolve(result);
    }

    /** 轻量运行时探针：根目录可建，且能创建并删除一个临时文件。 */
    @PluginMethod
    public void ping(PluginCall call) {
        File dir = root();
        if (!dir.isDirectory() && !dir.mkdirs()) {
            call.reject("cannot create app-fs directory", "UNAVAILABLE");
            return;
        }
        File probe = new File(dir, "ping-" + UUID.randomUUID() + TMP_SUFFIX);
        try (FileOutputStream output = new FileOutputStream(probe)) {
            output.write(0);
            output.getFD().sync();
        } catch (Exception error) {
            if (isNoSpace(error)) {
                call.reject("no space left on device", "QUOTA", error);
            } else {
                call.reject("app-fs directory not writable", "UNAVAILABLE", error);
            }
            return;
        } finally {
            probe.delete();
        }
        call.resolve();
    }
}
