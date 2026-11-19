package com.example.deepseekchat;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 大包导入的原生半边（Issue #34）：**下载直接流式落盘 + 按区间回读**。
 *
 * <p>为什么必须有这个插件（理由已贴在 issue #34 评论里）：{@code CapacitorHttp.get} 是
 * 「整包一次性回给 JS」的语义，包体必然先落进 WebView/Blink 堆，这正是旧实现
 * {@code chunks}（1x）+ {@code new File(chunks)}（2x）的来源；{@code @capacitor/filesystem}
 * 的 {@code writeFile/appendFile} 又要 JS 把 base64 交过去，等于换了个地方过桥。本插件把
 * **网络读 + 落盘**整段留在原生侧，JS 只看到「已下载多少字节」这一个数字。
 *
 * <p>三个纪律：
 * <ul>
 *   <li><b>超限在写第一个字节之前拒</b>（关闭条件 3）：建连后先看响应头声明的总量
 *       （206 的 {@code Content-Range} 尾部 total，或 200 的 {@code Content-Length}），
 *       超过调用方给的 {@code maxBytes} 立刻断开并回 {@code state=tooLarge}；
 *       此时临时文件还没创建（或刚创建就被删掉），没有落盘。</li>
 *   <li><b>临时文件的生命周期只有一个主人</b>（关闭条件 4）：{@code abortDownload} 在返回前
 *       同步删文件；下载自然结束（成功/失败）时**不删**，由 JS 侧决定何时调 {@code deleteFile}
 *       —— 因为 JS 才是「这次导入结束了没有」的判定者。失败路径 JS 一定会调
 *       {@code abortDownload}（见 {@code urlImport.ts}），所以不存在残留。</li>
 *   <li><b>不做时间判定</b>：本类只有连接/读超时（链路自身的设施），判死（无进展停滞 / 硬上限）
 *       全部在 JS 侧，按「字节是否在增长」判，绝不按总墙钟（#38）。</li>
 * </ul>
 *
 * <p>返回形状（除参数非法外永远 {@code resolve}，让 JS 侧按 {@code state} 分档）：
 * {@code {state:"downloading", path, bytes, total, restarted}}
 * {@code | {state:"tooLarge", declared}}
 * {@code | {state:"done", path, bytes, total}}（重试时文件已经完整）
 * {@code | {state:"http", status, body}}（非 2xx，403 的 OBS 错误码靠 body 细分）
 * {@code | {state:"failed", error}}（异常原文，JS 侧按 timeout/unreachable/interrupted 分类）
 */
@CapacitorPlugin(name = "HistoryArchive")
public class HistoryArchivePlugin extends Plugin {

    /** 临时文件名前缀：只认这个前缀的文件，其它路径一律拒（防越权读写）。 */
    private static final String TEMP_PREFIX = "import-";

    /** 单次区间读的上限：ZIP 中央目录与压缩块都是几百 KB 级，1MiB 足够且把过桥内存钉死。 */
    private static final long MAX_RANGE_BYTES = 1024L * 1024L;

    /** 非 2xx 时读回的错误体上限（OBS 的 XML 错误页只有几百字节）。 */
    private static final int ERROR_BODY_BYTES = 4096;

    /** 落盘缓冲：64KiB。整个下载只有这一个缓冲区，与包体无关。 */
    private static final int BUFFER_BYTES = 64 * 1024;

    /** {@code Content-Range: bytes 0-1023/21195845} 里的总长度。 */
    private static final Pattern CONTENT_RANGE_TOTAL = Pattern.compile("/(\\d+)\\s*$");

    /** 同一时刻只允许一个下载（导入链路本身是串行的，这里只做防御）。 */
    private volatile Download active;

    /** 一次下载的共享状态：JS 轮询 {@link #getProgress} 读它。 */
    private static final class Download {
        final String path;
        volatile long bytes;
        /** 服务端声明的总量；-1 表示未知（无 Content-Range、无 Content-Length）。 */
        volatile long total = -1;
        /** 服务端忽略了 Range（回 200 整包），本地已从头重来。 */
        volatile boolean restarted;
        /** downloading | done | failed */
        volatile String state = "downloading";
        /** 失败原文（异常类名 + message），JS 侧据它分档。 */
        volatile String error;
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        volatile Thread thread;

        Download(String path) {
            this.path = path;
        }
    }

    private File cacheFile(String name) {
        return new File(getContext().getCacheDir(), name);
    }

    /**
     * 路径闸：只允许本插件自己在 {@code cacheDir} 下建的 {@code import-*} 文件。
     * 用 canonicalPath 比对，挡住 {@code ../} 之类的构造。
     */
    private File tempFile(String path) throws Exception {
        if (path == null || path.isEmpty()) {
            throw new Exception("INVALID_PATH");
        }
        File file = new File(path);
        String canonical = file.getCanonicalPath();
        String cacheRoot = getContext().getCacheDir().getCanonicalPath() + File.separator;
        if (!canonical.startsWith(cacheRoot) || !file.getName().startsWith(TEMP_PREFIX)) {
            throw new Exception("INVALID_PATH");
        }
        return file;
    }

    private static long number(PluginCall call, String field, long fallback) {
        Object raw = call.getData().opt(field);
        if (!(raw instanceof Number)) {
            return fallback;
        }
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value != Math.floor(value) || value < 0) {
            return fallback;
        }
        return ((Number) raw).longValue();
    }

    private static void putTotal(JSObject out, long total) {
        if (total >= 0) {
            out.put("total", total);
        }
    }

    /**
     * 开始一次流式下载。
     *
     * <p>建连与「声明总量 vs 上限」的判定在**本次调用的线程**里完成（要的就是「拒绝发生在
     * 落盘之前」，且要快），字节搬运交给后台线程（{@link #pump}），返回的 {@code state=downloading}
     * 表示后台已经在写。
     */
    @PluginMethod
    public void startDownload(PluginCall call) {
        if (active != null) {
            call.reject("已有导入下载正在进行", "BUSY");
            return;
        }
        final String url = call.getString("url", "");
        final long maxBytes = number(call, "maxBytes", 0);
        final long resumeFrom = number(call, "resumeFrom", 0);
        final long connectTimeout = Math.max(1, number(call, "connectTimeoutMs", 10000));
        final long readTimeout = Math.max(1, number(call, "readTimeoutMs", 60000));
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            JSObject out = new JSObject();
            out.put("state", "failed");
            out.put("error", "INVALID_URL");
            call.resolve(out);
            return;
        }
        if (maxBytes <= 0) {
            JSObject out = new JSObject();
            out.put("state", "failed");
            out.put("error", "INVALID_LIMIT");
            call.resolve(out);
            return;
        }
        File file;
        try {
            String requested = call.getString("path");
            file = requested == null ? cacheFile(TEMP_PREFIX + UUID.randomUUID() + ".part") : tempFile(requested);
        } catch (Exception error) {
            JSObject out = new JSObject();
            out.put("state", "failed");
            out.put("error", "INVALID_PATH");
            call.resolve(out);
            return;
        }

        Download download = new Download(file.getAbsolutePath());
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            download.connection = connection;
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout((int) Math.min(connectTimeout, Integer.MAX_VALUE));
            connection.setReadTimeout((int) Math.min(readTimeout, Integer.MAX_VALUE));
            // identity：不要透明解压，否则 Content-Length / 字节计数与包体对不上。
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Accept", "application/zip,application/octet-stream,*/*");
            if (resumeFrom > 0) {
                connection.setRequestProperty("Range", "bytes=" + resumeFrom + "-");
            }
            int status = connection.getResponseCode();

            // 416：请求区间越界 = 本地文件其实已经完整（重试时对端更严格的情况）。
            if (status == 416 && resumeFrom > 0) {
                connection.disconnect();
                JSObject out = new JSObject();
                out.put("state", "done");
                out.put("path", download.path);
                out.put("bytes", resumeFrom);
                out.put("total", resumeFrom);
                call.resolve(out);
                return;
            }
            if (status != 200 && status != 206) {
                String body = readErrorBody(connection);
                connection.disconnect();
                JSObject out = new JSObject();
                out.put("state", "http");
                out.put("status", status);
                out.put("body", body);
                call.resolve(out);
                return;
            }

            long declared = -1;
            if (status == 206) {
                declared = contentRangeTotal(connection.getHeaderField("Content-Range"));
            } else {
                declared = connection.getContentLengthLong();
            }
            // 关闭条件 3：声明总量一超上限就断开，一个字节都不写。
            if (declared >= 0 && declared > maxBytes) {
                connection.disconnect();
                if (file.exists() && !file.delete()) {
                    // 删不掉也不该把「超限」这条主结论弄丢：JS 侧失败分支还会再删一次。
                }
                JSObject out = new JSObject();
                out.put("state", "tooLarge");
                out.put("declared", declared);
                call.resolve(out);
                return;
            }

            if (status == 200 && resumeFrom > 0) {
                // 服务端忽略 Range，直接回整包：本地字节作废，必须从头写，别拼出两截。
                download.restarted = true;
            } else {
                download.bytes = resumeFrom;
            }
            if (declared >= 0) {
                // 整包 200 时 declared 就是总长；206 时是 Content-Range 的 total。
                download.total = declared;
            }
            if (download.restarted || resumeFrom <= 0) {
                try (FileOutputStream truncate = new FileOutputStream(file, false)) {
                    truncate.flush();
                }
            } else {
                try (RandomAccessFile random = new RandomAccessFile(file, "rw")) {
                    random.setLength(resumeFrom);
                }
            }

            final InputStream stream = connection.getInputStream();
            final FileOutputStream output = new FileOutputStream(file, true);
            active = download;
            Thread runner = new Thread(() -> pump(download, stream, output));
            runner.setDaemon(true);
            download.thread = runner;
            runner.start();

            JSObject out = new JSObject();
            out.put("state", "downloading");
            out.put("path", download.path);
            out.put("bytes", download.bytes);
            putTotal(out, download.total);
            out.put("restarted", download.restarted);
            call.resolve(out);
        } catch (Exception error) {
            if (connection != null) {
                connection.disconnect();
            }
            if (active == download) {
                active = null;
            }
            if (file.exists() && !file.delete()) {
                // 同上：失败分支 JS 会再删一次。
            }
            JSObject out = new JSObject();
            out.put("state", "failed");
            out.put("error", error.getClass().getName() + ": " + String.valueOf(error.getMessage()));
            call.resolve(out);
        }
    }

    /** 搬运线程：唯一的职责是把流写进文件并更新计数，任何终止原因都记进 {@code state}。 */
    private void pump(Download download, InputStream stream, FileOutputStream output) {
        boolean ok = false;
        try {
            byte[] buffer = new byte[BUFFER_BYTES];
            int count;
            while (!download.cancelled && (count = stream.read(buffer)) != -1) {
                output.write(buffer, 0, count);
                download.bytes += count;
            }
            output.flush();
            output.getFD().sync();
            if (download.cancelled) {
                download.state = "failed";
                download.error = "CANCELLED";
            } else if (download.total >= 0 && download.bytes != download.total) {
                // 声明了总长但没收到那么多：链路中途断了，绝不能让调用方当成完整包。
                download.state = "failed";
                download.error = "INCOMPLETE: got " + download.bytes + " of " + download.total;
            } else {
                download.state = "done";
                ok = true;
            }
        } catch (Exception error) {
            download.state = "failed";
            download.error = download.cancelled
                ? "CANCELLED"
                : error.getClass().getName() + ": " + String.valueOf(error.getMessage());
        } finally {
            try {
                output.close();
            } catch (IOException ignored) {
                // 已经失败，关不掉也没有更多可做的。
            }
            try {
                stream.close();
            } catch (IOException ignored) {
                // 同上。
            }
            if (download.connection != null) {
                download.connection.disconnect();
            }
            if (ok) {
                download.error = null;
            }
        }
    }

    /** 非 2xx 的错误体：只读前 4KB（OBS 的错误码就在里面），读不出来就回空串。 */
    private static String readErrorBody(HttpURLConnection connection) {
        try (InputStream stream = connection.getErrorStream()) {
            if (stream == null) {
                return "";
            }
            byte[] buffer = new byte[ERROR_BODY_BYTES];
            int total = 0;
            int count;
            while (total < buffer.length && (count = stream.read(buffer, total, buffer.length - total)) != -1) {
                total += count;
            }
            return new String(buffer, 0, total, "UTF-8");
        } catch (Exception error) {
            return "";
        }
    }

    private static long contentRangeTotal(String header) {
        if (header == null) {
            return -1;
        }
        Matcher match = CONTENT_RANGE_TOTAL.matcher(header);
        if (!match.find()) {
            return -1;
        }
        try {
            long value = Long.parseLong(match.group(1));
            return value > 0 ? value : -1;
        } catch (NumberFormatException notNumber) {
            return -1;
        }
    }

    /** JS 侧 500ms 轮询一次：只回计数与状态，不回任何字节。 */
    @PluginMethod
    public void getProgress(PluginCall call) {
        Download download = active;
        JSObject out = new JSObject();
        if (download == null) {
            out.put("state", "idle");
            out.put("bytes", 0);
            call.resolve(out);
            return;
        }
        out.put("state", download.state);
        out.put("bytes", download.bytes);
        putTotal(out, download.total);
        out.put("restarted", download.restarted);
        if (download.error != null) {
            out.put("error", download.error);
        }
        if (download.state.equals("done") || download.state.equals("failed")) {
            out.put("path", download.path);
        }
        call.resolve(out);
    }

    /**
     * 中止下载并（默认）删掉临时文件。返回前**同步删完**：关闭条件 4 的「立刻查残留」
     * 就是在 {@code abortDownload} 返回之后查的，不能留给后台线程慢慢删。
     */
    @PluginMethod
    public void abortDownload(PluginCall call) {
        boolean keep = Boolean.TRUE.equals(call.getBoolean("keep", false));
        Download download = active;
        if (download == null) {
            JSObject out = new JSObject();
            out.put("bytes", 0);
            out.put("kept", false);
            call.resolve(out);
            return;
        }
        download.cancelled = true;
        if (download.connection != null) {
            try {
                download.connection.disconnect();
            } catch (Exception ignored) {
                // disconnect 本身不抛，这里只是防御。
            }
        }
        Thread runner = download.thread;
        if (runner != null) {
            try {
                runner.join(2000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        active = null;
        boolean deleted = false;
        if (!keep) {
            File file = new File(download.path);
            if (file.exists()) {
                deleted = file.delete();
            }
        }
        JSObject out = new JSObject();
        out.put("bytes", download.bytes);
        out.put("kept", keep);
        out.put("deleted", deleted);
        call.resolve(out);
    }

    /** 按区间读临时文件：ZIP 中央目录、条目头、压缩块都走它。单次 ≤ 1MiB。 */
    @PluginMethod
    public void readFileRange(PluginCall call) {
        long offset = number(call, "offset", 0);
        long length = number(call, "length", 0);
        File file;
        try {
            file = tempFile(call.getString("path"));
        } catch (Exception error) {
            call.reject("临时文件路径无效", "INVALID_PATH");
            return;
        }
        if (offset < 0 || length <= 0 || length > MAX_RANGE_BYTES) {
            call.reject("读取区间无效", "INVALID_RANGE");
            return;
        }
        long size = file.length();
        if (offset + length > size) {
            call.reject("读取越界", "OUT_OF_RANGE");
            return;
        }
        byte[] buffer = new byte[(int) length];
        int total = 0;
        try (RandomAccessFile random = new RandomAccessFile(file, "r")) {
            random.seek(offset);
            while (total < buffer.length) {
                int count = random.read(buffer, total, buffer.length - total);
                if (count == -1) {
                    break;
                }
                total += count;
            }
        } catch (Exception error) {
            call.reject("读取临时文件失败", "READ_FAILED");
            return;
        }
        if (total != buffer.length) {
            call.reject("读取长度不足", "SHORT_READ");
            return;
        }
        JSObject out = new JSObject();
        out.put("data", Base64.encodeToString(buffer, Base64.NO_WRAP));
        call.resolve(out);
    }

    /** 临时文件大小（重试前确认本地已有多少字节 / 导入完成后的包体）。 */
    @PluginMethod
    public void statFile(PluginCall call) {
        try {
            File file = tempFile(call.getString("path"));
            JSObject out = new JSObject();
            out.put("size", file.exists() ? file.length() : -1);
            call.resolve(out);
        } catch (Exception error) {
            call.reject("临时文件路径无效", "INVALID_PATH");
        }
    }

    /** 删临时文件（成功导入后的清理 / 失败兜底）。只允许删本插件的 {@code import-*} 文件。 */
    @PluginMethod
    public void deleteFile(PluginCall call) {
        try {
            File file = tempFile(call.getString("path"));
            JSObject out = new JSObject();
            out.put("deleted", !file.exists() || file.delete());
            call.resolve(out);
        } catch (Exception error) {
            call.reject("临时文件路径无效", "INVALID_PATH");
        }
    }

    /** 插件销毁（Activity 重建 / 进程退出）：中止下载并删掉半截文件，别把几十 MB 留在缓存里。 */
    @Override
    protected void handleOnDestroy() {
        Download download = active;
        if (download != null) {
            download.cancelled = true;
            if (download.connection != null) {
                try {
                    download.connection.disconnect();
                } catch (Exception ignored) {
                    // 防御。
                }
            }
            Thread runner = download.thread;
            if (runner != null) {
                try {
                    runner.join(1000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            File file = new File(download.path);
            if (file.exists()) {
                file.delete();
            }
            active = null;
        }
        super.handleOnDestroy();
    }
}
