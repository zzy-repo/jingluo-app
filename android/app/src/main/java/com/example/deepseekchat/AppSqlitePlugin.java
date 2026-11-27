package com.example.deepseekchat;

import android.content.Context;
import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLite;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 应用私有目录里的强持久化 SQLite（#913）。基于 androidx.sqlite 的 bundled SQLite 3.50.1
 * （{@link BundledSQLiteDriver}，自带原生库，minSdk 23），不使用框架 {@code android.database.sqlite}：
 * 框架在 WAL 下会把写连接的 synchronous 强制成 NORMAL（且读连接池各自配置，无法逐条保证），
 * 而 bundled 驱动每次 {@code open} 都是一条独立连接、不改写 pragma，由我们自己配置并回读。
 *
 * <p>强约束（打开时配置，随后 {@code PRAGMA} 回读；任一不符就关闭并拒绝打开，不降级）：
 * {@code journal_mode=WAL}、{@code synchronous=FULL}、{@code foreign_keys=ON}、{@code busy_timeout>=5000}。
 * 每个库固定一条连接，串行执行：事务期间同库其它调用自然排队，不会跨连接死锁。
 *
 * <p>库文件落在 {@code getFilesDir()/storage-engine/<name>.db}（{@code name} 只允许 {@code [a-z0-9-]}，
 * 防路径注入）。该目录由 {@code res/xml/backup_rules.xml} 与 {@code res/xml/data_extraction_rules.xml}
 * 整体排除出云备份与设备迁移，避免库文件与状态文件在不同时间点被还原。
 *
 * <p>错误经 {@link SqliteFailure} 映射成 {@code kind} + {@code code} + {@code retryable}，随 reject 的
 * {@code data} 过桥（与 TS 侧 {@code SqlErrorShape} 一致）。不吞异常、不降级成内存库。
 */
@CapacitorPlugin(name = "AppSqlite")
public class AppSqlitePlugin extends Plugin {
    /** 私有目录下的根子目录：与 app-fs / cache 分开，且整体排除出备份。 */
    static final String ROOT_DIR = "storage-engine";
    /** 与 TS 侧一致：名字只允许小写字母、数字、连字符，且不能是空串。 */
    private static final java.util.regex.Pattern NAME = java.util.regex.Pattern.compile("[a-z0-9-]+");
    private static final int BUSY_TIMEOUT_MS = 5000;
    /** 默认事务超时：JS 回调失联时原生自动回滚，避免写事务永久占住连接。 */
    private static final long DEFAULT_TX_TIMEOUT_MS = 30_000L;
    /** 单次 {@code all} 的结果上限：超过即报错，绝不静默截断。512KiB 分块 + 元数据远低于此。 */
    static final int MAX_RESULT_BYTES = 4 * 1024 * 1024;
    /** JS 安全整数上限：超出的整数无法无损过桥，直接拒绝。 */
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;

    /** 本插件对外提供的方法清单；与 TS 侧 {@code REQUIRED_METHODS} 对应，新增方法时两边同步。 */
    private static final String[] METHODS = {
        "open", "run", "all", "batch", "txBegin", "txRun", "txAll", "txCommit", "txRollback",
        "backupTo", "integrityCheck", "info", "close", "ping"
    };

    private final ExecutorService io = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "app-sqlite");
        thread.setDaemon(true);
        return thread;
    });
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "app-sqlite-timer");
        thread.setDaemon(true);
        return thread;
    });

    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private final Map<String, Transaction> transactions = new ConcurrentHashMap<>();
    private int nextHandle = 1;

    private static final class Connection {
        final String name;
        final String path;
        final SQLiteConnection raw;
        /** 该库的全部调用都在这条队列上串行：事务期间其它调用自然排队。 */
        final ExecutorService queue = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "app-sqlite-conn");
            thread.setDaemon(true);
            return thread;
        });
        volatile Transaction transaction;

        Connection(String name, String path, SQLiteConnection raw) {
            this.name = name;
            this.path = path;
            this.raw = raw;
        }
    }

    private static final class Transaction {
        final String token;
        final Connection connection;
        final long deadlineMs;
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile ScheduledFuture<?> timeout;

        Transaction(String token, Connection connection, long timeoutMs) {
            this.token = token;
            this.connection = connection;
            this.deadlineMs = System.currentTimeMillis() + timeoutMs;
        }
    }

    private File root() {
        return new File(getContext().getFilesDir(), ROOT_DIR);
    }

    /** 名字校验失败抛 SqliteFailure（UNAVAILABLE）：非法名字是调用方 bug，但不能让它变成路径注入。 */
    private File databaseFile(String name) throws SqliteFailure {
        if (name == null || !NAME.matcher(name).matches()) {
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "illegal database name");
        }
        return new File(root(), name + ".db");
    }

    /**
     * 备份目标：相对 {@code storage-engine/} 的路径。绝对路径、反斜杠、NUL、空段、{@code ..} 一律拒绝，
     * 且 canonical 之后必须仍在根目录内（防符号链接绕过）。
     */
    private File resolveBackup(String relative) throws SqliteFailure {
        if (relative == null || relative.indexOf('\0') >= 0 || relative.indexOf('\\') >= 0
                || relative.startsWith("/") || relative.startsWith("file:")) {
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "illegal backup path");
        }
        String[] segments = relative.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "illegal backup path");
            }
        }
        File file = new File(root(), relative);
        try {
            String rootPath = root().getCanonicalPath();
            String filePath = file.getCanonicalPath();
            if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) {
                throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "backup path escapes root");
            }
        } catch (IOException error) {
            throw SqliteFailure.from(error);
        }
        return file;
    }

    /** 打开并配置一条连接；pragma 回读不符就关闭并抛错（拒绝打开，不降级）。 */
    private SQLiteConnection openRaw(File file) throws SqliteFailure {
        BundledSQLiteDriver driver = new BundledSQLiteDriver();
        SQLiteConnection raw;
        try {
            raw = driver.open(file.getAbsolutePath(), BundledSQLite.SQLITE_OPEN_READWRITE | BundledSQLite.SQLITE_OPEN_CREATE);
        } catch (Throwable error) {
            throw SqliteFailure.from(error);
        }
        try {
            exec(raw, "PRAGMA journal_mode=WAL");
            exec(raw, "PRAGMA synchronous=FULL");
            exec(raw, "PRAGMA foreign_keys=ON");
            exec(raw, "PRAGMA busy_timeout=" + BUSY_TIMEOUT_MS);
            // WAL 下的 synchronous 是持久库级设置，但读回必须发生在这条连接上：确认「我们这条」确实是 FULL。
            String journal = scalar(raw, "PRAGMA journal_mode");
            String synchronous = scalar(raw, "PRAGMA synchronous");
            String foreignKeys = scalar(raw, "PRAGMA foreign_keys");
            String busy = scalar(raw, "PRAGMA busy_timeout");
            long busyMs = busy == null ? -1 : Long.parseLong(busy);
            if (!"wal".equalsIgnoreCase(journal) || !"2".equals(synchronous) || !"1".equals(foreignKeys) || busyMs < BUSY_TIMEOUT_MS) {
                throw SqliteFailure.of(SqliteFailure.UNAVAILABLE,
                        "sqlite pragma readback rejected: journal_mode=" + journal
                                + " synchronous=" + synchronous + " foreign_keys=" + foreignKeys + " busy_timeout=" + busy);
            }
            return raw;
        } catch (Throwable error) {
            closeQuietly(raw);
            throw error instanceof SqliteFailure ? (SqliteFailure) error : SqliteFailure.from(error);
        }
    }

    private Connection connectionOf(String name) throws SqliteFailure {
        Connection connection = name == null ? null : connections.get(name);
        if (connection == null) {
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "database not open: " + name);
        }
        return connection;
    }

    private Transaction transactionOf(String token) throws SqliteFailure {
        Transaction transaction = token == null ? null : transactions.get(token);
        if (transaction == null || transaction.finished.get()) {
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "transaction not open");
        }
        if (System.currentTimeMillis() > transaction.deadlineMs) {
            // 超时回滚由定时器执行；这里只把「已经超时」如实报成不可用
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "transaction timed out");
        }
        return transaction;
    }

    /** 把一次调用派发到该库的串行队列上，结果回主线程 resolve/reject。 */
    private void dispatch(PluginCall call, String name, Work work) {
        Connection connection;
        try {
            connection = connectionOf(name);
        } catch (SqliteFailure error) {
            fail(call, error);
            return;
        }
        connection.queue.execute(() -> {
            try {
                JSObject result = work.run(connection);
                getActivity().runOnUiThread(() -> call.resolve(result == null ? new JSObject() : result));
            } catch (Throwable error) {
                SqliteFailure failure = SqliteFailure.from(error);
                getActivity().runOnUiThread(() -> fail(call, failure));
            }
        });
    }

    @FunctionalInterface
    private interface Work {
        JSObject run(Connection connection) throws Exception;
    }

    private void fail(PluginCall call, SqliteFailure error) {
        JSObject data = new JSObject();
        data.put("kind", error.kind);
        data.put("code", error.code);
        data.put("message", error.getMessage() == null ? "" : error.getMessage());
        data.put("retryable", error.retryable);
        if (error.index >= 0) {
            data.put("index", error.index);
        }
        call.reject(error.getMessage(), error.capacitorCode(), error, data);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String name = call.getString("name");
        io.execute(() -> {
            try {
                File file = databaseFile(name);
                File parent = file.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "cannot create storage-engine directory");
                }
                synchronized (connections) {
                    if (connections.containsKey(name)) {
                        throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "database already open: " + name);
                    }
                    SQLiteConnection raw = openRaw(file);
                    connections.put(name, new Connection(name, file.getAbsolutePath(), raw));
                }
                getActivity().runOnUiThread(call::resolve);
            } catch (Throwable error) {
                SqliteFailure failure = SqliteFailure.from(error);
                getActivity().runOnUiThread(() -> fail(call, failure));
            }
        });
    }

    @PluginMethod
    public void run(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            guardIdle(connection);
            return runOn(connection.raw, call.getString("sql"), call.getArray("params"));
        });
    }

    @PluginMethod
    public void all(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            guardIdle(connection);
            return queryOn(connection.raw, call.getString("sql"), call.getArray("params"));
        });
    }

    @PluginMethod
    public void batch(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            guardIdle(connection);
            JSONArray statements = call.getArray("statements");
            if (statements == null) {
                throw SqliteFailure.of(SqliteFailure.UNKNOWN, "batch requires statements");
            }
            // 原生内一个事务：全成或全回滚。BEGIN IMMEDIATE 立刻拿写锁，避免批中途升级锁失败。
            exec(connection.raw, "BEGIN IMMEDIATE");
            boolean committed = false;
            try {
                JSArray results = new JSArray();
                for (int index = 0; index < statements.length(); index += 1) {
                    JSONObject statement = statements.getJSONObject(index);
                    try {
                        results.put(runOn(connection.raw, statement.optString("sql", null),
                                statement.optJSONArray("params")));
                    } catch (Throwable error) {
                        throw SqliteFailure.from(error).withIndex(index);
                    }
                }
                exec(connection.raw, "COMMIT");
                committed = true;
                JSObject result = new JSObject();
                result.put("results", results);
                return result;
            } finally {
                if (!committed && connection.raw.inTransaction()) {
                    execQuietly(connection.raw, "ROLLBACK");
                }
            }
        });
    }

    @PluginMethod
    public void txBegin(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            guardIdle(connection);
            long timeoutMs = call.getData().has("txTimeoutMs")
                    ? call.getData().getLong("txTimeoutMs") : DEFAULT_TX_TIMEOUT_MS;
            if (timeoutMs <= 0) {
                throw SqliteFailure.of(SqliteFailure.UNKNOWN, "txTimeoutMs must be positive");
            }
            exec(connection.raw, "BEGIN IMMEDIATE");
            String token = "tx-" + (nextHandle++);
            Transaction transaction = new Transaction(token, connection, timeoutMs);
            connection.transaction = transaction;
            transactions.put(token, transaction);
            // 回调超时：到点在该库队列上 ROLLBACK（排队在在途语句之后，不会打断正在执行的语句）。
            transaction.timeout = timer.schedule(
                    () -> connection.queue.execute(() -> rollbackTimedOut(transaction)),
                    timeoutMs, TimeUnit.MILLISECONDS);
            JSObject result = new JSObject();
            result.put("token", token);
            return result;
        });
    }

    @PluginMethod
    public void txRun(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            Transaction transaction = transactionOf(call.getString("token"));
            requireSame(transaction, connection);
            return runOn(connection.raw, call.getString("sql"), call.getArray("params"));
        });
    }

    @PluginMethod
    public void txAll(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            Transaction transaction = transactionOf(call.getString("token"));
            requireSame(transaction, connection);
            return queryOn(connection.raw, call.getString("sql"), call.getArray("params"));
        });
    }

    @PluginMethod
    public void txCommit(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            Transaction transaction = transactionOf(call.getString("token"));
            requireSame(transaction, connection);
            finish(transaction, "COMMIT");
            return new JSObject();
        });
    }

    @PluginMethod
    public void txRollback(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            Transaction transaction = transactionOf(call.getString("token"));
            requireSame(transaction, connection);
            finish(transaction, "ROLLBACK");
            return new JSObject();
        });
    }

    /** 事务超时的收尾：只在该库队列上跑，且只对仍未结束的事务生效。 */
    private void rollbackTimedOut(Transaction transaction) {
        if (!transaction.finished.compareAndSet(false, true)) {
            return;
        }
        transactions.remove(transaction.token);
        transaction.connection.transaction = null;
        if (transaction.connection.raw.inTransaction()) {
            execQuietly(transaction.connection.raw, "ROLLBACK");
        }
    }

    private void finish(Transaction transaction, String statement) throws SqliteFailure {
        if (!transaction.finished.compareAndSet(false, true)) {
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "transaction already finished");
        }
        ScheduledFuture<?> timeout = transaction.timeout;
        if (timeout != null) {
            timeout.cancel(false);
        }
        transactions.remove(transaction.token);
        transaction.connection.transaction = null;
        try {
            exec(transaction.connection.raw, statement);
        } catch (Throwable error) {
            // 提交失败时事务仍开着：回滚，避免连接被一个半开事务占住
            if (transaction.connection.raw.inTransaction()) {
                execQuietly(transaction.connection.raw, "ROLLBACK");
            }
            throw SqliteFailure.from(error);
        }
    }

    private static void guardIdle(Connection connection) throws SqliteFailure {
        if (connection.transaction != null) {
            // 事务期间同连接的普通调用必须排队到事务之后；直接执行会死锁（连接正被事务占着）。
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "connection is inside a transaction");
        }
    }

    private static void requireSame(Transaction transaction, Connection connection) throws SqliteFailure {
        if (transaction.connection != connection) {
            throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "transaction belongs to another database");
        }
    }

    @PluginMethod
    public void backupTo(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            guardIdle(connection);
            File target = resolveBackup(call.getString("path"));
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw SqliteFailure.of(SqliteFailure.UNAVAILABLE, "cannot create backup directory");
            }
            // VACUUM INTO 产出一致性副本；目标已存在会失败（SQLITE_CONSTRAINT），不覆盖。
            String quoted = "'" + target.getAbsolutePath().replace("'", "''") + "'";
            exec(connection.raw, "VACUUM INTO " + quoted);
            JSObject result = new JSObject();
            result.put("bytes", target.length());
            return result;
        });
    }

    @PluginMethod
    public void integrityCheck(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            guardIdle(connection);
            JSArray problems = new JSArray();
            try (SQLiteStatement statement = connection.raw.prepare("PRAGMA integrity_check")) {
                while (statement.step()) {
                    String row = statement.isNull(0) ? "" : statement.getText(0);
                    if (!"ok".equalsIgnoreCase(row)) {
                        problems.put(row);
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("problems", problems);
            return result;
        });
    }

    @PluginMethod
    public void info(PluginCall call) {
        dispatch(call, call.getString("name"), connection -> {
            // info 允许在事务期间调用：只读 pragma，且走同一条队列，不会和事务并发。
            JSObject result = new JSObject();
            result.put("sqliteVersion", scalar(connection.raw, "SELECT sqlite_version()"));
            result.put("journalMode", scalar(connection.raw, "PRAGMA journal_mode"));
            result.put("synchronous", synchronousName(scalar(connection.raw, "PRAGMA synchronous")));
            result.put("foreignKeys", "1".equals(scalar(connection.raw, "PRAGMA foreign_keys")));
            result.put("busyTimeout", Long.parseLong(scalar(connection.raw, "PRAGMA busy_timeout")));
            result.put("path", connection.path);
            result.put("kind", "native-android");
            return result;
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        String name = call.getString("name");
        io.execute(() -> {
            Connection connection = connections.remove(name);
            if (connection == null) {
                getActivity().runOnUiThread(() -> fail(call, SqliteFailure.of(SqliteFailure.UNAVAILABLE, "database not open: " + name)));
                return;
            }
            // 先停队列再关连接：在途调用要么跑完、要么在关闭后失败，不会用到已关闭的连接。
            List<Runnable> dropped = new ArrayList<>();
            connection.queue.shutdownNow();
            Transaction transaction = connection.transaction;
            if (transaction != null) {
                transaction.finished.set(true);
                ScheduledFuture<?> timeout = transaction.timeout;
                if (timeout != null) {
                    timeout.cancel(false);
                }
                transactions.remove(transaction.token);
            }
            try {
                if (connection.raw.inTransaction()) {
                    execQuietly(connection.raw, "ROLLBACK");
                }
                connection.raw.close();
                getActivity().runOnUiThread(call::resolve);
            } catch (Throwable error) {
                SqliteFailure failure = SqliteFailure.from(error);
                getActivity().runOnUiThread(() -> fail(call, failure));
            }
            dropped.clear();
        });
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSArray methods = new JSArray();
        for (String method : METHODS) {
            methods.put(method);
        }
        JSObject result = new JSObject();
        result.put("methods", methods);
        call.resolve(result);
    }

    /** 轻量运行时探针：原生库能加载、私有目录可建、能打开并配置一个临时库再删掉。 */
    @PluginMethod
    public void ping(PluginCall call) {
        io.execute(() -> {
            File dir = root();
            if (!dir.isDirectory() && !dir.mkdirs()) {
                getActivity().runOnUiThread(() -> fail(call, SqliteFailure.of(SqliteFailure.UNAVAILABLE, "cannot create storage-engine directory")));
                return;
            }
            File probe = new File(dir, "ping-" + System.nanoTime() + ".db");
            SQLiteConnection raw = null;
            try {
                raw = openRaw(probe);
                getActivity().runOnUiThread(call::resolve);
            } catch (Throwable error) {
                SqliteFailure failure = SqliteFailure.from(error);
                getActivity().runOnUiThread(() -> fail(call, failure));
            } finally {
                closeQuietly(raw);
                deleteDatabaseFiles(probe);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (Transaction transaction : transactions.values()) {
            transaction.finished.set(true);
            ScheduledFuture<?> timeout = transaction.timeout;
            if (timeout != null) {
                timeout.cancel(false);
            }
        }
        transactions.clear();
        for (Connection connection : connections.values()) {
            connection.queue.shutdownNow();
            closeQuietly(connection.raw);
        }
        connections.clear();
        io.shutdownNow();
        timer.shutdownNow();
    }

    // ---------------------------------------------------------------- 语句执行与过桥编解码

    private static void exec(SQLiteConnection raw, String sql) {
        androidx.sqlite.SQLite.execSQL(raw, sql);
    }

    private static void execQuietly(SQLiteConnection raw, String sql) {
        try {
            exec(raw, sql);
        } catch (RuntimeException ignored) {
            // 回滚本身失败时没有更好的办法：连接随后会被关闭或下一次调用报错
        }
    }

    private static String scalar(SQLiteConnection raw, String sql) {
        try (SQLiteStatement statement = raw.prepare(sql)) {
            if (!statement.step() || statement.isNull(0)) {
                return null;
            }
            return statement.getColumnType(0) == androidx.sqlite.SQLite.SQLITE_DATA_INTEGER
                    ? Long.toString(statement.getLong(0)) : statement.getText(0);
        }
    }

    /** 执行一条写语句，返回受影响行数（无结果集的语句 changes 为 0）。 */
    private static JSObject runOn(SQLiteConnection raw, String sql, JSONArray params) throws Exception {
        if (sql == null || sql.trim().isEmpty()) {
            throw SqliteFailure.of(SqliteFailure.UNKNOWN, "sql is empty");
        }
        try (SQLiteStatement statement = raw.prepare(sql)) {
            bind(statement, params);
            while (statement.step()) {
                // run 不收集结果行，但要把语句跑完（例如 RETURNING）
            }
        }
        long changes = 0;
        try (SQLiteStatement statement = raw.prepare("SELECT changes()")) {
            if (statement.step()) {
                changes = statement.getLong(0);
            }
        }
        JSObject result = new JSObject();
        result.put("changes", changes);
        return result;
    }

    /** 执行一条查询，结果按列名编码成行数组；超过 {@link #MAX_RESULT_BYTES} 直接报错，不截断。 */
    private static JSObject queryOn(SQLiteConnection raw, String sql, JSONArray params) throws Exception {
        if (sql == null || sql.trim().isEmpty()) {
            throw SqliteFailure.of(SqliteFailure.UNKNOWN, "sql is empty");
        }
        JSArray rows = new JSArray();
        int bytes = 2;
        try (SQLiteStatement statement = raw.prepare(sql)) {
            bind(statement, params);
            int columns = statement.getColumnCount();
            while (statement.step()) {
                JSObject row = new JSObject();
                for (int column = 0; column < columns; column += 1) {
                    Encoded value = encode(statement, column);
                    row.put(statement.getColumnName(column), value.json);
                    bytes += value.bytes + statement.getColumnName(column).length();
                }
                rows.put(row);
                bytes += 2;
                if (bytes > MAX_RESULT_BYTES) {
                    throw SqliteFailure.of(SqliteFailure.UNKNOWN,
                            "result exceeds " + MAX_RESULT_BYTES + " bytes; refusing to truncate");
                }
            }
        }
        JSObject result = new JSObject();
        result.put("rows", rows);
        return result;
    }

    /** 过桥后的一个值：放进 JSON 的形态，以及它占用的字节估算（用于结果上限）。 */
    private static final class Encoded {
        final Object json;
        final int bytes;

        Encoded(Object json, int bytes) {
            this.json = json;
            this.bytes = bytes;
        }
    }

    private static Encoded encode(SQLiteStatement statement, int column) throws SqliteFailure {
        if (statement.isNull(column)) {
            return new Encoded(JSONObject.NULL, 4);
        }
        switch (statement.getColumnType(column)) {
            case androidx.sqlite.SQLite.SQLITE_DATA_INTEGER: {
                long value = statement.getLong(column);
                if (value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER) {
                    throw SqliteFailure.of(SqliteFailure.UNKNOWN,
                            "integer " + value + " exceeds the 2^53 safe range and cannot cross the bridge");
                }
                return new Encoded(value, 20);
            }
            case androidx.sqlite.SQLite.SQLITE_DATA_FLOAT:
                return new Encoded(statement.getDouble(column), 24);
            case androidx.sqlite.SQLite.SQLITE_DATA_BLOB: {
                byte[] blob = statement.getBlob(column);
                JSObject wrapped = new JSObject();
                wrapped.put("$b64", android.util.Base64.encodeToString(blob, android.util.Base64.NO_WRAP));
                return new Encoded(wrapped, blob.length);
            }
            default: {
                String text = statement.getText(column);
                return new Encoded(text, text == null ? 4 : text.length());
            }
        }
    }

    /** 绑定参数：null / number / string 原样；{@code {"$b64":"..."}} 还原成 BLOB。整数按 long 绑定（不丢精度）。 */
    private static void bind(SQLiteStatement statement, JSONArray params) throws Exception {
        if (params == null) {
            return;
        }
        for (int index = 0; index < params.length(); index += 1) {
            int position = index + 1;
            Object value = params.isNull(index) ? null : params.get(index);
            if (value == null) {
                statement.bindNull(position);
            } else if (value instanceof Integer || value instanceof Long || value instanceof Short) {
                statement.bindLong(position, ((Number) value).longValue());
            } else if (value instanceof Number) {
                double number = ((Number) value).doubleValue();
                if (Double.isFinite(number) && number == Math.rint(number) && Math.abs(number) <= MAX_SAFE_INTEGER) {
                    statement.bindLong(position, (long) number);
                } else {
                    statement.bindDouble(position, number);
                }
            } else if (value instanceof String) {
                statement.bindText(position, (String) value);
            } else if (value instanceof JSONObject && ((JSONObject) value).has("$b64")) {
                String encoded = ((JSONObject) value).getString("$b64");
                try {
                    statement.bindBlob(position, android.util.Base64.decode(encoded, android.util.Base64.DEFAULT));
                } catch (IllegalArgumentException error) {
                    throw SqliteFailure.of(SqliteFailure.UNKNOWN, "bad base64 blob parameter");
                }
            } else {
                throw SqliteFailure.of(SqliteFailure.UNKNOWN, "unsupported parameter type at index " + index);
            }
        }
    }

    /** PRAGMA synchronous 的数字回读 → 名字（0 OFF / 1 NORMAL / 2 FULL / 3 EXTRA）。 */
    private static String synchronousName(String raw) {
        switch (raw == null ? "" : raw) {
            case "0": return "OFF";
            case "1": return "NORMAL";
            case "2": return "FULL";
            case "3": return "EXTRA";
            default: return raw == null ? "" : raw;
        }
    }

    private static void closeQuietly(SQLiteConnection raw) {
        if (raw != null) {
            try {
                raw.close();
            } catch (RuntimeException ignored) {
                // 关闭失败不影响调用方：连接已经从注册表移除
            }
        }
    }

    /** 删掉一个库的主文件与 WAL 侧车文件（ping 的临时库用）。 */
    private static void deleteDatabaseFiles(File file) {
        new File(file.getPath() + "-wal").delete();
        new File(file.getPath() + "-shm").delete();
        file.delete();
    }
}
