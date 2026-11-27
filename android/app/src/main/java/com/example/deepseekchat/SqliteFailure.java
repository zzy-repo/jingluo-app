package com.example.deepseekchat;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AppSqlite 的统一失败（#913）。携带与 TS 侧 {@code SqlErrorShape} 一致的 {@code kind} / {@code code}，
 * 以及「可重试」标记。{@link #from(Throwable)} 是错误映射的唯一一份：
 * <ul>
 *   <li>SQLITE_FULL（含异常文本里的 "disk is full / no space"）→ {@code quota}；</li>
 *   <li>SQLITE_CORRUPT / SQLITE_NOTADB → {@code unavailable} + 原始码；</li>
 *   <li>SQLITE_BUSY / SQLITE_LOCKED → {@code unavailable} + {@code retryable=true}；</li>
 *   <li>SQLITE_CONSTRAINT / SQLITE_IOERR 保留原始码，kind 为 {@code unknown}；其余 {@code unknown} + {@code OTHER}。</li>
 * </ul>
 * 不吞异常：原始异常作为 cause 保留，并随 {@code call.reject(..., ex, ...)} 进 logcat。
 */
final class SqliteFailure extends Exception {
    static final String QUOTA = "quota";
    static final String UNAVAILABLE = "unavailable";
    static final String UNKNOWN = "unknown";

    /**
     * 稳定码（#940）：「单次结果超出 {@link AppSqlitePlugin#MAX_RESULT_BYTES}」。
     * 它不是 SQLite 的错误码，是适配层自己的限制，但必须能被上层稳定分类，
     * 所以走 {@code code} 而不是 message 文本（用户可见文案由 TS 侧按 code 映射）。
     */
    static final String RESULT_TOO_LARGE = "RESULT_TOO_LARGE";

    /** androidx.sqlite 的异常文本："Error code: %d, message: %s" */
    private static final Pattern ERROR_CODE = Pattern.compile("Error code: (\\d+)");

    final String kind;
    final String code;
    final boolean retryable;
    /** 批里出错语句的下标；不适用时为 -1。 */
    final int index;

    SqliteFailure(String kind, String code, boolean retryable, String message, Throwable cause, int index) {
        super(message, cause);
        this.kind = kind;
        this.code = code;
        this.retryable = retryable;
        this.index = index;
    }

    static SqliteFailure of(String kind, String message) {
        return new SqliteFailure(kind, "OTHER", false, message, null, -1);
    }

    /**
     * 单次结果（或单行）超出 {@link #MAX_RESULT_BYTES}（#940）。
     * kind 仍是 {@code unknown}（既有口径不变），但 {@code code} 换成稳定码，
     * 上层据此分类，不再靠匹配 message 文案。
     */
    static SqliteFailure resultTooLarge() {
        return new SqliteFailure(UNKNOWN, RESULT_TOO_LARGE, false,
                "result exceeds " + AppSqlitePlugin.MAX_RESULT_BYTES
                        + " bytes; refusing to truncate (use limit/offset paging or read the column in chunks)",
                null, -1);
    }

    SqliteFailure withIndex(int statementIndex) {
        return new SqliteFailure(kind, code, retryable, getMessage(), getCause(), statementIndex);
    }

    /** Capacitor reject 的 {@code code}：与 TS 的 {@code infraKindOfRejection} 约定对齐（QUOTA / UNAVAILABLE），其余 UNKNOWN。 */
    String capacitorCode() {
        if (QUOTA.equals(kind)) {
            return "QUOTA";
        }
        if (UNAVAILABLE.equals(kind)) {
            return "UNAVAILABLE";
        }
        return "UNKNOWN";
    }

    static SqliteFailure from(Throwable error) {
        if (error instanceof SqliteFailure) {
            return (SqliteFailure) error;
        }
        String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        if (error instanceof LinkageError) {
            // 原生库没加载上（ABI 不支持 / so 缺失）：运行时不可用，不是「执行失败」
            return new SqliteFailure(UNAVAILABLE, "OTHER", false, "native sqlite library unavailable: " + message, error, -1);
        }
        Matcher matcher = ERROR_CODE.matcher(message);
        int primary = matcher.find() ? (Integer.parseInt(matcher.group(1)) & 0xFF) : -1;
        String lower = message.toLowerCase(Locale.ROOT);
        boolean noSpace = lower.contains("no space left") || lower.contains("disk is full");
        if (primary == 13 || noSpace) {
            return new SqliteFailure(QUOTA, "SQLITE_FULL", false, message, error, -1);
        }
        switch (primary) {
            case 11:
                return new SqliteFailure(UNAVAILABLE, "SQLITE_CORRUPT", false, message, error, -1);
            case 26:
                return new SqliteFailure(UNAVAILABLE, "SQLITE_NOTADB", false, message, error, -1);
            case 5:
                return new SqliteFailure(UNAVAILABLE, "SQLITE_BUSY", true, message, error, -1);
            case 6:
                return new SqliteFailure(UNAVAILABLE, "SQLITE_LOCKED", true, message, error, -1);
            case 19:
                return new SqliteFailure(UNKNOWN, "SQLITE_CONSTRAINT", false, message, error, -1);
            case 10:
                return new SqliteFailure(UNKNOWN, "SQLITE_IOERR", false, message, error, -1);
            default:
                return new SqliteFailure(UNKNOWN, "OTHER", false, message, error, -1);
        }
    }
}
