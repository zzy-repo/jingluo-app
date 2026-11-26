# Android 原生 SQLite 验收清单（#913）

真机与模拟器实验清单。本期只写标准，不跑验证（由 lead 在 #923 负责）。

## 功能覆盖

- [ ] **打开库**：私有目录 `storage-engine/<name>.db`，配置 WAL / synchronous=FULL / foreign_keys=ON / busy_timeout≥5000，回读确认
- [ ] **简单查询/写入**：run / all / batch 在单条连接上串行执行
- [ ] **交互式事务**：txBegin → txRun/txAll → txCommit/txRollback，回调超时自动 ROLLBACK
- [ ] **错误映射**：SQLITE_FULL → quota；SQLITE_CORRUPT/NOTADB → unavailable；SQLITE_BUSY/LOCKED → unavailable+retryable；其余 unknown
- [ ] **参数编解码**：null / number / string 透传；Uint8Array ↔ `{"$b64":"..."}`；整数超 2^53 拒绝
- [ ] **结果大小保护**：超 ~4MB 报错，不截断
- [ ] **备份一致性**：VACUUM INTO 产出不依赖活跃事务的副本，可在外部校验
- [ ] **完整性检查**：PRAGMA integrity_check，`ok` → 通过、否则返回问题清单
- [ ] **能力探测**：方法清单 + ping 确认原生库可用
- [ ] **关闭安全**：事务期间拒绝关闭；已打开的连接关闭不关 IO 线程本身

## 持久性与故障

- [ ] **WAL 文件存在**：打开库后 `storage-engine/<name>.db-wal` 文件出现（如果有活动事务）
- [ ] **synchronous=FULL 读回**：info() 返回 `synchronous: "FULL"`（非 NORMAL / OFF）
- [ ] **杀进程后事务回滚**：事务期间强杀进程，重新打开库，前述未提交写入丢失
- [ ] **磁盘满造法与恢复**：写入时耗尽磁盘空间，报 quota 错误；释放空间后库仍可用（no corruption）
- [ ] **大 BLOB 往返**：写入 ≥512KiB 的二进制数据（分块存储），读回字节一致、sha256 匹配
- [ ] **事务超时**：回调阻塞超过 txTimeoutMs，原生侧自动 ROLLBACK，JS 侧抛 unavailable

## 迁移与备份

- [ ] **还原后一致性**：云备份还原后（模拟器 `bmgr backupnow` + 恢复），storage-engine/ 被排除出还原范围，状态文件与库文件不会在不同时间点被复原

## 未验证事项（本期不跑）

- 真机验证（由 #923 负责）
- iOS（#914 单独处理）
- 超过 1GB 库的 checkpoint 性能（需真实数据集与 WAL 增长观察）
- 多进程并发访问（Android 应用通常单进程）
