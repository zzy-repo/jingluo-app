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
 */
final class UpdateEndpoint {
    /** 首选分发机（config/endpoints.json → download.primaryBase）。 */
    static final String PRIMARY_BASE = BuildConfig.DL_PRIMARY;
    /** 回退分发机（config/endpoints.json → download.fallbackBase）。 */
    static final String FALLBACK_BASE = BuildConfig.DL_FALLBACK;
    /** 清单尝试顺序：先首选后回退，写死。 */
    static final String[] MANIFEST_BASES = {PRIMARY_BASE, FALLBACK_BASE};

    private static final String APK_PATH = "/apk/[a-zA-Z0-9._-]+\\.apk";

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

    private UpdateEndpoint() {}

    static String manifestUrl(String base) {
        return base + "/releases.json";
    }

    /**
     * 下载地址白名单：只接受 {@code /apk/<file>.apk} 这一种公开路径，不接受任何凭据、查询串、片段。
     *
     * <p>主机与端口来自 {@link #PRIMARY} / {@link #FALLBACK}（= 配置里的两个 base）。
     * https 允许「同一主机换 443」的 TLS 升级写法（把首选机换成 https 域名后规则不用改）；
     * 明文只放行首选机自己的协议与端口，回退机永远走 https。
     */
    static boolean allowsDownloadUrl(URL url) {
        if (url == null) return false;
        if (url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null) return false;
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
