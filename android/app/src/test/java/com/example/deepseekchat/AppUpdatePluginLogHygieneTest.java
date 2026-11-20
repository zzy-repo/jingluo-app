package com.example.deepseekchat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * 源码级契约（Issue #639）：**令牌不得进日志**，请求头只能按白名单写进连接。
 *
 * <p>为什么是「读源码」而不是「跑一次下载再看日志」：{@link AppUpdatePlugin} 继承 Capacitor 的
 * {@code Plugin}、要真 Activity 与真网络才跑得起来，JVM 单测里只能拿框架替身 —— 那样的断言
 * 覆盖不到「某天有人顺手在错误分支加一行 {@code Log.e(TAG, "token=" + token)}」。
 * 这段扫描只做一件很窄的事：**日志语句里不许出现令牌变量或头值表达式**。
 *
 * <p>分工（#639 验收表）：头白名单的行为面在 {@link UpdateEndpointTest}（真断言，能跑）；
 * 本文件只守「日志」这一格，两者不重叠。
 */
public class AppUpdatePluginLogHygieneTest {

    /** :app 单测的工作目录是模块根（android/app）。 */
    private static final Path SOURCE = Paths.get("src/main/java/com/example/deepseekchat/AppUpdatePlugin.java");

    private static String source() throws IOException {
        assertTrue("找不到被测源码：" + SOURCE.toAbsolutePath() + "（单测工作目录变了？）", Files.isRegularFile(SOURCE));
        return new String(Files.readAllBytes(SOURCE), StandardCharsets.UTF_8);
    }

    private static List<String> logLines(String source) {
        List<String> lines = new ArrayList<>();
        for (String line : source.split("\n")) {
            if (line.contains("Log.")) lines.add(line);
        }
        return lines;
    }

    /** 日志里不许出现令牌变量、也不许回显头值（值里可能就是令牌）。 */
    @Test
    public void neverLogsTokenOrHeaderValues() throws IOException {
        List<String> lines = logLines(source());
        // 白名单 warn 那几条必须在：否则「一条 Log 都没扫到」会让下面的循环空转成假绿
        assertFalse("源码里一条 Log 都没有：扫描条件已与实现漂移", lines.isEmpty());
        for (String line : lines) {
            String lower = line.toLowerCase();
            assertFalse("日志里出现令牌变量：" + line.trim(), lower.contains("token"));
            assertFalse("日志里回显了头值：" + line.trim(), lower.contains("optstring"));
            assertFalse("日志里回显了 Authorization：" + line.trim(), lower.contains("authorization"));
            assertFalse("日志里回显了 headers：" + line.trim(), lower.contains("headers.tostring"));
        }
    }

    /** 令牌只走 {@code setRequestProperty}，且只出现在私有清单那一次请求里。 */
    @Test
    public void tokenOnlyTravelsAsARequestHeader() throws IOException {
        String source = source();
        assertEquals("privateToken() 只该在私有清单请求处用一次", 1, occurrences(source, "UpdateEndpoint.privateToken()"));
        assertTrue(
                source.contains("fetchManifest(UpdateEndpoint.privateManifestUrl(), UpdateEndpoint.privateToken())"));
        // 不许把它拼进异常消息 / 日志 / JS 回传字段
        assertFalse(source.contains("\" + token"));
        assertFalse(source.contains("+ token)"));
        assertFalse(source.contains("result.put(\"token\""));
    }

    /** 头只按白名单设置：规范头名 + 形状校验，且必须写在请求发出之前。 */
    @Test
    public void headersAreWhitelistedAndAppliedBeforeSending() throws IOException {
        String source = source();
        assertTrue(source.contains("UpdateEndpoint.canonicalDownloadHeader("));
        assertTrue(source.contains("UpdateEndpoint.isSafeDownloadHeaderValue("));
        assertTrue(source.contains("connection.setRequestProperty(canonical"));
        // 负向：不许拿调用方给的原始头名 / 原始值直接落地
        assertFalse(source.contains("setRequestProperty(name"));
        assertFalse(source.contains("setRequestProperty(key"));
        int applied = source.indexOf("applyHeaders(call, connection);");
        int sent = source.indexOf("connection.getResponseCode() != 200", applied);
        assertTrue("请求头必须在 getResponseCode() 之前写入（否则等于没带）", applied > 0 && sent > applied);
    }

    private static int occurrences(String haystack, String needle) {
        int count = 0;
        int index = haystack.indexOf(needle);
        while (index >= 0) {
            count++;
            index = haystack.indexOf(needle, index + needle.length());
        }
        return count;
    }
}
