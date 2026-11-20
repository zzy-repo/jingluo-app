package com.example.deepseekchat;

import java.net.MalformedURLException;
import java.net.URL;

/**
 * 自动更新分发端点策略（Issue #268 / #269）。纯 JVM 类：不碰 {@code android.*}，可直接单测。
 *
 * <p>地址不再写在本文件里：唯一来源是仓库根 {@code config/endpoints.json} 的
 * {@code download.primaryBase} / {@code download.fallbackBase}，由 {@code android/app/build.gradle}
 * 读成 {@code BuildConfig.DL_PRIMARY} / {@code BuildConfig.DL_FALLBACK}（可用
 * {@code -PdlPrimaryBase=...} 临时覆盖）。换分发机 = 改那份 JSON 一处 + 重打包。
 *
 * <p>下载白名单（{@link #allowsDownloadUrl}）<b>从这两个 base 派生</b>：主机、端口、协议全部从
 * base 解析出来，本类不再保留第二份主机字面量。以前白名单里另存了两个主机常量，和 base 是两份
 * 副本 —— 改 base 忘改白名单，新地址的下载会被判 {@code INVALID_URL}；反过来则是放行了不该
 * 放行的主机。谁也没法靠一条 grep 同时看住两处。
 *
 * <p>顺序写死：先首选机，不可达才回退。不做随机、不做轮询、不从远端读配置 ——
 * {@link #MANIFEST_BASES} 就是唯一事实来源，{@link AppUpdatePlugin} 的清单地址与下载白名单
 * 都从它派生。
 *
 * <p>为什么允许明文 http（只可能是首选机，且由配置决定）：明文信道后面还有两道强制校验 ——
 * Android 安装器对 APK 签名的校验，以及 {@link AppUpdatePlugin} 里对包名、versionCode、
 * SHA-256、以及「与已安装包同一签名」的比对。中间人改写明文只能让更新失败或被抑制
 * （下载不完整 / 哈希不符 / 签名不符），装不进伪造包。
 *
 * <p>私有分发（Issue #621 / #639）：内测包不在公网 webroot 里，只能从
 * {@code /api/v1/releases/internal/download?file=<名>.apk} 取，且要带令牌请求头。
 * 这一条路径同样归本类管：{@link #allowsPrivateDownload} 只放行 <b>https + 分发机主机 +
 * 这个固定路径 + 恰好一个裸文件名</b>，明文一律拒绝（令牌走请求头，明文信道等于把令牌交给
 * 中间人）。请求头本身的白名单也在本类（{@link #canonicalDownloadHeader}）：只允许
 * {@code X-DL-Token} / {@code Authorization}，其它头由调用方忽略。
 * 放在这里而不是插件里的原因与地址一样：本类是纯 JVM，规则能被单测钉住，插件类不能。
 */
final class UpdateEndpoint {
    /** 首选分发机（config/endpoints.json → download.primaryBase）。 */
    static final String PRIMARY_BASE = BuildConfig.DL_PRIMARY;
    /** 回退分发机（config/endpoints.json → download.fallbackBase）。 */
    static final String FALLBACK_BASE = BuildConfig.DL_FALLBACK;
    /** 清单尝试顺序：先首选后回退，写死。 */
    static final String[] MANIFEST_BASES = {PRIMARY_BASE, FALLBACK_BASE};

    private static final String APK_PATH = "/apk/[a-zA-Z0-9._-]+\\.apk";

    /** 私有清单端点（config/endpoints.json → update.privateManifest.url → BuildConfig；关闭时为空串）。 */
    static final String PRIVATE_MANIFEST_URL = BuildConfig.DL_PRIVATE_URL;

    /** 私有包下载路径（#621 的读端点，形状由服务端定；客户端只认这一个，不自己拼别的）。 */
    static final String PRIVATE_DOWNLOAD_PATH = "/api/v1/releases/internal/download";

    /** 私有令牌请求头：服务端也收 {@code Authorization: Bearer}，客户端只用这一枚。 */
    static final String HEADER_PRIVATE_TOKEN = "X-DL-Token";

    /**
     * 下载请求头白名单（#639）：只允许这两枚。下载器不是通用 HTTP 客户端 ——
     * 放行任意头等于给调用方开了一条「往本机发请求时带任意凭据」的通道。
     */
    static final String[] DOWNLOAD_HEADERS = {HEADER_PRIVATE_TOKEN, "Authorization"};

    /** 请求头值上限：令牌量级是 32~64 字节，4 KiB 已远超任何正当用途。 */
    static final int MAX_HEADER_VALUE_LENGTH = 4096;

    /** 私有清单端点里 {@code file} 参数只收裸文件名，绝不允许路径成分。 */
    private static final String PRIVATE_FILE_NAME = "[a-zA-Z0-9._-]+\\.apk";

    /** base 的解析结果。白名单只认协议 / 主机 / 端口三项，全部来自 base。 */
    private static final class Base {
        final boolean tls;
        final String host;
        final int port;

        Base(String base) {
            URL url;
            try {
                url = new URL(base);
            } catch (MalformedURLException error) {
                throw new IllegalArgumentException(
                        "分发地址不是合法 URL（config/endpoints.json 的 download.*）：" + base, error);
            }
            boolean https = "https".equals(url.getProtocol());
            if (!https && !"http".equals(url.getProtocol())) {
                throw new IllegalArgumentException("分发地址只支持 http/https：" + base);
            }
            String parsedHost = url.getHost();
            if (parsedHost == null || parsedHost.isEmpty()) {
                throw new IllegalArgumentException("分发地址缺少主机：" + base);
            }
            this.tls = https;
            this.host = parsedHost;
            this.port = url.getPort() != -1 ? url.getPort() : (https ? 443 : 80);
        }
    }

    private static final Base PRIMARY = new Base(PRIMARY_BASE);
    private static final Base FALLBACK = new Base(FALLBACK_BASE);
    /** 私有清单端点（未配置 / 非 https 时为 null = 私有这条路根本不存在）。 */
    private static final Base PRIVATE = privateBaseOf(PRIVATE_MANIFEST_URL);

    private UpdateEndpoint() {}

    private static Base privateBaseOf(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            Base base = new Base(url);
            // 令牌走请求头：明文信道等于把令牌交给中间人，配置成 http 就整条关掉（构建期也已拦过）
            return base.tls ? base : null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    static String manifestUrl(String base) {
        return base + "/releases.json";
    }

    /**
     * 私有清单端点（#621 / #639）。**只在构建期真的配好时才返回非空**：开关打开、端点是 https、
     * 令牌非空，三者同时成立 —— 否则调用方一个字节都不该发。
     */
    static String privateManifestUrl() {
        return privateManifestEnabled() ? PRIVATE_MANIFEST_URL : "";
    }

    /** 私有清单端点所在机器的 origin（私有包的相对 {@code file} 属于这台机器，别拼到公网机上）。 */
    static String privateManifestBase() {
        if (PRIVATE == null) return "";
        boolean defaultPort = PRIVATE.port == (PRIVATE.tls ? 443 : 80);
        return (PRIVATE.tls ? "https" : "http") + "://" + PRIVATE.host + (defaultPort ? "" : ":" + PRIVATE.port);
    }

    /**
     * 构建期开关（#639 §4）：standard 变体的 {@code DL_PRIVATE_ENABLED} / {@code DL_PRIVATE_TOKEN}
     * 都是空值，所以这里的判定天然把 standard 包挡在外面；{@code privateManifest.enabled=false}
     * 时同样为 false —— 「不发任何私有请求」是硬判据，不靠调用方自觉。
     */
    static boolean privateManifestEnabled() {
        return BuildConfig.DL_PRIVATE_ENABLED && PRIVATE != null && !privateToken().isEmpty();
    }

    /** 私有令牌原文：**只允许写进请求头**，任何日志 / 异常消息 / 回传 JS 的字段都不许带上它。 */
    static String privateToken() {
        String token = BuildConfig.DL_PRIVATE_TOKEN;
        return token == null ? "" : token.trim();
    }

    /**
     * 下载地址白名单。两种形状，别的一律拒绝：
     *
     * <ol>
     *   <li>公开包：{@code /apk/<file>.apk}，不带任何凭据 / 查询串 / 片段（#269 的规则，原样保留）；</li>
     *   <li>私有包（#639）：分发机主机 + {@code /api/v1/releases/internal/download?file=<名>.apk}，且**只走 https**。</li>
     * </ol>
     *
     * <p>主机与端口一律来自 {@link #PRIMARY} / {@link #FALLBACK}（= 配置里的两个 base），
     * 本类不留第二份主机字面量。公开路径的 https 允许「同一主机换 443」的 TLS 升级写法；
     * 明文只放行首选机自己的协议与端口，回退机永远走 https。
     */
    static boolean allowsDownloadUrl(URL url) {
        if (url == null) return false;
        if (url.getUserInfo() != null || url.getRef() != null) return false;
        return allowsPrivateDownload(url) || allowsPublicDownload(url);
    }

    /**
     * 私有下载端点（#639）：路径固定、查询串只允许恰好一个 {@code file=<裸文件名>}、必须 https。
     *
     * <p>为什么明文一律拒绝（连首选机的 http 也不放行）：公开包的明文有「APK 签名 + SHA-256 +
     * 版本比对」兜底，最坏结果是更新失败；私有包还要多带一枚令牌请求头，明文信道上它会被中间人
     * 直接读走 —— 那是泄密，不是「更新失败」。所以这条规则比公开路径更严。
     *
     * <p>主机仍只认两个分发机（{@link #PRIMARY} / {@link #FALLBACK}）：私有端点与公网清单同机
     * （同一台 dl 机器、同一个域名），不引入第三个主机。
     */
    private static boolean allowsPrivateDownload(URL url) {
        if (!"https".equals(url.getProtocol())) return false;
        if (!PRIVATE_DOWNLOAD_PATH.equals(url.getPath())) return false;
        String query = url.getQuery();
        if (query == null || !query.startsWith("file=")) return false;
        // 只允许恰好一个参数：`file=a.apk&x=1` / `file=a%2F..%2Fb.apk` 都会在这里被挡掉
        if (!query.substring("file=".length()).matches(PRIVATE_FILE_NAME)) return false;
        String host = url.getHost();
        int port = url.getPort() != -1 ? url.getPort() : 443;
        if (host.equals(PRIMARY.host)) return port == 443 || port == PRIMARY.port;
        if (host.equals(FALLBACK.host)) return port == 443 || port == FALLBACK.port;
        return false;
    }

    /**
     * 白名单头的规范写法（HTTP 头名大小写不敏感）；不在白名单里返回 {@code null}。
     *
     * <p>调用方拿到 {@code null} 时必须**忽略这个头并记一条 warn**（#639 的负向对照：
     * 传 {@code X-Evil: 1} 只能得到「被忽略」，绝不能真的写进请求）。
     */
    static String canonicalDownloadHeader(String name) {
        if (name == null) return null;
        String trimmed = name.trim();
        for (String allowed : DOWNLOAD_HEADERS) {
            if (allowed.equalsIgnoreCase(trimmed)) return allowed;
        }
        return null;
    }

    /** 头值能否安全写进请求：非空、不超长、不含控制字符（挡 CRLF 头注入）。 */
    static boolean isSafeDownloadHeaderValue(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_HEADER_VALUE_LENGTH) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) return false;
        }
        return true;
    }

    /** 公开包路径（#269 的规则，原样保留）：http(s) + /apk/<file>.apk，不带查询串 / 片段 / 凭据。 */
    private static boolean allowsPublicDownload(URL url) {
        if (url.getQuery() != null) return false;
        String path = url.getPath();
        if (path == null || !path.matches(APK_PATH)) return false;
        String scheme = url.getProtocol();
        String host = url.getHost();
        boolean https = "https".equals(scheme);
        int port = url.getPort() != -1 ? url.getPort() : (https ? 443 : 80);
        if (https) {
            if (host.equals(PRIMARY.host)) return port == 443 || port == PRIMARY.port;
            if (host.equals(FALLBACK.host)) return port == 443 || port == FALLBACK.port;
            return false;
        }
        if ("http".equals(scheme)) return !PRIMARY.tls && host.equals(PRIMARY.host) && port == PRIMARY.port;
        return false;
    }
}
