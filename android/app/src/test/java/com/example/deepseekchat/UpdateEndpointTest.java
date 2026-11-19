package com.example.deepseekchat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.net.URL;
import org.junit.Test;

/**
 * {@link UpdateEndpoint} 的契约（Issue #268）：首选新分发机、回退旧机，两处地址成对生效。
 *
 * <p>纯 JVM 单测：不碰 android.*，不需要模拟器（{@code ./gradlew testDebugUnitTest}）。
 */
public class UpdateEndpointTest {

    private static boolean allows(String url) throws Exception {
        return UpdateEndpoint.allowsDownloadUrl(new URL(url));
    }

    /** 旧机（回退）只走 https。 */
    @Test
    public void allowsOldHostHttps() throws Exception {
        assertTrue(allows("https://dl.rose7.cn/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://dl.rose7.cn/apk/deepseek-chat-1.5.0.apk"));
    }

    /** 新机 https 也属于白名单（#269 上 TLS 后不用改规则）。 */
    @Test
    public void allowsNewHostHttps() throws Exception {
        assertTrue(allows("https://62.106.70.167/apk/deepseek-chat-1.5.0.apk"));
        assertTrue(allows("https://62.106.70.167:8888/apk/deepseek-chat-1.5.0.apk"));
    }

    /** 裸 http 只放行新机这一个主机，且必须是 8888。 */
    @Test
    public void allowsPlainHttpOnlyOnNewHost() throws Exception {
        assertTrue(allows(UpdateEndpoint.PRIMARY_BASE + "/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://62.106.70.167/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://62.106.70.167:80/apk/deepseek-chat-1.5.0.apk"));
        assertFalse(allows("http://dl.rose7.cn:8888/apk/deepseek-chat-1.5.0.apk"));
    }

    /** 任意第三方主机（含相似域名、邻位 IP、非 http(s) 协议）一律拒绝。 */
    @Test
    public void rejectsThirdPartyHosts() throws Exception {
        String[] rejected = {
            "https://evil.test/apk/a.apk",
            "http://evil.test/apk/a.apk",
            "http://62.106.70.168:8888/apk/a.apk",
            "https://dl.rose7.cn.evil.test/apk/a.apk",
            "https://evil.test/dl.rose7.cn/apk/a.apk",
            "ftp://62.106.70.167:8888/apk/a.apk",
            "http://user:pass@62.106.70.167:8888/apk/a.apk",
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

    /** 顺序写死：先新机后旧机，清单地址由 base 派生。 */
    @Test
    public void manifestBasesOrderIsFixed() {
        assertArrayEquals(new String[]{"http://62.106.70.167:8888", "https://dl.rose7.cn"}, UpdateEndpoint.MANIFEST_BASES);
        assertEquals("http://62.106.70.167:8888/releases.json", UpdateEndpoint.manifestUrl(UpdateEndpoint.PRIMARY_BASE));
        assertEquals("https://dl.rose7.cn/releases.json", UpdateEndpoint.manifestUrl(UpdateEndpoint.FALLBACK_BASE));
    }
}
