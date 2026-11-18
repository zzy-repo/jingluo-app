import { useEffect, useRef, useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import {
  getBaseUrl,
  normalizeBaseUrl,
  setBaseUrl,
  setModel,
  setProviderKind,
  useApiConfig,
  recordConfigRejection,
} from '../../services/api/apiConfig.js'
import {
  PROVIDER_SPECS,
  getSpec,
  type ProviderField,
  type ProviderKind,
  type ProviderSpec,
} from '../../services/api/providers.js'
import { probeProvider, type ProviderProbeResult } from '../../services/api/client.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { useSettings } from '../../services/settings.js'
import { useApiKeyForm } from './useApiKeyForm.js'
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
  return { apiKey, editing, setEditing, form, showInput: !apiKey || editing }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/**
 * 服务配置区：最上面是「渠道」下拉，下面按 spec.fields 循环渲染输入行，最后是连通性测试。
 * 新增渠道只需要在 providers.ts 里加一个 spec，这里的 JSX 结构不用改。
 *
 * 渠道决定这一区长什么样：内置地址/模型的渠道（DeepSeek 官方 / 我们的渠道）fields 里没有
 * baseUrl / model，于是只渲染 API Key 一行；要自己填地址的渠道（Anthropic 协议 / OpenAI 兼容）
 * 渲染三行。切换渠道时界面静默变化，不给能力说明。
 */
export const ApiConfigFields = ({ editor }: { editor: ApiKeyEditor }) => {
  const kind = useApiConfig((state) => state.kind)
  const spec = getSpec(kind)
  return (
    <>
      <ProviderKindField />
      {spec.fields.map((field) => (
        <ApiConfigField key={field} field={field} spec={spec} editor={editor} />
      ))}
      <ConnectionTestField editor={editor} />
    </>
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

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsApiKeyLabel')}</div>
        {apiKey && !editing ? (
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
  }

  const loadModels = async () => {
    const id = ++requestId.current
    setStatus('loading')
    const result = await probeProvider({ baseUrl: baseUrl || spec.defaults?.baseUrl || '', apiKey })
    if (id !== requestId.current) return
    if (!result.ok) {
      setModels([])
      setStatus('error')
      return
    }
    setModels(result.models)
    setStatus(result.models.length ? 'ready' : 'empty')
  }

  useEffect(() => {
    if (apiKey && (baseUrl || spec.defaults?.baseUrl)) void loadModels()
    return () => { requestId.current++ }
  }, [spec.kind, baseUrl, apiKey])

  const options = models.includes(value.trim()) || !value.trim() ? models : [value.trim(), ...models]
  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsModelLabel')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="text" list={`models-${spec.kind}`} placeholder={fallback || t('settingsModelPlaceholder')}
            autoComplete="off" spellCheck={false} aria-label={t('settingsModelLabel')} value={value}
            onChange={(event) => { setValue(event.target.value); setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) save() }}
            onBlur={save}
          />
          <button type="button" className={styles.confirm} onClick={() => void loadModels()} disabled={status === 'loading'}>
            {status === 'loading' ? t('settingsModelsLoading') : t('settingsModelsRefresh')}
          </button>
          <datalist id={`models-${spec.kind}`}>{options.map((model) => <option key={model} value={model} />)}</datalist>
        </div>
        {status === 'empty' ? <div className={styles.description}>{t('settingsModelsEmpty')}</div> : null}
        {status === 'error' ? <div className={styles.error}>{t('settingsModelsFailed')}</div> : null}
        {error ? <div className={styles.error}>{t(error)}</div> : null}
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
      setProbe(await probeProvider({ baseUrl, apiKey }))
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
