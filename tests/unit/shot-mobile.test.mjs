/**
 * [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
 *
 * 只测 scripts/shot-mobile.mjs 里的纯函数（参数解析、视口/场景规范化、截图命名）。
 * 真正截图要开浏览器，属于 UI 验收工具，不在单测里跑。
 */
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_VIEWPORTS,
  PAGES,
  parseArgs,
  resolvePages,
  resolveViewports,
  shotDir,
  shotFileName,
} from '../../scripts/shot-mobile.mjs'

describe('parseArgs', () => {
  it('什么都不给时全部走默认值', () => {
    const options = parseArgs([], {})
    assert.equal(options.pages, null)
    assert.equal(options.viewports, null)
    assert.equal(options.out, null)
    assert.equal(options.dist, null)
    assert.equal(options.port, null)
    assert.equal(options.list, false)
  })

  it('--page/--viewport 支持逗号分隔', () => {
    const options = parseArgs(['--page=header-scroll-top,reading-settings', '--viewport=390,360'], {})
    assert.deepEqual(options.pages, ['header-scroll-top', 'reading-settings'])
    assert.deepEqual(options.viewports, ['390', '360'])
  })

  it('--out/--dist/--port 透传，--list 与 --help 是开关', () => {
    const options = parseArgs(['--out=docs/ui/x', '--dist=build', '--port=5500', '--list'], {})
    assert.equal(options.out, 'docs/ui/x')
    assert.equal(options.dist, 'build')
    assert.equal(options.port, 5500)
    assert.equal(options.list, true)
    assert.equal(parseArgs(['-h'], {}).help, true)
  })

  it('环境变量兜底，命令行优先', () => {
    const env = {
      SHOT_PAGES: 'account-consume',
      SHOT_VIEWPORTS: '360',
      SHOT_OUT: 'docs/ui/env',
      SHOT_DIST_DIR: 'dist-env',
      SHOT_PORT: '5600',
    }
    const fromEnv = parseArgs([], env)
    assert.deepEqual(fromEnv.pages, ['account-consume'])
    assert.deepEqual(fromEnv.viewports, ['360'])
    assert.equal(fromEnv.out, 'docs/ui/env')
    assert.equal(fromEnv.dist, 'dist-env')
    assert.equal(fromEnv.port, 5600)

    const overridden = parseArgs(['--page=reading-settings', '--port=5700'], env)
    assert.deepEqual(overridden.pages, ['reading-settings'])
    assert.equal(overridden.port, 5700)
  })

  it('不认识的参数与非法端口直接报错，不静默忽略', () => {
    assert.throws(() => parseArgs(['--nope=1'], {}), /不认识的参数/u)
    assert.throws(() => parseArgs(['--page'], {}), /不认识的参数/u)
    assert.throws(() => parseArgs(['--port=99999'], {}), /--port/u)
    assert.throws(() => parseArgs(['--port=abc'], {}), /--port/u)
  })
})

describe('resolveViewports', () => {
  it('空值给出两档默认视口', () => {
    assert.deepEqual(resolveViewports(null), [...DEFAULT_VIEWPORTS])
    assert.deepEqual(resolveViewports([]), [...DEFAULT_VIEWPORTS])
    assert.deepEqual(DEFAULT_VIEWPORTS, ['390', '360'])
  })

  it('all / both 展开成两档', () => {
    assert.deepEqual(resolveViewports(['all']), ['390', '360'])
    assert.deepEqual(resolveViewports(['both']), ['390', '360'])
  })

  it('去重且保留顺序', () => {
    assert.deepEqual(resolveViewports(['360', '390', '360']), ['360', '390'])
  })

  it('不支持的档位报错并列出可选值', () => {
    assert.throws(() => resolveViewports(['414']), /不支持的视口档位：414/u)
  })
})

describe('resolvePages', () => {
  it('空值等于全部场景', () => {
    assert.deepEqual(resolvePages(null, PAGES), Object.keys(PAGES))
  })

  it('按给定顺序返回并去重', () => {
    assert.deepEqual(resolvePages(['account-consume', 'header-scroll-top', 'account-consume'], PAGES), [
      'account-consume',
      'header-scroll-top',
    ])
  })

  it('名字拼错要报错，不能静默截零张', () => {
    assert.throws(() => resolvePages(['header-scroll'], PAGES), /未注册的场景：header-scroll/u)
  })

  it('三个验收场景都在注册表里，且各自指向 docs/ui 目录', () => {
    for (const name of ['header-scroll-top', 'reading-settings', 'ours-buy-inapp']) {
      assert.ok(name in PAGES, `缺少场景 ${name}`)
      assert.match(PAGES[name].dir, /^docs\/ui\/\d{3}-/u)
      assert.equal(typeof PAGES[name].run, 'function')
    }
  })
})

describe('shotFileName / shotDir', () => {
  it('文件名是 <场景>-<状态>-<宽度>.png', () => {
    assert.equal(shotFileName({ page: 'reading-settings', state: '01-message-default', viewport: '390' }), 'reading-settings-01-message-default-390.png')
  })

  it('空片段、带路径分隔符或空白的片段都拒绝', () => {
    assert.throws(() => shotFileName({ page: '', state: 'x', viewport: '390' }), /不能为空/u)
    assert.throws(() => shotFileName({ page: 'a', state: 'b/c', viewport: '390' }), /不能带路径分隔符/u)
    assert.throws(() => shotFileName({ page: 'a', state: 'b c', viewport: '390' }), /不能带路径分隔符/u)
    assert.throws(() => shotFileName({ page: 'a', state: 'b', viewport: '414' }), /不支持的视口档位/u)
  })

  it('每档视口一个子目录', () => {
    assert.equal(shotDir('docs/ui/106-mobile-header-scroll-top', '360').replaceAll('\\', '/'), 'docs/ui/106-mobile-header-scroll-top/360')
  })
})
