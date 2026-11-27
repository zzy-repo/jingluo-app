# FileSystem 原生实现：真机 / 模拟器验收清单（#907）

**状态：本期未执行。** Node 契约测试（`tests/unit/fs-contract-memory.test.mjs`）只覆盖 `memoryFs`；
`AppFileSystemPlugin.java` 与 `src/services/fs/native/nativeFs.ts` 在 Android 上的行为全部待验。
本期对 Java 只做过 `javac` 语法与类型检查（对 capacitor-android classes.jar 与 android-36 android.jar），没有 gradle 构建、没有运行。

存放位置：`getFilesDir()/app-fs/`（应用私有，卸载即清除）。执行时每条记录：设备型号、Android 版本、结果、证据（logcat / `adb shell run-as` 输出）。
模拟器串行执行（内存有限）。下面的 `<pkg>` 是应用包名；调用方式：在调试包 WebView 里通过 `chrome://inspect` 控制台调用 `getFs()`，或临时测试页。

| # | 项目 | 步骤 | 期望 | 结果 |
|---|------|------|------|------|
| 1 | 探测 | 冷启动后 `getFs().supported` | `true`；首次 I/O 前 `capabilities()` 含 6 个方法，`ping` 通过 | 未执行 |
| 2 | 写入往返 | 在子目录下写一个文本文件再 readText | 读回内容一致；`run-as <pkg> ls files/app-fs` 里该子目录只有一个文件 | 未执行 |
| 3 | 二进制 / 大文件 | 写 5MB 随机字节 → `read` | 逐字节一致；耗时与内存无 OOM（WebView 不崩） | 未执行 |
| 4 | 覆盖 | 同路径写两次，第二次更短 | 读回第二次内容，无旧内容尾巴 | 未执行 |
| 5 | 不存在 / list / remove | `read` 不存在 → `undefined`；`list('nope')` → `[]`；`remove` 不存在不抛；`remove` 目录递归 | 全部符合 | 未执行 |
| 6 | 路径拒绝 | `../x`、`/abs`、`a//b`、空串、`a\b` | TS 侧抛 `FsPathError`；绕过 TS 直接调桥时 Java 侧 reject `UNAVAILABLE` | 未执行 |
| 7 | 原子：写入中途杀进程 | 写 50MB 到已有文件，写入进行中 `adb shell am force-stop <pkg>`；重启后 `read` | 内容要么完整旧、要么完整新，**不能是半截**；`app-fs` 下可能残留 `*.fstmp`，`list` 不返回它 | 未执行 |
| 8 | 原子：fsync 与 rename | 代码审阅 + 步骤 7 | 临时文件在同目录；`getFD().sync()` 先于 `renameTo` | 未执行 |
| 9 | ENOSPC 造法 | 模拟器：`adb shell` 用 `dd if=/dev/zero of=/data/local/tmp/fill bs=1M` 填满 `/data` 到只剩 <1MB（或用小容量 AVD）；写 5MB | `FsError.kind === 'quota'`；旧文件内容完好；`app-fs` 无新增残留；测完删除 fill 文件 | 未执行 |
| 10 | 其他 I/O 失败 | `adb shell run-as <pkg> chmod 000 files/app-fs` 后写 | 预期 `unavailable`（ping 失败）；恢复权限后同一进程内无需重启即可再次成功（runtime-failed 不缓存） | 未执行 |
| 11 | freeBytes | 读 `freeBytes()`，与 `adb shell df /data` 的可用量对照；写 10MB 后再读 | 与 df 同量级（误差在块大小内）；写入后减少约 10MB | 未执行 |
| 12 | 重启后可读 | 写入 → `force-stop` → 冷启动 → `read` | 内容一致；`modifiedAt` 不变 | 未执行 |
| 13 | 非 Android | 浏览器 / iOS 壳 | `supported=false`，I/O 抛 `kind:'unsupported'`，没有任何数据落到 localStorage / IndexedDB / 内存 | 浏览器侧由 `fs-select.test.mjs` 以 Capacitor 替身覆盖；真实浏览器、iOS 未执行 |
