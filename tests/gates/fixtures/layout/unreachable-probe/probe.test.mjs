// 负向对照 fixture（Issue #369 / #393）——`check:test-layout` 的必错输入：**一个跑不到的用例**。
//
// 本文件被整体拷到 `tests/unit/__gate-neg-layout-probe/probe.test.mjs`（层级目录里的子目录），
// 于是同时违反两条硬规则：
//   · layer-placement：`run-layer.mjs` 用非递归 readdir，子目录里的用例 100% 跑不到；
//   · orphan：`tests/run-layer.mjs unit --list` 枚举不到它 —— 写了就等于没写。
// #393 是手工验的这条（造未登记测试文件 → exit 1），本文件把它固化成可重复的用例。
//
// 注意本目录在 `tests/gates/fixtures/` 下：`check-test-layout` 的 walkTests 会跳过 `fixtures/`，
// 所以它自己不会被判成孤儿；只有被拷进 tests/unit/ 的那一刻才是违规。
import { test } from 'node:test'

test('这条用例永远跑不到（它只是布局门禁的负向对照输入）', () => {})
