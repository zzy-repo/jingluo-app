import { useEffect, useRef, useState, useCallback } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import {
  getBaseUrl,
  normalizeBaseUrl,
  readSourceField,
  recordKeySuccess,
  setBaseUrl,
  setModel,
  setProviderKind,
  useApiConfig,
  recordConfigRejection,
} from '../../services/api/apiConfig.js'
import { isKeyFormatInvalid } from '../../services/api/keyFailure.js'
import {
  PROVIDER_SPECS,
  getSpec,
  isUserField,
  type ProviderField,
  type ProviderKind,
  type ProviderSpec,
} from '../../services/api/providers.js'
import {
  PROBE_TIMEOUT_MS,
  probeProvider,
  type ProviderProbeResult,
} from '../../services/api/client.js'
import { isKeyRejected, shouldAutoProbe, useKeyRejection } from '../../services/api/keyRejection.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { useSettings } from '../../services/settings.js'
import { sendBlockFieldOf, sendBlockMessageKeyOf, type SendBlockField } from '../../services/api/sendConfigCheck.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { clearSendConfigBlocked, useSettingsDialog } from './settingsDialogState.js'
import { rendersKeyControls, sourceFieldRows } from './sourceFieldPlan.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** API Key 的编辑状态：输入框与移动端底部的「确定」按钮共用 */
export const useApiKeyEditor = () => {
  const apiKey = useApiConfig((state) => state.apiKey)
  const [editing, setEditing] = useState(false)
  // 保存成功收起输入框；校验失败留在编辑态，否则首次配置时 editing 本就是 false，
  // 会直接切到掩码视图把错误提示一起藏掉（用户看到「已保存」却不知道校验没过）。
  const form = useApiKeyForm({
    onSaved: () => setEditing(false),
    onFailed: () => setEditing(true),
  })
  /**
   * #451：被「发送前拦截」拦过的那把 Key 即使已保存（掩码视图）也必须把输入框摆出来 ——
   * 提示说「格式不对、请在这一行改正」，却让人再点一次铅笔图标才能改，是把话说一半。
   */
  const blocked = useSettingsDialog((state) => state.apiKeyFormatBlocked)
  return {
    apiKey,
    editing,
    setEditing,
    form,
    showInput: !apiKey || editing || blocked,
    formatBlocked: blocked,
  }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/**
 * 服务配置区：最上面是「渠道」下拉，下面按 `sourceFieldRows(kind)` 循环渲染输入行，最后是连通性测试。
 * 新增渠道只需要在 providers.ts 里加一个 spec，这里的 JSX 结构不用改。
 *
 * 渠道决定这一区长什么样：内置地址/模型的渠道（DeepSeek 官方 / 我们的渠道）fields 里没有
 * baseUrl / model，于是只渲染 API Key 一行；要自己填地址的渠道（Anthropic 协议 / OpenAI 兼容）
 * 渲染三行。切换渠道时界面静默变化，不给能力说明。
 *
 * #800：`ours`（内置服务）的 Key 由服务端下发，**Key 那一行整行不渲染**
 * （判定只有一处：`sourceFieldPlan.sourceFieldRows`）。因此这一页在内置服务上不再有
 * Key 输入框、Key 掩码展示区与「重新领取」—— 领取与恢复全走后台自动对齐
 * （`managedKeyRuntime.syncManagedKeyFromServer`），详见 `sourceFieldPlan.ts` 的文件头。
 */
/**
 * 「模型来源」手风琴里的**草稿绑定**（Issue #807）。
 *
 * 为什么要有它：票面要求「展开 / 收起只是查看编辑，只有点『确认使用』才切换生效来源」，
 * 所以手风琴里的字段不能再像旧子页那样「失焦即落盘」。这里只传两件东西 —— 当前值、改一格的回调 ——
 * 值的生死由页面的状态机管（`sourceAccordion.sourcePageReducer`：收起时**不动** `drafts`，
 * 所以草稿不丢）。「确认使用」失败的红字由视图渲染在按钮上方，不在这里重复一份。
 */
export type SourceDraftBinding = {
  /** 草稿当前值（三个字段与 `ProviderField` 同名，`sourceFieldRows` 直接查） */
  values: { baseUrl: string; apiKey: string; model: string }
  /** 改一格 */
  onChange: (field: 'baseUrl' | 'apiKey' | 'model', value: string) => void
}

/**
 * 服务配置区：按 `sourceFieldRows(kind)` 循环渲染输入行。
 * 新增渠道只需要在 providers.ts 里加一个 spec，这里的 JSX 结构不用改。
 *
 * 渠道决定这一区长什么样：内置地址/模型的渠道（DeepSeek 官方 / 我们的渠道）fields 里没有
 * baseUrl / model，于是只渲染 API Key 一行；要自己填地址的渠道（Anthropic 协议 / OpenAI 兼容）
 * 渲染三行。切换渠道时界面静默变化，不给能力说明。
 *
 * #800：`ours`（内置服务）的 Key 由服务端下发，**Key 那一行整行不渲染**
 * （判定只有一处：`sourceFieldPlan.sourceFieldRows`）。因此这一页在内置服务上不再有
 * Key 输入框、Key 掩码展示区与「重新领取」—— 领取与恢复全走后台自动对齐
 * （`managedKeyRuntime.syncManagedKeyFromServer`），详见 `sourceFieldPlan.ts` 的文件头。
 *
 * #807：多了一种 **`mode: 'draft'`** 形态 —— 手风琴展开区里的字段只在草稿里改，
 * 点「确认使用」（`sourceAccordionRuntime.confirmSourceRow`）校验通过才落盘。
 * 两种形态共用**同一份行清单**（`sourceFieldRows`）与同一批输入控件样式，
 * 所以「内置服务没有 Key 行」这条 #800 的结论在两种形态下都成立（`ours` 的行清单是空的）。
 */
export const ApiConfigFields = (
  props: (
    | { mode?: 'store'; editor: ApiKeyEditor }
    | { mode: 'draft'; draft: SourceDraftBinding }
  ) & {
    /**
     * #727 阶段 1：设置第三个 tab 里「来源」由三行（内置 / 第三方 / 官方）自己选，
     * 这一块就不再重复渲染「渠道」下拉 —— 字段本身仍按 `spec.fields` 走，一个字都不改。
     */
    hideProviderKind?: boolean
    /**
     * #807：渲染**哪一行来源**的字段（默认 = 生效来源）。
     *
     * 展开≠生效：用户可以在生效来源是「内置服务」时展开「第三方服务」填它的地址，
     * 这时字段清单要按 `thirdPartyEntryKind()` 那一槽来算，而不是按当前 kind。
     */
    kind?: ProviderKind
  }
) => {
  const storeKind = useApiConfig((state) => state.kind)
  const kind = props.kind ?? storeKind
  const spec = getSpec(kind)
  const hideProviderKind = props.hideProviderKind === true
  if (props.mode === 'draft') {
    return (
      <>
        {hideProviderKind ? null : <ProviderKindField />}
        {sourceFieldRows(kind).map((field) => (
          <DraftField key={field} field={field} spec={spec} draft={props.draft} />
        ))}
        {showsBuiltInBaseUrl(spec) ? <BuiltInBaseUrlField spec={spec} /> : null}
        {showsBuiltInModel(spec) ? <BuiltInModelField spec={spec} /> : null}
        <DraftTestField spec={spec} draft={props.draft} />
      </>
    )
  }
  const editor = props.editor
  return (
    <>
      {hideProviderKind ? null : <ProviderKindField />}
      {sourceFieldRows(kind).map((field) => (
        <ApiConfigField key={field} field={field} spec={spec} editor={editor} />
      ))}
      {showsBuiltInBaseUrl(spec) ? <BuiltInBaseUrlField spec={spec} /> : null}
      {showsBuiltInModel(spec) ? <BuiltInModelField spec={spec} /> : null}
      <ConnectionTestField editor={editor} />
    </>
  )
}

/**
 * 草稿形态的一行输入（#807）：**受控**，改了就回调，不落盘也不探测。
 *
 * 三个字段的标签复用即有的 `settings*Label` 词条；`apiKey` 仍是 `type="password"`
 * （草稿里也不明文显示），`baseUrl` 走 `inputMode="url"`。
 */
const DraftField = ({
  field,
  spec,
  draft,
}: {
  field: ProviderField
  spec: ProviderSpec
  draft: SourceDraftBinding
}) => {
  const t = useTranslate()
  const label =
    field === 'baseUrl'
      ? t('settingsBaseUrlLabel')
      : field === 'apiKey'
        ? t('settingsApiKeyLabel')
        : t('settingsModelLabel')
  const placeholder =
    field === 'baseUrl'
      ? spec.defaults?.baseUrl || t('settingsBaseUrlPlaceholder')
      : field === 'apiKey'
        ? t('apiKeyPlaceholder')
        : spec.defaults?.model || t('settingsModelPlaceholder')
  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{label}</div>
        <div className={styles.apiKeyInput}>
          <input
            type={field === 'apiKey' ? 'password' : 'text'}
            inputMode={field === 'baseUrl' ? 'url' : undefined}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
            data-testid={`settings-source-draft-${field}`}
            value={draft.values[field]}
            onChange={(event) => draft.onChange(field, event.target.value)}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * 草稿形态的连通性探测（#807：**可选**，探测结果不影响「确认使用」）。
 *
 * 用草稿里的地址与 Key 打一次 `GET {base}/models`（与设置页那个「测试」同一条实现
 * `probeProvider`、同一个 15s 探测超时 #771）。失败只说给用户听，不拦按钮：
 * 中转的 CORS 常常只放行 POST，探不通不代表聊不了。
 */
const DraftTestField = ({ spec, draft }: { spec: ProviderSpec; draft: SourceDraftBinding }) => {
  const t = useTranslate()
  const [error, setError] = useState<TranslationKey | null>(null)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null)
  const test = async () => {
    if (testing) {
      return
    }
    const baseUrl = draft.values.baseUrl.trim() || spec.defaults?.baseUrl || ''
    const apiKey = draft.values.apiKey.trim()
    if (!baseUrl) {
      setError('settingsBaseUrlRequired')
      setProbe(null)
      return
    }
    if (!apiKey) {
      setError('settingsTestApiKeyRequired')
      setProbe(null)
      return
    }
    setError(null)
    setTesting(true)
    setProbe(null)
    try {
      const result = await probeProvider({ baseUrl, apiKey }, PROBE_TIMEOUT_MS)
      // #451：只有真拿到成功应答才记「最近一次确认可用」；失败一次都不写
      if (result.ok) {
        recordKeySuccess(apiKey)
      }
      setProbe(result)
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsTestLabel')}</div>
        <div className={styles.apiKeyInput}>
          <button
            type="button"
            className={styles.confirm}
            disabled={testing}
            data-testid="settings-source-draft-test"
            onClick={() => void test()}
          >
            {testing ? t('settingsTesting') : t('settingsTest')}
          </button>
        </div>
        {error ? <div className={styles.error}>{t(error)}</div> : null}
        {probe ? <div className={styles.description}>{describeProbe(t, probe)}</div> : null}
      </div>
    </div>
  )
}

/**
 * 要不要渲染「内置模型」只读行（#339）。
 *
 * 条件是「模型是内置的、但不是 locked」：官方 deepseek 属于这一类（有 defaults.model、
 * fields 里没有 model）；ours 是 locked（后端地址与模型都不许露，见 internal-build/provider-channels
 * 的锁定断言），所以排除。将来再加内置渠道时这条规则自动适用，不用改这里。
 */
const showsBuiltInModel = (spec: ProviderSpec): boolean =>
  !spec.locked && !isUserField(spec, 'model')

/**
 * 要不要渲染「内置地址」只读行（#807）。
 *
 * 判据与 `showsBuiltInModel` 同构：地址是内置的（`fields` 里没有 baseUrl）但渠道没被锁
 * （`locked` 的 ours 连地址都不许露）。今天只有 DeepSeek 官方服务走这一支 ——
 * 票面「官方：地址固定，只填 API Key」里的「固定」必须**看得见**，否则用户会以为漏了一格。
 */
const showsBuiltInBaseUrl = (spec: ProviderSpec): boolean =>
  !spec.locked && !isUserField(spec, 'baseUrl')

/** 内置地址（#807）：只读一行，不提供输入框 —— 地址跟着渠道走，用户改不了 */
const BuiltInBaseUrlField = ({ spec }: { spec: ProviderSpec }) => {
  const t = useTranslate()
  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsBaseUrlLabel')}</div>
          <div className={styles.description}>{t('settingsSourceBaseUrlFixed')}</div>
        </div>
        <div className={styles.modelValue} role="status" data-testid="settings-source-base-url-fixed">
          {readSourceField(spec.kind, 'baseUrl')}
        </div>
      </div>
    </div>
  )
}

/**
 * 内置模型（#339）：值来自 spec.defaults / 迁移后的 state，用户改不了 —— 但必须**看得见**。
 *
 * 刻意不用 `<input>`：它不是可编辑字段，只是把生效值摆出来；用输入框既会撞
 * `provider-channels.test.mjs` 的「模型输入框」计数，也会让人以为能改（`setModel` 会拒写）。
 * 标签复用 `settingsModelLabel`（「模型」），因为老中转场景下展示的是沿用下来的旧模型，
 * 叫「内置模型」会变成一句假话；`role="status"` 让读屏软件把值当状态读出来。
 */
const BuiltInModelField = ({ spec }: { spec: ProviderSpec }) => {
  const t = useTranslate()
  const stored = useApiConfig((state) => state.model)
  const model = stored || spec.defaults?.model || ''
  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsModelLabel')}</div>
          <div className={styles.description}>{t('settingsModelBuiltInHint')}</div>
        </div>
        <div className={styles.modelValue} role="status">
          {model}
        </div>
      </div>
      <SendBlockedHint field="model" />
    </div>
  )
}

/**
 * #490：这次发送被「必错配置」拦下来的那一行，就在该字段下面写清原因（红字）。
 *
 * 为什么要写在行内而不是只弹 toast：toast 三秒就没了，而用户接下来要做的就是改这一行；
 * 提示停在字段旁边，「跳到对应设置」才算真的落到了地方（与 #451 的 Key 行、#596 的领取行同一纪律）。
 * 显示哪一句、落在哪一行都从 `sendConfigCheck` 的同一张表取（`sendBlockMessageKeyOf` /
 * `sendBlockFieldOf`），组件里不再按码做第二次判断。
 */
const SendBlockedHint = ({ field }: { field: SendBlockField }) => {
  const t = useTranslate()
  const blocked = useSettingsDialog((state) => state.sendConfigBlocked)
  if (blocked === null || sendBlockFieldOf(blocked) !== field) {
    return null
  }
  return (
    <div
      className={styles.error}
      role="status"
      data-testid={`settings-${field === 'baseUrl' ? 'base-url' : 'model'}-blocked`}
    >
      {t(sendBlockMessageKeyOf(blocked))}
    </div>
  )
}

/** 字段 → 输入行；顺序与显隐都由 spec.fields 决定 */
const ApiConfigField = ({
  field,
  spec,
  editor,
}: {
  field: ProviderField
  spec: ProviderSpec
  editor: ApiKeyEditor
}) => {
  switch (field) {
    case 'apiKey':
      /**
       * #596：Key 行按渠道分形态；#800 起「服务端管理」的那一类**根本不会走到这里**
       * （`sourceFieldPlan.sourceFieldRows` 已经把 apiKey 从行清单里摘掉，连展示区一起），
       * 所以这里只剩用户自己填的那一种形态，不再保留只读分支。
       */
      return <ApiKeyField editor={editor} />
    case 'baseUrl':
      return <BaseUrlField spec={spec} />
    case 'model':
      return <ModelField spec={spec} />
  }
}

/**
 * 渠道：切换后路径、鉴权头、输入行与能力入口立即跟着 spec 走。
 * 选项里只有渠道名（能力差异不写文案，能不能用直接体现在入口显隐上）。
 * API Key 四个渠道共用一把，切换后可能不适用，所以只给一句操作提示（重新填 Key）。
 */
const ProviderKindField = () => {
  const t = useTranslate()
  const kind = useApiConfig((state) => state.kind)
  const apiKey = useApiConfig((state) => state.apiKey)
  const locale = useSettings((state) => state.locale)
  const [switched, setSwitched] = useState(false)
  // 选项名双语写在 spec.label 里，跟着界面语言切换
  const lang = locale.startsWith('zh') ? 'zh' : 'en'
  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsProviderKindLabel')}</div>
        </div>
        <Select
          ariaLabel={t('settingsProviderKindLabel')}
          className={styles.providerSelect}
          value={kind}
          options={PROVIDER_SPECS.map((item) => ({ value: item.kind, label: item.label[lang] }))}
          onChange={(next: ProviderKind) => {
            setProviderKind(next)
            setSwitched(true)
          }}
        />
      </div>
      {/* 只在「切过渠道且已经有 Key」时提示一次：Key 是共用的，换了渠道可能不适用 */}
      {switched && apiKey ? (
        <div className={styles.description}>{t('settingsProviderKindKeyHint')}</div>
      ) : null}
    </div>
  )
}

/** API Key：保存后只显示掩码，点编辑按钮才能重新输入 */
const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, editing, setEditing, form, showInput } = editor
  // 上游已经用 401 判过这把 Key（#303）：直接在 Key 这一行说清怎么修，而不是等用户去点测试
  const rejection = useKeyRejection((state) => state.rejection)
  const rejected = isKeyRejected()
  /**
   * #451：Key 看起来就不像一把 Key（含空格 / 换行、长度异常）。
   *
   * 两种状态分开显示：
   *  - `formatBlocked`（这次发送**被拦下来了**）→ 红字，明确写「这条消息没有发出去」；
   *  - 只是存着一条格式不对的 Key（还没试过发）→ 普通提示，别把人吓一跳。
   * 判据与请求前的拦截、与 #374 的失败细分同一个函数（`isKeyFormatInvalid`），不另写一套。
   */
  const formatBlocked = editor.formatBlocked
  const formatSuspicious = apiKey !== '' && isKeyFormatInvalid(apiKey)

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsApiKeyLabel')}</div>
        {/* #451：被拦下来的那把 Key 直接进编辑态 —— 提示写着「请在这一行改正」，
            却还盖着一层掩码与铅笔图标，等于把话说一半 */}
        {apiKey && !editing && !formatBlocked ? (
          <div className={styles.apiKeySaved}>
            <span className={styles.apiKeyMask}>{'*'.repeat(apiKey.length)}</span>
            <IconButton
              tone="primary"
              icon={<IconEditOutline16 />}
              tooltip={t('apiKeyEdit')}
              onClick={() => setEditing(true)}
            />
          </div>
        ) : (
          <div className={styles.apiKeyInput}>
            <input
              type="password"
              placeholder={t('apiKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              // 移动端打开设置时不弹键盘，点编辑后才聚焦
              autoFocus={!isMobile || editing}
              value={form.value}
              onChange={(event) => form.setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void form.submit()
                }
              }}
              onBlur={() => {
                // 修改时没输入就离开，回到已保存的状态
                if (apiKey && !form.value.trim()) {
                  setEditing(false)
                }
              }}
            />
            {!isMobile && form.value.trim() ? (
              <>
                <span className={styles.divider} />
                <button
                  type="button"
                  className={styles.confirm}
                  disabled={form.verifying}
                  // 保持输入框焦点
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void form.submit()}
                >
                  {form.verifying ? t('apiKeyVerifying') : t('confirm')}
                </button>
              </>
            ) : null}
          </div>
        )}
        {showInput && form.error ? <div className={styles.error}>{form.error}</div> : null}
        {!showInput || !form.error
          ? rejected && rejection
            ? <div className={styles.error}>{t('apiKeyRejected')}</div>
            : null
          : null}
        {formatBlocked ? (
          <div className={styles.error} role="status" data-testid="settings-api-key-format-blocked">
            {t('settingsApiKeyFormatBlocked')}
          </div>
        ) : formatSuspicious ? (
          <div className={styles.description} data-testid="settings-api-key-format-hint">
            {t('settingsApiKeyFormatHint')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 服务地址：失焦或回车保存；spec 没给默认值时必须填写 */
const BaseUrlField = ({ spec }: { spec: ProviderSpec }) => {
  const t = useTranslate()
  const stored = useApiConfig((state) => state.baseUrl)
  const fallback = spec.defaults?.baseUrl ?? ''
  const [value, setValue] = useState(stored || fallback)
  const [error, setError] = useState<TranslationKey | null>(null)

  // 外部（其他标签页打开时的初始值 / 保存后的规范化结果 / 切换服务类型）变化时同步
  useEffect(() => {
    setValue(stored || fallback)
  }, [stored, fallback])

  const save = (): boolean => {
    // 清空即回到内置默认地址；没有内置默认的服务类型必须填
    if (!value.trim()) {
      setError(null)
      if (!fallback) {
        setError('settingsBaseUrlRequired')
        recordConfigRejection('baseUrl', 'required')
        return false
      }
      setBaseUrl('')
      setValue(fallback)
      return true
    }
    const normalized = normalizeBaseUrl(value)
    if (!normalized) {
      // 配置保存失败也要留痕：这类「保存后没反应」的问题只看状态是查不出来的
      setError('settingsBaseUrlInvalid')
      recordConfigRejection('baseUrl', 'invalid')
      return false
    }
    setError(null)
    if (normalized !== value) {
      setValue(normalized)
    }
    setBaseUrl(normalized)
    /**
     * #490：**改过**这一行之后才撤掉那条「这条消息没有发出」—— 只是点进来又失焦（值没变）不算改，
     * 否则「地址填成了具体接口」这种（URL 本身合法、保存也成功）会被一次空编辑悄悄洗掉红字。
     * 真没改的话，下次发送会重新判一遍并再次点出来。
     */
    if (normalized !== (stored || fallback)) {
      clearSendConfigBlocked('baseUrl')
    }
    return true
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsBaseUrlLabel')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="text"
            inputMode="url"
            placeholder={fallback || t('settingsBaseUrlPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('settingsBaseUrlLabel')}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                save()
              }
            }}
            onBlur={save}
          />
        </div>
        {error ? <div className={styles.error}>{t(error)}</div> : null}
        <SendBlockedHint field="baseUrl" />
      </div>
    </div>
  )
}

/** 模型：失焦或回车保存，不能为空 */
const ModelField = ({ spec }: { spec: ProviderSpec }) => {
  const t = useTranslate()
  const stored = useApiConfig((state) => state.model)
  const baseUrl = useApiConfig((state) => state.baseUrl)
  const apiKey = useApiConfig((state) => state.apiKey)
  const fallback = spec.defaults?.model ?? ''
  const [value, setValue] = useState(stored || fallback)
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
  const [error, setError] = useState<TranslationKey | null>(null)
  const requestId = useRef(0)
  const defaultBaseUrl = spec.defaults?.baseUrl ?? ''

  useEffect(() => {
    setValue(stored || fallback)
  }, [stored, fallback])

  const save = () => {
    if (!value.trim()) {
      setError('settingsModelInvalid')
      return
    }
    setError(null)
    if (!setModel(value)) {
      setError('settingsModelInvalid')
      return
    }
    setValue(value.trim())
    // #490：同上 —— 值真的变了才撤红字（空编辑不算改）
    if (value.trim() !== (stored || fallback)) {
      clearSendConfigBlocked('model')
    }
  }

  const loadModels = useCallback(async () => {
    // Key 被判失效后不再自动打上游（#303 问题 3）：手动点刷新仍然可以试
    if (!shouldAutoProbe()) {
      setModels([])
      setStatus('error')
      setError('apiKeyRejected')
      return
    }
    const id = ++requestId.current
    setStatus('loading')
    // 探测超时显式传入（#771）：它是「地址通不通」的即时反馈，不跟 connectMs（60s）一起放宽
    const result = await probeProvider(
      { baseUrl: baseUrl || defaultBaseUrl, apiKey },
      PROBE_TIMEOUT_MS
    )
    if (id !== requestId.current) {
      return
    }
    if (!result.ok) {
      setModels([])
      setStatus('error')
      // 401：上游说的是「Key 不行」，界面就得说「Key 不行」，别把原始报错丢给用户
      setError(result.status === 401 ? 'apiKeyRejected' : null)
      return
    }
    setError(null)
    setModels(result.models)
    setStatus(result.models.length ? 'ready' : 'empty')
    // #451：GET /models 成功 = 这把 Key 现在被上游认了，记一次「确认可用」（见 services/invite/keyIdentity.ts）
    recordKeySuccess(apiKey)
  }, [baseUrl, apiKey, defaultBaseUrl])

  // 订阅判定状态：Key 被判失效时这里会重渲染，但下面的 effect 不会再发自动请求
  const rejection = useKeyRejection((state) => state.rejection)
  useEffect(() => {
    if (rejection && isKeyRejected()) {
      setStatus('error')
      setError('apiKeyRejected')
      return
    }
    if (apiKey && (baseUrl || defaultBaseUrl)) {
      void loadModels()
    }
    const slot = requestId
    return () => {
      slot.current++
    }
  }, [spec.kind, baseUrl, apiKey, defaultBaseUrl, loadModels, rejection])

  const options = models.includes(value.trim()) || !value.trim() ? models : [value.trim(), ...models]
  const [open, setOpen] = useState(false)
  const selecting = useRef(false)
  const chooseModel = (model: string) => {
    selecting.current = true
    setValue(model)
    setOpen(false)
    if (!setModel(model)) {
      setError('settingsModelInvalid')
    }
    window.setTimeout(() => { selecting.current = false }, 0)
  }
  return (
    <div className={`${styles.cell} ${open ? styles.modelCellOpen : ''}`}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsModelLabel')}</div>
        <div className={styles.apiKeyInput}>
          <div className={styles.modelPicker}>
            <input
              type="text" placeholder={fallback || t('settingsModelPlaceholder')}
              autoComplete="off" spellCheck={false} aria-label={t('settingsModelLabel')} value={value}
              onFocus={() => setOpen(true)}
              onChange={(event) => { setValue(event.target.value); setError(null); setOpen(true) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setOpen(false)
                }
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  save()
                  setOpen(false)
                }
              }}
              onBlur={() => {
                setOpen(false)
                if (!selecting.current) {
                  save()
                }
              }}
            />
            {open && options.length > 0 ? <div className={styles.modelOptions} role="listbox" aria-label={t('settingsModelsAvailable')}>
              {options.map((model) => <button key={model} type="button" role="option" aria-selected={model === value} className={styles.modelOption} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseModel(model)}>{model}</button>)}
            </div> : null}
          </div>
          <button type="button" className={styles.confirm} onClick={() => void loadModels()} disabled={status === 'loading'}>
            {status === 'loading' ? t('settingsModelsLoading') : t('settingsModelsRefresh')}
          </button>
        </div>
        {status === 'empty' ? <div className={styles.description}>{t('settingsModelsEmpty')}</div> : null}
        {status === 'error' ? <div className={styles.error}>{t('settingsModelsFailed')}</div> : null}
        {error ? <div className={styles.error}>{t(error)}</div> : null}
        <SendBlockedHint field="model" />
      </div>
    </div>
  )
}

/**
 * 连通性测试：按当前服务类型请求 {baseUrl}{paths.models}，鉴权头也来自 spec。
 * Key 以输入框当前值为准（还没点「确定」也能测）。
 */
const ConnectionTestField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const kind = useApiConfig((state) => state.kind)
  const [keyError, setKeyError] = useState<TranslationKey | null>(null)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null)

  // 换服务类型后旧的测试结果没有意义
  useEffect(() => {
    setProbe(null)
    setKeyError(null)
  }, [kind])

  const test = async () => {
    if (testing) {
      return
    }
    const apiKey = editor.form.value.trim() || editor.apiKey
    const baseUrl = getBaseUrl()
    if (!baseUrl) {
      // 该服务类型必须自己填地址，空地址直接拦下
      setKeyError('settingsBaseUrlRequired')
      setProbe(null)
      return
    }
    if (!apiKey) {
      // 没有 Key 就发请求只会得到空鉴权的 401，直接在本地拦下
      setKeyError('settingsTestApiKeyRequired')
      setProbe(null)
      return
    }
    setKeyError(null)
    setTesting(true)
    setProbe(null)
    try {
      // 探测超时显式传入（#771），理由同上：connectMs 已是 60s，探测仍保持 15s 体感
      const result = await probeProvider({ baseUrl, apiKey }, PROBE_TIMEOUT_MS)
      // #451：只有真的拿到成功应答才记「最近一次确认可用」；失败一次都不写
      if (result.ok) {
        recordKeySuccess(apiKey)
      }
      setProbe(result)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsTestLabel')}</div>
        <div className={styles.apiKeyInput}>
          <button
            type="button"
            className={styles.confirm}
            disabled={testing}
            // 不阻止默认行为：先让服务地址输入框失焦落盘，测的就是要用的地址
            onClick={() => void test()}
          >
            {testing ? t('settingsTesting') : t('settingsTest')}
          </button>
        </div>
        {keyError ? <div className={styles.error}>{t(keyError)}</div> : null}
        {probe ? <div className={styles.description}>{describeProbe(t, probe)}</div> : null}
      </div>
    </div>
  )
}

/** 把连通性测试结果翻成一句可读提示，不抛异常 */
const describeProbe = (
  t: ReturnType<typeof useTranslate>,
  probe: ProviderProbeResult
): string => {
  switch (probe.reason) {
    case 'invalid':
      return t('settingsBaseUrlInvalid')
    case 'timeout':
      return t('settingsTestTimeout')
    case 'network':
      return t('settingsTestNetwork', { message: probe.message ?? '' })
    case 'html':
      return t('settingsTestHtml', { status: probe.status ?? 0 })
    case 'json':
      return t('settingsTestBadJson', { message: probe.message ?? '' })
    case 'http':
      return t('settingsTestHttp', {
        status: probe.status ?? 0,
        message: probe.message ?? '',
      })
    default:
      break
  }
  const status = probe.status ?? 0
  if (probe.models.length === 0) {
    return t('settingsTestOkEmpty', { status })
  }
  return t('settingsTestOk', {
    status,
    count: probe.models.length,
    models: probe.models.slice(0, 5).join(', '),
  })
}

/** 移动端：输入 API Key 时在选项下方显示整行「确定」 */
export const ApiKeyConfirm = ({ editor: { showInput, form } }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const kind = useApiConfig((state) => state.kind)
  // #596 / #800：这一页没有 Key 行（内置服务）时，底部就不该冒出一个「确定」——它只会把上一次
  // 在别的渠道里没提交的草稿提交掉（Key 在本仓是四个渠道共用一把，草稿会跨渠道留着）。
  // 判据与「渲染哪些行」同源（`sourceFieldPlan.rendersKeyControls`），不另写一份渠道判断。
  if (!rendersKeyControls(kind)) {
    return null
  }
  return showInput && form.value.trim() ? (
    <button
      type="button"
      className={styles.mobileConfirm}
      disabled={form.verifying}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void form.submit()}
    >
      {form.verifying ? t('apiKeyVerifying') : t('confirm')}
    </button>
  ) : null
}
