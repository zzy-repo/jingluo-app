package com.example.deepseekchat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.net.URL;
import org.junit.Test;

/**
 * {@link UpdateEndpoint} 的契约（Issue #268 / #269）：首选新分发机、回退旧机，两处地址成对生效。
 *
 * <p><b>本文件不写配置里的地址</b>：base 一律取 {@code UpdateEndpoint.PRIMARY_BASE} /
 * {@code FALLBACK_BASE}（= {@code BuildConfig.DL_*} = {@code config/endpoints.json} 的
 * {@code download.*}），主机与端口由 base 解析。否则「换分发机只改一处」会被测试里的第二份
 * 字面量卡住 —— 那正是 #269 要消掉的失败模式。
 *
 * <p>Issue #639 新增两组规则，同样只从 BuildConfig / 常量取输入：私有下载端点
 * （{@code /api/v1/releases/internal/download}）的放行与拒绝，以及下载请求头的白名单。
 *
 * <p>纯 JVM 单测：不碰 android.*，不需要模拟器（{@code ./gradlew testReleaseUnitTest}）。
 */
public class UpdateEndpointTest {

    private static boolean allows(String url) throws Exception {
        return UpdateEndpoint.allowsDownloadUrl(new URL(url));
    }

    /** base 的协议 / 主机 / 端口（测试只从这里取，不从配置里抄第二份）。 */
    private static String schemeOf(String base) throws Exception {
        return new URL(base).getProtocol();
    }

    private static String hostOf(String base) throws Exception {
        return new URL(base).getHost();
    }

    private static int portOf(String base) throws Exception {
        URL url = new URL(base);
        if (url.getPort() != -1) return url.getPort();
        return "https".equals(url.getProtocol()) ? 443 : 80;
    }

    /** 回退机只走 https。 */
    @Test
    public void allowsFallbackHostHttps() throws Exception {
        String host = hostOf(UpdateEndpoint.FALLBACK_BASE);
        assertTrue(allows("https://" + host + "/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://" + host + "/apk/deepseek-chat-1.5.0.apk"));
    }

    /** 首选机 https 也属于白名单（上 TLS、或直接把首选机换成 https 域名时规则不用改）。 */
    @Test
    public void allowsPrimaryHostHttps() throws Exception {
        String host = hostOf(UpdateEndpoint.PRIMARY_BASE);
        assertTrue(allows("https://" + host + "/apk/deepseek-chat-1.5.0.apk"));
        assertTrue(allows(UpdateEndpoint.PRIMARY_BASE + "/apk/deepseek-chat-1.5.0.apk"));
        assertTrue(allows("https://" + host + ":" + portOf(UpdateEndpoint.PRIMARY_BASE) + "/apk/a.apk"));
    }

    /** 裸 http 只放行首选机这一台，且端口必须是首选机的端口（默认端口不放行）。 */
    @Test
    public void allowsPlainHttpOnlyOnPrimary() throws Exception {
        String host = hostOf(UpdateEndpoint.PRIMARY_BASE);
        int port = portOf(UpdateEndpoint.PRIMARY_BASE);
        assertTrue(allows(UpdateEndpoint.PRIMARY_BASE + "/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://" + host + "/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://" + host + ":80/apk/deepseek-chat-1.5.0.apk"));
        // 回退机即使开着首选机的端口也不许走明文
        if (port != 443) {
            assertFalse(allows("http://" + hostOf(UpdateEndpoint.FALLBACK_BASE) + ":" + port + "/apk/a.apk"));
        }
    }

    /** 任意第三方主机（含相似域名、路径里塞白名单主机、非 http(s) 协议）一律拒绝。 */
    @Test
    public void rejectsThirdPartyHosts() throws Exception {
        String primary = hostOf(UpdateEndpoint.PRIMARY_BASE);
        String fallback = hostOf(UpdateEndpoint.FALLBACK_BASE);
        String[] rejected = {
            "https://evil.test/apk/a.apk",
            "http://evil.test/apk/a.apk",
            "https://" + fallback + ".evil.test/apk/a.apk",
            "https://evil.test/" + fallback + "/apk/a.apk",
            "ftp://" + primary + ":" + portOf(UpdateEndpoint.PRIMARY_BASE) + "/apk/a.apk",
            "http://user:pass@" + primary + ":" + portOf(UpdateEndpoint.PRIMARY_BASE) + "/apk/a.apk",
        };
        for (String url : rejected) assertFalse(url, allows(url));
    }

    /** 只认 /apk/<file>.apk 这一种公开路径；查询串、片段、路径穿越一律拒绝。 */
    @Test
    public void rejectsNonPublicPaths() throws Exception {
        String[] rejected = {
            UpdateEndpoint.PRIMARY_BASE + "/releases.json",
            UpdateEndpoint.PRIMARY_BASE + "/apk/a.apk?token=x",
            UpdateEndpoint.PRIMARY_BASE + "/apk/a.apk#x",
            UpdateEndpoint.PRIMARY_BASE + "/apk/../a.apk",
            UpdateEndpoint.PRIMARY_BASE + "/apk/a.txt",
            UpdateEndpoint.PRIMARY_BASE + "/api/a.apk",
        };
        for (String url : rejected) assertFalse(url, allows(url));
    }

    /** 顺序写死：先首选后回退；清单地址由 base 派生；base 来自 BuildConfig（= config/endpoints.json）。 */
    @Test
    public void manifestBasesOrderIsFixed() {
        assertArrayEquals(
                new String[]{BuildConfig.DL_PRIMARY, BuildConfig.DL_FALLBACK}, UpdateEndpoint.MANIFEST_BASES);
        assertEquals(BuildConfig.DL_PRIMARY + "/releases.json", UpdateEndpoint.manifestUrl(UpdateEndpoint.PRIMARY_BASE));
        assertEquals(
                BuildConfig.DL_FALLBACK + "/releases.json", UpdateEndpoint.manifestUrl(UpdateEndpoint.FALLBACK_BASE));
    }

    /** 注入真的落地了：base 是绝对 http(s) URL、不带尾斜杠，且与派生白名单自洽。 */
    @Test
    public void configuredBasesAreWellFormed() throws Exception {
        for (String base : UpdateEndpoint.MANIFEST_BASES) {
            assertTrue(base, base.startsWith("http://") || base.startsWith("https://"));
            assertFalse(base, base.endsWith("/"));
            assertTrue(base, allows(base + "/apk/deepseek-chat-1.5.0.apk"));
        }
        // 回退机必须走 TLS：它是所有已发布版本的最后兜底
        assertEquals("https", schemeOf(UpdateEndpoint.FALLBACK_BASE));
        // 白名单跟着 base 走：base 之外的主机一律拒绝（换机只改配置，规则不用改）
        assertFalse(allows("https://evil.test/apk/a.apk"));
    }

    // -----------------------------------------------------------------------
    // Issue #639：私有下载端点（#621 的读端点）进白名单
    // -----------------------------------------------------------------------

    private static String privateUrl(String host, String query) {
        return "https://" + host + UpdateEndpoint.PRIVATE_DOWNLOAD_PATH + query;
    }

    /** 正向对照：https + 分发机主机 + 固定路径 + 恰好一个裸文件名 → 放行。 */
    @Test
    public void allowsPrivateDownloadUrl() throws Exception {
        assertTrue(allows(privateUrl(hostOf(UpdateEndpoint.FALLBACK_BASE), "?file=deepseek-chat-1.4.0-internal.apk")));
        assertTrue(allows(privateUrl(hostOf(UpdateEndpoint.PRIMARY_BASE), "?file=a.apk")));
        // 这条路径与公开路径是两条规则：私有 URL 带查询串仍然放行，公网 URL 带查询串仍然拒绝
        assertFalse(allows(UpdateEndpoint.FALLBACK_BASE + "/apk/a.apk?file=a.apk"));
    }

    /** 负向对照：明文 / 第三方主机 / 别的路径 / 多余参数 / 路径成分 / 凭据 / 片段，一律拒绝。 */
    @Test
    public void rejectsUnsafePrivateDownloadUrls() throws Exception {
        String fallback = hostOf(UpdateEndpoint.FALLBACK_BASE);
        String primary = hostOf(UpdateEndpoint.PRIMARY_BASE);
        String path = UpdateEndpoint.PRIVATE_DOWNLOAD_PATH;
        int wrongPort = portOf(UpdateEndpoint.PRIMARY_BASE) == 8443 ? 8444 : 8443;
        String[] rejected = {
            // 明文 = 令牌裸奔（公开路径允许首选机的 http，私有路径不允许任何明文）
            "http://" + fallback + path + "?file=a.apk",
            "http://" + primary + ":" + portOf(UpdateEndpoint.PRIMARY_BASE) + path + "?file=a.apk",
            // 第三方主机（含相似域名）
            "https://evil.test" + path + "?file=a.apk",
            "https://" + fallback + ".evil.test" + path + "?file=a.apk",
            // 主机对、端口不对
            "https://" + primary + ":" + wrongPort + path + "?file=a.apk",
            // 别的路径（清单端点不是下载端点；下载端点多一层 /internal 也不行）
            "https://" + fallback + "/api/v1/releases/internal?file=a.apk",
            "https://" + fallback + path + "/extra?file=a.apk",
            // 查询串形状
            "https://" + fallback + path,
            "https://" + fallback + path + "?file=",
            "https://" + fallback + path + "?file=a.apk&x=1",
            "https://" + fallback + path + "?name=a.apk",
            "https://" + fallback + path + "?file=%2E%2E%2Fa.apk",
            "https://" + fallback + path + "?file=sub%2Fa.apk",
            "https://" + fallback + path + "?file=a.txt",
            // 凭据与片段
            "https://user:pass@" + fallback + path + "?file=a.apk",
            "https://" + fallback + path + "?file=a.apk#x",
        };
        for (String url : rejected) assertFalse(url, allows(url));
    }

    // -----------------------------------------------------------------------
    // Issue #639：下载请求头白名单
    // -----------------------------------------------------------------------

    /** 只认两枚头（大小写不敏感，返回白名单里的规范写法）。 */
    @Test
    public void allowsOnlyWhitelistedDownloadHeaders() {
        assertEquals("X-DL-Token", UpdateEndpoint.canonicalDownloadHeader("X-DL-Token"));
        assertEquals("X-DL-Token", UpdateEndpoint.canonicalDownloadHeader("x-dl-token"));
        assertEquals("X-DL-Token", UpdateEndpoint.canonicalDownloadHeader("  X-DL-Token  "));
        assertEquals("X-DL-Token", UpdateEndpoint.canonicalDownloadHeader(UpdateEndpoint.HEADER_PRIVATE_TOKEN));
        assertEquals("Authorization", UpdateEndpoint.canonicalDownloadHeader("authorization"));
        assertEquals("Authorization", UpdateEndpoint.canonicalDownloadHeader("AUTHORIZATION"));
    }

    /** 负向对照（#639 验收）：{@code X-Evil: 1} 只能拿到 null —— 调用方据此忽略并 warn。 */
    @Test
    public void ignoresNonWhitelistedDownloadHeaders() {
        for (String name : new String[]{"X-Evil", "Accept", "Cookie", "X-DL-Token-Evil", "", "  ", "X-DL-Token "}) {
            String canonical = UpdateEndpoint.canonicalDownloadHeader(name);
            if (name.trim().equalsIgnoreCase("X-DL-Token")) {
                assertEquals("X-DL-Token", canonical);
            } else {
                assertNull("这个头不该被放行：" + name, canonical);
            }
        }
        assertNull(UpdateEndpoint.canonicalDownloadHeader(null));
    }

    /** 头值形状：非空、不超长、不含控制字符（挡 CRLF 头注入）。 */
    @Test
    public void rejectsUnsafeHeaderValues() {
        assertTrue(UpdateEndpoint.isSafeDownloadHeaderValue("tok-639-not-a-real-token"));
        assertTrue(UpdateEndpoint.isSafeDownloadHeaderValue("Bearer abc.def-ghi_jkl"));
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue(null));
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue(""));
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue("a\r\nX-Evil: 1"));
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue("a\nb"));
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue("a\rb"));
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue("a\u0000b"));
        StringBuilder tooLong = new StringBuilder();
        for (int index = 0; index <= UpdateEndpoint.MAX_HEADER_VALUE_LENGTH; index++) tooLong.append('a');
        assertFalse(UpdateEndpoint.isSafeDownloadHeaderValue(tooLong.toString()));
    }

    // -----------------------------------------------------------------------
    // Issue #639 §4：私有开关的构建期注入
    // -----------------------------------------------------------------------

    /**
     * 开关自洽：**关着就一个字节都不发**（{@link UpdateEndpoint#privateManifestUrl()} 返回空串）；
     * 开着则端点必须是 https、令牌非空、且端点主机属于两台分发机（否则原生下载白名单会拒）。
     */
    @Test
    public void privateManifestGatingIsConsistent() throws Exception {
        if (UpdateEndpoint.privateManifestEnabled()) {
            assertTrue(UpdateEndpoint.privateManifestUrl().startsWith("https://"));
            assertEquals(
                    UpdateEndpoint.privateManifestUrl().endsWith("/api/v1/releases/internal"),
                    true);
            assertFalse(UpdateEndpoint.privateToken().isEmpty());
            String host = new URL(UpdateEndpoint.privateManifestUrl()).getHost();
            assertTrue(
                    host,
                    host.equals(hostOf(UpdateEndpoint.PRIMARY_BASE)) || host.equals(hostOf(UpdateEndpoint.FALLBACK_BASE)));
        } else {
            assertEquals("", UpdateEndpoint.privateManifestUrl());
            assertTrue(
                    "关着 = 端点或令牌至少缺一项（standard 变体两项都为空）",
                    UpdateEndpoint.PRIVATE_MANIFEST_URL.isEmpty() || UpdateEndpoint.privateToken().isEmpty());
        }
    }
}
