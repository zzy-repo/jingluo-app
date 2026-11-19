package com.example.deepseekchat;

import java.net.URL;

/**
 * 自动更新分发端点策略（Issue #268）。纯 JVM 类：不碰 {@code android.*}，可直接单测。
 *
 * <p>顺序是写死的：先新分发机（裸 HTTP，无域名无 TLS），不可达才回退旧机（HTTPS）。
 * 不做随机、不做轮询、不从远端读配置——{@link #MANIFEST_BASES} 就是唯一事实来源，
 * {@link AppUpdatePlugin} 的清单地址与下载白名单都从它派生，避免「只改一处」把更新改废。
 *
 * <p>为什么允许裸 http（只有新机这一个主机）：明文信道后面还有两道强制校验——
 * Android 安装器对 APK 签名的校验，以及 {@link AppUpdatePlugin#verify} 里对包名、
 * versionCode、SHA-256、以及「与已安装包同一签名」的比对。中间人改写明文只能让更新
 * 失败或被抑制（下载不完整 / 哈希不符 / 签名不符），装不进伪造包。域名 + TLS 作为
 * 后续项在 #269 做，届时把 {@link #PRIMARY_BASE} 换成 https 域名即可，规则不用改。
 */
final class UpdateEndpoint {
    /** 首选：新静态分发机（{@code /var/www/dl} 上的 releases.json + apk/），裸 HTTP。 */
    static final String PRIMARY_BASE = "http://62.106.70.167:8888";
    /** 回退：旧分发机，保留到 #269 迁完 TLS。 */
    static final String FALLBACK_BASE = "https://dl.rose7.cn";
    /** 清单尝试顺序：先新后旧，写死。 */
    static final String[] MANIFEST_BASES = {PRIMARY_BASE, FALLBACK_BASE};

    private static final String PRIMARY_HOST = "62.106.70.167";
    private static final String FALLBACK_HOST = "dl.rose7.cn";
    private static final String APK_PATH = "/apk/[a-zA-Z0-9._-]+\\.apk";

    private UpdateEndpoint() {}

    static String manifestUrl(String base) {
        return base + "/releases.json";
    }

    /**
     * 下载地址白名单：https 放行任一白名单主机（新旧都行）；裸 http 只放行新分发机这一台。
     * 只接受 {@code /apk/<file>.apk} 这一种公开路径，不接受任何凭据、查询串、片段。
     */
    static boolean allowsDownloadUrl(URL url) {
        if (url == null) return false;
        if (url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) return false;
        String path = url.getPath();
        if (path == null || !path.matches(APK_PATH)) return false;
        String scheme = url.getProtocol(), host = url.getHost();
        int port = url.getPort();
        if ("https".equals(scheme)) {
            if (FALLBACK_HOST.equals(host)) return port == -1 || port == 443;
            if (PRIMARY_HOST.equals(host)) return port == -1 || port == 443 || port == 8888;
            return false;
        }
        // 裸 http：只认新分发机的 8888。旧机永远走 https，第三方主机一律拒绝。
        if ("http".equals(scheme)) return PRIMARY_HOST.equals(host) && port == 8888;
        return false;
    }
}
