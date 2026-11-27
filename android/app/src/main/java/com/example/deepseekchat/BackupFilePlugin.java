package com.example.deepseekchat;

import android.os.StatFs;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.regex.Pattern;

/**
 * 原生备份文件出口（Issue #993 任务 2）：把备份写成 <b>App 私有目录</b>里的普通文件。
 *
 * <p>为什么必须走原生而不是浏览器的「下载 / OPFS」：备份的意义是在 WebView 的 IndexedDB 被系统淘汰、
 * 或者用户清了站点数据之后还能把数据拿回来。落到 {@code getFilesDir()/backups} 之后，它与
 * IndexedDB、Cache 是两套生命周期 —— 库没了，备份还在。
 *
 * <p><b>原子写入</b>：写 {@code <name>.part} → 重新读一遍临时文件算 sha256 与「写入时累计的摘要」比对
 * → 一致才 {@code renameTo(<name>)}。所以：
 * <ul>
 *   <li>半截文件永远叫 {@code .part}，不会被 {@link #list} 列出来（JS 侧不认它，也就不会当成备份）；</li>
 *   <li>失败只删 {@code .part}，<b>不动任何已提交的文件</b> —— 上一份有效备份一个字节都不受影响；</li>
 *   <li>同名目标已存在时直接拒绝（{@code TARGET_EXISTS}），绝不覆盖已有备份。**唯一例外**是
 *       可变状态文件 {@code status.json}（见 {@link #OVERWRITABLE_NAME}）：调用方必须同时
 *       显式传 {@code allowOverwrite} 且名字恰好在白名单里，才允许同名替换，替换仍走
 *       {@code rename(2)}，旧状态在 rename 成功前一直可读。</li>
 * </ul>
 *
 * <p><b>分块</b>：沿用 {@link ExportTextPlugin} 的二进制分块思路（base64 过桥，块大小由 JS 定，
 * 48KiB），单次过桥的数据量与整包大小无关 —— 备份 200MB 也不会把整库塞进一次调用。
 *
 * <p><b>名字约束</b>：只接受 {@code [A-Za-z0-9][A-Za-z0-9._-]{0,127}}，平铺在 backup 目录，
 * 不允许路径分隔符 —— 这条既防「写穿目录」，也让 {@link #list} 的结果可当作 id 用。
 *
 * <p><b>错误码</b>（JS 侧据此分类成人话，不把 message 直接给用户）：
 * {@code BUSY} / {@code INVALID_NAME} / {@code NO_WRITE} / {@code WRITE_FAILED} /
 * {@code VERIFY_FAILED} / {@code CHECKSUM_MISMATCH} / {@code TARGET_EXISTS} / {@code NOT_FOUND} /
 * {@code READ_FAILED} / {@code NO_SPACE}。
 */
@CapacitorPlugin(name = "BackupFile")
public class BackupFilePlugin extends Plugin {

    /** 备份目录（App 私有 files 下，WebView 存储之外，卸载 App 才会消失） */
    private static final String DIR_NAME = "backups";
    /** 临时文件后缀：存在的意义见类注释的「原子写入」 */
    private static final String PART_SUFFIX = ".part";
    /** 残留临时文件的存活上限：进程被杀留下的 .part 超过 1 小时视为垃圾 */
    private static final long STALE_PART_TTL_MS = 60L * 60L * 1000L;
    /** 单次读块上限（JS 侧请求 48KiB，这里只兜底异常的大请求） */
    private static final int READ_CHUNK_MAX = 256 * 1024;
    private static final int READ_CHUNK_DEFAULT = 48 * 1024;
    /** 校验 / 摘要计算的缓冲区：64KiB，与 ExternalFilePlugin 同一个量级 */
    private static final int DIGEST_BUFFER = 64 * 1024;
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    /**
     * <b>唯一</b>允许同名替换的文件：状态文件是可变状态，不是备份。
     *
     * <p>白名单写死在这里，不是调用方能拧的开关 —— 备份归档（{@code .zip} / 清单）永远拿不到
     * 覆盖权限，即使 JS 侧传了 {@code allowOverwrite} 也照样 {@code TARGET_EXISTS}。
     * 替换发生在 {@link #finish} 的 {@code renameTo}，是 {@code rename(2)} 的原子替换：
     * 旧状态在 rename 成功之前一直可读，任何一步失败都只会丢掉 {@code .part}。
     */
    private static final String OVERWRITABLE_NAME = "status.json";

    /* ------------------------------------------------------------------ 进行中的写入会话 */
    private File activePart;
    private String activeName;
    private FileOutputStream activeOutput;
    private MessageDigest activeDigest;
    private long activeBytes;
    /** 本次会话是否被授权同名替换（在 {@link #begin} 时判过白名单，{@link #finish} 只认这个结论） */
    private boolean activeOverwrite;

    /** 备份目录；不存在时创建。失败交给调用方按 IO 错误处理。 */
    private File dir() {
        File directory = new File(getContext().getFilesDir(), DIR_NAME);
        if (!directory.exists()) {
            //noinspection ResultOfMethodCallIgnored
            directory.mkdirs();
        }
        return directory;
    }

    /** 名字 → 目录里的文件；非法名字返回 null（调用方按 INVALID_NAME 拒绝）。 */
    private File fileFor(String name) {
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            return null;
        }
        return new File(dir(), name);
    }

    /**
     * 开始写一份新文件：先建 {@code <name>.part}，顺便清理超过 1 小时的残留临时文件。
     * 同一时刻只允许一个写入会话（JS 侧本来也是串行的，这里再兜一层，避免两次写交错进同一个 .part）。
     *
     * <p>同名目标已存在时拒绝（{@code TARGET_EXISTS}），例外只有 {@link #OVERWRITABLE_NAME}：
     * 调用方显式传 {@code allowOverwrite=true} 且名字恰好等于状态文件时才放行（见 {@link #mayOverwrite}）。
     * 放行也只是「不提前拒绝」—— 覆盖真正发生在 {@link #finish} 的 rename。
     */
    @PluginMethod
    public synchronized void begin(PluginCall call) {
        if (activeOutput != null) {
            call.reject("已有备份写入正在进行", "BUSY");
            return;
        }
        String name = call.getString("name", null);
        File target = fileFor(name);
        if (target == null) {
            call.reject("备份文件名不合法", "INVALID_NAME");
            return;
        }
        boolean allowOverwrite = Boolean.TRUE.equals(call.getBoolean("allowOverwrite", false));
        boolean overwrite = mayOverwrite(name, allowOverwrite);
        if (target.exists() && !overwrite) {
            call.reject("同名备份已存在", "TARGET_EXISTS");
            return;
        }
        cleanupStaleParts();
        File part = new File(dir(), name + PART_SUFFIX);
        try {
            FileOutputStream output = new FileOutputStream(part, false);
            activePart = part;
            activeName = name;
            activeOutput = output;
            activeBytes = 0;
            activeOverwrite = overwrite;
            activeDigest = MessageDigest.getInstance("SHA-256");
        } catch (Exception error) {
            discard();
            call.reject("打开备份临时文件失败", "WRITE_FAILED");
            return;
        }
        JSObject result = new JSObject();
        result.put("name", name);
        call.resolve(result);
    }

    /**
     * 是否允许同名替换：<b>调用方明确要求</b> 且 <b>名字在白名单里</b>，两者缺一不可。
     * 所以 JS 侧即使把 {@code allowOverwrite} 当真传给归档或清单，也只会拿到 {@code TARGET_EXISTS}。
     */
    private static boolean mayOverwrite(String name, boolean allowOverwrite) {
        return allowOverwrite && OVERWRITABLE_NAME.equals(name);
    }

    /** 追加一块（{@code data} 是 base64；原生侧 {@code Base64.DEFAULT} 解码，容忍换行）。 */
    @PluginMethod
    public synchronized void writeChunk(PluginCall call) {
        if (activeOutput == null) {
            call.reject("没有正在进行的备份写入", "NO_WRITE");
            return;
        }
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            discard();
            call.reject("备份分块解码失败", "BAD_CHUNK");
            return;
        }
        try {
            activeOutput.write(bytes);
            activeDigest.update(bytes);
            activeBytes += bytes.length;
            call.resolve();
        } catch (Exception error) {
            discard();
            // 磁盘满时这里抛的是 ENOSPC / IOException：归类留给 JS（按 code + 空间状态判定）
            call.reject("写入备份失败", "WRITE_FAILED");
        }
    }

    /**
     * 收尾：flush + fsync → 关流 → <b>把临时文件重读一遍算摘要，与写入时累计的摘要比对</b> →
     * 一致才 rename 成正式文件名。
     *
     * <p>比对的两份摘要都来自原生侧：一份是刚才写下去的字节，一份是磁盘上真实存在的字节。
     * 它证明的是「rename 出去的就是刚校验过的这份内容」，不是「JS 说它算过了」。
     */
    @PluginMethod
    public synchronized void finish(PluginCall call) {
        if (activeOutput == null || activePart == null || activeName == null) {
            call.reject("没有正在进行的备份写入", "NO_WRITE");
            return;
        }
        File part = activePart;
        String name = activeName;
        long bytes = activeBytes;
        String writtenDigest;
        try {
            activeOutput.flush();
            activeOutput.getFD().sync();
            activeOutput.close();
            activeOutput = null;
            writtenDigest = hex(activeDigest.digest());
        } catch (Exception error) {
            discard();
            call.reject("备份收尾失败", "WRITE_FAILED");
            return;
        }
        String diskDigest;
        try {
            diskDigest = digestOf(part);
        } catch (Exception error) {
            discard();
            call.reject("备份校验失败", "VERIFY_FAILED");
            return;
        }
        if (!diskDigest.equals(writtenDigest)) {
            discard();
            call.reject("校验值与落盘内容不一致", "CHECKSUM_MISMATCH");
            return;
        }
        File target = new File(dir(), name);
        // 会话在 begin 时已经判过白名单；这里的再检查保证「非白名单名字永远不覆盖」不依赖调用顺序
        if (target.exists() && !activeOverwrite) {
            discard();
            call.reject("同名备份已存在", "TARGET_EXISTS");
            return;
        }
        // rename(2)：同目录内原子替换 —— 旧文件在 rename 成功之前一直完好，失败就只剩 .part 被删
        if (!part.renameTo(target)) {
            discard();
            call.reject("备份落盘失败", "RENAME_FAILED");
            return;
        }
        activePart = null;
        activeName = null;
        activeOutput = null;
        activeDigest = null;
        activeBytes = 0;
        activeOverwrite = false;
        JSObject result = new JSObject();
        result.put("name", name);
        result.put("sizeBytes", bytes);
        result.put("sha256", diskDigest);
        call.resolve(result);
    }

    /** 放弃本次写入：只删临时文件，任何已提交的备份都不动。 */
    @PluginMethod
    public synchronized void abort(PluginCall call) {
        discard();
        call.resolve();
    }

    /** 目录里的正式文件（{@code .part} 不列）。 */
    @PluginMethod
    public synchronized void list(PluginCall call) {
        JSArray files = new JSArray();
        File[] entries = dir().listFiles();
        if (entries != null) {
            for (File item : entries) {
                if (!item.isFile() || item.getName().endsWith(PART_SUFFIX)) {
                    continue;
                }
                JSObject row = new JSObject();
                row.put("name", item.getName());
                row.put("sizeBytes", item.length());
                row.put("mtimeMs", item.lastModified());
                files.put(row);
            }
        }
        JSObject result = new JSObject();
        result.put("files", files);
        call.resolve(result);
    }

    /** 按偏移读一块（base64），用于「不把整档读进内存」地把备份流回 JS。 */
    @PluginMethod
    public synchronized void readChunk(PluginCall call) {
        String name = call.getString("name", null);
        File file = fileFor(name);
        if (file == null) {
            call.reject("备份文件名不合法", "INVALID_NAME");
            return;
        }
        if (!file.isFile()) {
            call.reject("备份文件不存在", "NOT_FOUND");
            return;
        }
        JSObject data = call.getData();
        long offset = data == null ? 0L : data.optLong("offset", 0L);
        int length = data == null ? READ_CHUNK_DEFAULT : data.optInt("length", READ_CHUNK_DEFAULT);
        if (offset < 0L) {
            offset = 0L;
        }
        if (length <= 0) {
            length = READ_CHUNK_DEFAULT;
        }
        if (length > READ_CHUNK_MAX) {
            length = READ_CHUNK_MAX;
        }
        byte[] buffer = new byte[length];
        int read;
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            input.seek(offset);
            read = input.read(buffer, 0, length);
        } catch (Exception error) {
            call.reject("读取备份失败", "READ_FAILED");
            return;
        }
        if (read <= 0) {
            JSObject result = new JSObject();
            result.put("data", "");
            result.put("eof", true);
            call.resolve(result);
            return;
        }
        byte[] slice = read == length ? buffer : java.util.Arrays.copyOf(buffer, read);
        JSObject result = new JSObject();
        result.put("data", android.util.Base64.encodeToString(slice, android.util.Base64.NO_WRAP));
        result.put("eof", offset + read >= file.length());
        call.resolve(result);
    }

    /** 整档摘要（恢复前校验用）：流式读一遍，不把文件读进内存。 */
    @PluginMethod
    public synchronized void hash(PluginCall call) {
        String name = call.getString("name", null);
        File file = fileFor(name);
        if (file == null) {
            call.reject("备份文件名不合法", "INVALID_NAME");
            return;
        }
        if (!file.isFile()) {
            call.reject("备份文件不存在", "NOT_FOUND");
            return;
        }
        String digest;
        try {
            digest = digestOf(file);
        } catch (Exception error) {
            call.reject("读取备份失败", "READ_FAILED");
            return;
        }
        JSObject result = new JSObject();
        result.put("sha256", digest);
        result.put("sizeBytes", file.length());
        call.resolve(result);
    }

    /** 删一份文件（保留策略由 JS 决定删哪些，这里只执行）。 */
    @PluginMethod
    public synchronized void remove(PluginCall call) {
        String name = call.getString("name", null);
        File file = fileFor(name);
        if (file == null) {
            call.reject("备份文件名不合法", "INVALID_NAME");
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        call.resolve();
    }

    /** 可用字节数：备份前预判「够不够写下一份」，空间不足要提前说人话而不是写到一半失败。 */
    @PluginMethod
    public synchronized void freeBytes(PluginCall call) {
        long bytes;
        try {
            StatFs stat = new StatFs(dir().getAbsolutePath());
            bytes = stat.getAvailableBytes();
        } catch (Exception error) {
            call.reject("读取可用空间失败", "IO");
            return;
        }
        JSObject result = new JSObject();
        result.put("bytes", bytes);
        call.resolve(result);
    }

    /** 页面销毁 / 插件释放：别把半截 .part 留在盘上 */
    @Override
    protected void handleOnDestroy() {
        discard();
        super.handleOnDestroy();
    }

    private void discard() {
        try {
            if (activeOutput != null) {
                activeOutput.close();
            }
        } catch (Exception ignored) {
        }
        activeOutput = null;
        if (activePart != null) {
            //noinspection ResultOfMethodCallIgnored
            activePart.delete();
        }
        activePart = null;
        activeName = null;
        activeDigest = null;
        activeBytes = 0;
        activeOverwrite = false;
    }

    /** 清理进程被杀留下的临时文件（超过 TTL 的） */
    private void cleanupStaleParts() {
        File[] entries = dir().listFiles();
        if (entries == null) {
            return;
        }
        long now = System.currentTimeMillis();
        for (File item : entries) {
            if (!item.isFile() || !item.getName().endsWith(PART_SUFFIX)) {
                continue;
            }
            if (now - item.lastModified() > STALE_PART_TTL_MS) {
                //noinspection ResultOfMethodCallIgnored
                item.delete();
            }
        }
    }

    private String digestOf(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[DIGEST_BUFFER];
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
            }
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) {
            builder.append(Character.forDigit((item >> 4) & 0xf, 16));
            builder.append(Character.forDigit(item & 0xf, 16));
        }
        return builder.toString();
    }
}
