package com.example.deepseekchat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
 * <p>纯 JVM 单测：不碰 android.*，不需要模拟器（{@code ./gradlew testDebugUnitTest}）。
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
}
