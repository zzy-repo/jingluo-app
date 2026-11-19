/**
 * 类别 4（行为 / 布局假设）判定模块 —— issue #209。
 *
 * 为什么单独一个模块：这一类假设（「窄屏按钮会换行」「弹窗内容超出会滚动」
 * 「触摸滑动会滚容器」「100vh 等于可视高度」）静态检测测不出来。CSS 里写没写
 * `flex-wrap`、写没写 `overflow-y:auto`，跟浏览器算出来的结果经常不是一回事
 * （`overflow-y:auto` 写了但被压成 0 高、`flex-wrap` 写了但父级不是 flex、
 * 触摸事件到齐而内容一像素不动 —— 见 #30）。唯一可信的证据是「设置之后读回实际值」。
 *
 * 所以本模块只做判定，不做采集：输入是 `docs/ui/209-behavior/measure.mjs`
 * 在真机模拟器上读回来的测量 JSON（原样，包含 clientWidth / clientHeight /
 * scrollHeight / scrollTop / getComputedStyle 关键值 / visualViewport），
 * 输出是逐条假设的结论与证据。
 *
 * 两个消费者：
 *   1. `scripts/check-capabilities.mjs`（另一个 lane 组装）—— 把测量结果翻成
 *      能力表里的「需探测 / 已有兜底」处置；
 *   2. `tests/unit/behavior-assumption-audit.test.mjs` —— 拿真实采集到的 JSON
 *      当固定输入，断言判定逻辑本身不会把「不成立」判成「成立」。
 *
 * 刻意不做的：不读 CSS 文本、不猜布局。判定用到的每个数字都必须来自测量 JSON。
 */

/** 触摸目标下限（Material / WCAG 2.5.5 取 44×44） */
const TOUCH_TARGET_MIN_PX = 44

/** 允许的视口高度误差：亚像素舍入不该被判成不成立 */
const VIEWPORT_TOLERANCE_PX = 1

/** 计算值落在这些关键字上才算「这个容器能滚」 */
const SCROLLABLE_OVERFLOW = /^(auto|scroll|overlay)$/u

/** 四条假设的名字，与 issue #209 的原文一致（表格与 PR 正文都按这个对齐） */
export const ASSUMPTIONS = {
  buttonWrap: '窄屏按钮会换行',
  dialogScroll: '弹窗内容超出会滚动',
  touchScroll: '触摸滑动会滚容器',
  viewportHeight: '100vh 等于可视高度',
}

export const VERDICT = {
  holds: '成立',
  falsified: '不成立',
  untested: '未测',
}

const round1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : n)

/**
 * 从测量 JSON 里捞出弹窗测量体。
 * measure.mjs 把「设置弹窗」放在 settingsDialog.probe，确认弹窗放在 confirmDialog；
 * 两者结构相同，所以这里统一成数组，谁有就判谁。
 */
const dialogSamples = (measurement) => {
  const out = []
  const settings = measurement?.settingsDialog?.probe
  if (settings) out.push({ where: 'settings', probe: settings, swipe: measurement.settingsDialog?.swipe })
  const confirm = measurement?.confirmDialog
  if (confirm) out.push({ where: 'confirm', probe: confirm, swipe: null })
  return out
}

/**
 * 假设 1「窄屏按钮会换行」。
 *
 * 验收口径（先定后测，不许事后找补）：
 *   窄屏下按钮行要么换行、要么放得下。因此判「不成立」的条件是三者之一成立：
 *     a) 某个按钮行的实际横向跨度 > 行容器可用宽度（`overflowPx > 0`）；
 *     b) 某个按钮文字被裁（`scrollWidth > clientWidth`）；
 *     c) 某个按钮被压到窄于 44px（触摸目标失效）。
 *   换行本身不是必须的 —— 一行放得下就是合格的兜底，但要把「离溢出还有多少」记下来，
 *   因为它决定了风险等级。
 */
export const judgeButtonWrap = (measurement) => {
  const rows = []
  for (const { where, probe } of dialogSamples(measurement)) {
    for (const row of probe?.buttonRows ?? []) {
      if ((row?.childCount ?? 0) < 2) continue
      rows.push({ where, ...row })
    }
  }
  if (rows.length === 0) {
    return {
      assumption: ASSUMPTIONS.buttonWrap,
      verdict: VERDICT.untested,
      evidence: { reason: '测量 JSON 里没有多按钮的行（弹窗未打开或该宽度下只有一个按钮）', rowCount: 0 },
    }
  }

  const overflowing = rows.filter((row) => (row.overflowPx ?? 0) > 0)
  const clipped = rows.filter((row) => row.anyTextClipped === true)
  const squashed = rows.filter((row) => (row.narrowest ?? Infinity) < TOUCH_TARGET_MIN_PX)

  // 最紧的一行：占掉可用宽度的比例最高
  const tightest = rows
    .map((row) => ({ ...row, used: row.available > 0 ? row.span / row.available : 0 }))
    .sort((a, b) => b.used - a.used)[0]

  const falsified = overflowing.length > 0 || clipped.length > 0 || squashed.length > 0
  return {
    assumption: ASSUMPTIONS.buttonWrap,
    verdict: falsified ? VERDICT.falsified : VERDICT.holds,
    evidence: {
      criterion: `按钮行横向跨度超过容器可用宽度、或文字被裁、或按钮窄于 ${TOUCH_TARGET_MIN_PX}px ⇒ 不成立`,
      rowCount: rows.length,
      wrappedRows: rows.filter((row) => row.wrapped === true).length,
      overflowingRows: overflowing.map((row) => ({ where: row.where, top: row.top, span: row.span, available: row.available, overflowPx: row.overflowPx })),
      clippedRows: clipped.map((row) => ({ where: row.where, top: row.top, texts: row.children?.map((c) => c.text) })),
      squashedRows: squashed.map((row) => ({ where: row.where, top: row.top, narrowest: row.narrowest })),
      tightestRow: tightest
        ? { where: tightest.where, top: tightest.top, span: round1(tightest.span), available: round1(tightest.available), usedRatio: round1(tightest.used * 100) / 100, texts: tightest.children?.map((c) => c.text) }
        : null,
      note:
        rows.every((row) => row.wrapped !== true)
          ? '所有按钮行都是单行渲染：换行从未发生，靠的是「放得下」，不是 flex-wrap 这道兜底'
          : '存在真的换行的按钮行',
    },
  }
}

/**
 * 假设 2「弹窗内容超出会滚动」。
 *
 * 验收口径：
 *   判「不成立」= 弹窗内容确实高于卡片可视高度，却找不到任何一个计算值可滚的容器
 *   （`overflow-y`/`overflow-x` 落在 auto|scroll），也就是内容不可达。
 *   判「成立」= 存在溢出，并且该溢出元素的计算值本身就能滚（cdp 报的 clientHeight
 *   < scrollHeight 是浏览器算出来的，不是声明推断的）。
 */
export const judgeDialogScroll = (measurement) => {
  const samples = dialogSamples(measurement)
  if (samples.length === 0) {
    return {
      assumption: ASSUMPTIONS.dialogScroll,
      verdict: VERDICT.untested,
      evidence: { reason: '测量 JSON 里没有打开的弹窗', sampleCount: 0 },
    }
  }

  const perSample = samples.map(({ where, probe, swipe }) => {
    const hosts = probe?.scrollHosts ?? []
    const overflowingY = hosts.filter((host) => host.overflowingY === true)
    const scrollableHosts = overflowingY.filter(
      (host) => SCROLLABLE_OVERFLOW.test(host.css?.['overflow-y'] ?? '') || SCROLLABLE_OVERFLOW.test(host.css?.['overflow-x'] ?? ''),
    )
    const card = probe?.dialog ?? null
    // 卡片自己被压到视口内、内容却比卡片高：典型「不溢出 → 不可滚」
    const cardClamped = Boolean(card && card.clientHeight > 0 && card.scrollHeight > card.clientHeight + 1)
    return {
      where,
      hasOverflow: overflowingY.length > 0,
      scrollableHost: scrollableHosts.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null,
      cardClamped,
      card: card ? { height: round1(card.rect?.height), clientHeight: card.clientHeight, scrollHeight: card.scrollHeight, overflowY: card.style?.['overflow-y'] } : null,
      reachable: swipe?.reachableAtEnd ?? null,
      hiddenPx: overflowingY.length ? Math.max(...overflowingY.map((host) => host.scrollHeight - host.clientHeight)) : 0,
    }
  })

  const unreachable = perSample.filter((sample) => sample.hasOverflow && !sample.scrollableHost)
  const anyOverflow = perSample.some((sample) => sample.hasOverflow)

  let verdict
  if (!anyOverflow) {
    // 没有溢出 = 这条假设这次没被触发；不能算成立，也不能算不成立
    verdict = VERDICT.untested
  } else if (unreachable.length > 0) {
    verdict = VERDICT.falsified
  } else {
    verdict = VERDICT.holds
  }

  return {
    assumption: ASSUMPTIONS.dialogScroll,
    verdict,
    evidence: {
      criterion: '内容高于卡片可视高度、却没有任何计算值 overflow 为 auto|scroll 的滚动宿主 ⇒ 不成立',
      sampleCount: samples.length,
      perSample,
      note: anyOverflow
        ? '溢出量与滚动宿主都是浏览器实测值（clientHeight vs scrollHeight），不是从 CSS 声明推断的'
        : '该宽度下弹窗内容没超出，假设未被触发（记为未测，不记成立）',
    },
  }
}

/**
 * 假设 3「触摸滑动会滚容器」。
 *
 * 验收口径（issue #30 的教训）：
 *   CDP 合成的 wheel 事件不算证据 —— 它绕过了 touchmove 拦截。只有
 *   `adb shell input swipe` 打出的真实触摸事件才作数。判「不成立」= 存在可滚宿主
 *   （scrollHeight > clientHeight）而真实滑动后 `scrollTop` 仍为 0。
 */
export const judgeTouchScroll = (measurement) => {
  const swipe = measurement?.settingsDialog?.swipe ?? null
  const host = swipe?.host ?? null
  if (!swipe || !host) {
    return {
      assumption: ASSUMPTIONS.touchScroll,
      verdict: VERDICT.untested,
      evidence: { reason: '没有可滚宿主或没有跑真实触摸手势', swipe: swipe ?? null },
    }
  }

  const delta = typeof swipe.scrollTopDelta === 'number' ? swipe.scrollTopDelta : null
  const reachableAtEnd = swipe.reachableAtEnd ?? null
  const falsified = delta === 0 || (reachableAtEnd === false && delta !== null && delta <= 0)

  return {
    assumption: ASSUMPTIONS.touchScroll,
    verdict: falsified ? VERDICT.falsified : VERDICT.holds,
    evidence: {
      criterion: '存在可滚宿主而真实触摸滑动后 scrollTop 仍为 0 ⇒ 不成立',
      gestureSource: 'adb shell input swipe（真实触摸事件；CDP 合成 wheel 不作数）',
      host: { cls: host.cls, clientHeight: host.clientHeight, scrollHeight: host.scrollHeight, scrollTopBefore: host.scrollTop },
      gesture: swipe.swipeGesture ?? null,
      scrollTopAfterFirstSwipe: swipe.scrollTopAfterFirstSwipe ?? null,
      scrollTopDelta: delta,
      remainingAtEnd: swipe.atEnd?.remainingScroll ?? null,
      reachableAtEnd,
      note:
        delta && delta > 0
          ? `真实触摸把容器滚了 ${round1(delta)}px，末端内容可达（剩余未滚 ${round1(swipe.atEnd?.remainingScroll ?? 0)}px 即到底）`
          : '真实触摸滑动后 scrollTop 没有变化',
    },
  }
}

/**
 * 假设 4「100vh 等于可视高度」。
 *
 * 验收口径：
 *   静息态与软键盘弹出态各测一次 `100vh` 实测高度 vs `visualViewport.height`。
 *   两态之差都 ≤ 1px 才算成立。只有静息态成立、键盘态不成立 ⇒ 不成立
 *   （这正是移动端 100vh 最经典的失灵场景，不能因为静息态好看就放过）。
 */
export const judgeViewportHeight = (measurement) => {
  const keyboard = measurement?.keyboard ?? null
  const rested = keyboard?.rested ?? null
  if (!rested) {
    return {
      assumption: ASSUMPTIONS.viewportHeight,
      verdict: VERDICT.untested,
      evidence: { reason: '测量 JSON 里没有视口快照' },
    }
  }

  const read = (snapshot) => {
    if (!snapshot) return null
    const vh = snapshot.measured100vh
    const vv = snapshot.visualViewport?.height ?? null
    return {
      measured100vh: round1(vh),
      innerHeight: snapshot.innerHeight,
      visualViewportHeight: round1(vv),
      delta: vh !== undefined && vv !== null ? round1(Math.abs(vh - vv)) : null,
      dvhSupported: snapshot.dvhSupported ?? null,
    }
  }

  const rest = read(rested)
  const withKeyboard = read(keyboard.withKeyboard ?? null)
  const imeShown = keyboard.imeShown ?? null

  const bad = (sample) => sample !== null && sample.delta !== null && sample.delta > VIEWPORT_TOLERANCE_PX
  const restBad = bad(rest)
  const keyboardBad = bad(withKeyboard)

  let verdict
  if (restBad) verdict = VERDICT.falsified
  else if (!withKeyboard) verdict = VERDICT.untested
  else if (keyboardBad) verdict = VERDICT.falsified
  else verdict = VERDICT.holds

  const mechanism = restBad || keyboardBad ? null : '100vh 跟随可视高度（Activity adjustResize 把 WebView 窗口本身改小，而不是页面被键盘盖住）'

  return {
    assumption: ASSUMPTIONS.viewportHeight,
    verdict,
    evidence: {
      criterion: `静息态与软键盘态，实测 100vh 与 visualViewport.height 之差都 ≤ ${VIEWPORT_TOLERANCE_PX}px ⇒ 成立`,
      rest,
      withKeyboard,
      imeShown,
      dvhSupported: rest?.dvhSupported ?? null,
      mechanism,
      note:
        verdict === VERDICT.holds
          ? 'dvh 在 WebView 83 上不支持（CSS.supports 实测 false），所以代码里的 @supports (…100dvh) 分支整条不生效；那条分支只对 108+ 内核有意义'
          : '100vh 与可视高度不一致',
    },
  }
}

/**
 * 一条测量 JSON → 四条假设的结论。
 * 传入数组时按宽度合并：任一宽度被证伪即整体「不成立」，至少一个宽度成立且没有证伪即「成立」。
 */
export const auditBehaviorAssumptions = (input) => {
  const measurements = (Array.isArray(input) ? input : [input]).filter(Boolean)
  if (measurements.length === 0) {
    return {
      findings: Object.values(ASSUMPTIONS).map((assumption) => ({
        assumption,
        verdict: VERDICT.untested,
        evidence: { reason: '没有测量数据' },
      })),
      summary: { assumptionCount: 4, holds: 0, falsified: 0, untested: 4, widths: [], issuesToOpen: [] },
    }
  }

  const judges = [judgeButtonWrap, judgeDialogScroll, judgeTouchScroll, judgeViewportHeight]
  const findings = judges.map((judge) => {
    const perWidth = measurements.map((measurement) => ({ width: measurement.width, result: judge(measurement) }))
    const falsifiedAt = perWidth.filter((item) => item.result.verdict === VERDICT.falsified)
    const holdsAt = perWidth.filter((item) => item.result.verdict === VERDICT.holds)
    let verdict
    if (falsifiedAt.length > 0) verdict = VERDICT.falsified
    else if (holdsAt.length > 0) verdict = VERDICT.holds
    else verdict = VERDICT.untested

    const primary = (falsifiedAt[0] ?? holdsAt[0] ?? perWidth[0]).result
    return {
      assumption: primary.assumption,
      verdict,
      evidence: {
        ...primary.evidence,
        falsifiedAt: falsifiedAt.map((item) => item.width),
        holdsAt: holdsAt.map((item) => item.width),
        untestedAt: perWidth.filter((item) => item.result.verdict === VERDICT.untested).map((item) => item.width),
        perWidth: perWidth.map((item) => ({ width: item.width, verdict: item.result.verdict, evidence: item.result.evidence })),
      },
    }
  })

  const count = (verdict) => findings.filter((finding) => finding.verdict === verdict).length
  return {
    findings,
    summary: {
      assumptionCount: findings.length,
      holds: count(VERDICT.holds),
      falsified: count(VERDICT.falsified),
      untested: count(VERDICT.untested),
      widths: measurements.map((measurement) => measurement.width),
      // 只有这里非空才该开单：复现不出就不要开单
      issuesToOpen: findings.filter((finding) => finding.verdict === VERDICT.falsified).map((finding) => finding.assumption),
    },
  }
}
