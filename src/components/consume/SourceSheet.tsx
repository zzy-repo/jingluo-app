/**
 * 「模型来源」底部 sheet（#727，原型 `服务Tab.html` 的 `.mask` + `.sheet`）。
 *
 * 它**不是第二套渠道状态**：四档选项一一映射到既有的 `ProviderKind`
 * （内置 = `ours`、第三方 = `openai`、DeepSeek 官方 = `deepseek`、Anthropic 协议 = `anthropic`），
 * 点选即调 `setProviderKind()`，与设置里的渠道下拉读写的是同一个 store 字段。
 *
 * 保存也全在既有实现上：
 *   地址 → `setBaseUrl(normalizeBaseUrl(...))`（`services/api/apiConfig.ts`）
 *   模型 → `setModel(...)`（仅 `spec.fields` 里要求用户填的渠道）
 *   Key  → `useApiKeyForm()`（先落盘再 `GET /models` 校验，与设置页用的是同一个 hook）
 * 所以「校验 Key」只有一份实现，这里一行 `verifyApiKey` 都没重写。
 *
 * 安全：Key 原文只进 `setApiKey`（localStorage）与请求头，**不进日志、不进 URL、不进 DOM 文本**
 * （输入框 type=password，保存后收起）。
 *
 * 空 Key / 校验失败 → 红字「API Key 无效，请检查后重试」（`accountConsumeSourceKeyInvalid`），
 * 与原型一致；这正是 #451/#596 那套「本地拦下、不发请求」的口径。
 */
import { useState } from 'react'

import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  getBaseUrl,
  normalizeBaseUrl,
  setBaseUrl,
  setModel,
  setProviderKind,
  useApiConfig,
} from '../../services/api/apiConfig.js'
import { getSpec, isUserField, type ProviderKind } from '../../services/api/providers.js'
import { useAuthStatus } from '../../services/auth/useAuthStatus.js'
import { Button } from '../base/Button.js'
import { useApiKeyForm } from '../settings/useApiKeyForm.js'
import styles from './AccountConsume.module.css'

/** sheet 里的四档（顺序即展示顺序）；`builtin` 是原型里的「内置服务」= 我们的渠道 */
export type SourceKey = 'builtin' | 'third' | 'deepseek' | 'anthropic'

const SOURCE_KIND: Record<SourceKey, ProviderKind> = {
  builtin: 'ours',
  third: 'openai',
  deepseek: 'deepseek',
  anthropic: 'anthropic',
}

/** `ProviderKind` → sheet 选项（反向只有这一处，别在页面里再写一遍 if 链） */
export const sourceKeyOf = (kind: ProviderKind): SourceKey =>
  kind === 'ours' ? 'builtin' : kind === 'openai' ? 'third' : kind === 'anthropic' ? 'anthropic' : 'deepseek'

const SOURCE_LABEL: Record<SourceKey, TranslationKey> = {
  builtin: 'accountConsumeSourceBuiltin',
  third: 'accountConsumeSourceThird',
  deepseek: 'accountConsumeSourceDeepseek',
  anthropic: 'accountConsumeSourceAnthropic',
}

const SOURCE_ORDER: readonly SourceKey[] = ['builtin', 'third', 'deepseek', 'anthropic']

export type SourceSheetProps = {
  onClose: () => void
  /** 选好并（需要的话）保存完成：由页面关掉 sheet 并跑一次连通性测试 */
  onConfigured: () => void
  /** 未登录点「内置服务」：先走登录（原型的「未登录先弹登录框」） */
  onNeedLogin: () => void
}

export const SourceSheet = ({ onClose, onConfigured, onNeedLogin }: SourceSheetProps) => {
  const t = useTranslate()
  const kind = useApiConfig((state) => state.kind)
  const apiKey = useApiConfig((state) => state.apiKey)
  const { authenticated } = useAuthStatus()
  const [pick, setPick] = useState<SourceKey>(() => sourceKeyOf(kind))
  // 地址 / 模型的草稿只在本层：保存前不动 store（与设置页的「失焦即保存」不同 —— 这里只有一个保存动作）
  const [urlDraft, setUrlDraft] = useState(() => getBaseUrl())
  const [modelDraft, setModelDraft] = useState(() => useApiConfig.getState().model)
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)

  const form = useApiKeyForm({
    onSaved: () => onConfigured(),
    onFailed: () => undefined,
  })

  const spec = getSpec(SOURCE_KIND[pick])
  const needsUrl = isUserField(spec, 'baseUrl')
  const needsModel = isUserField(spec, 'model')
  const showFields = pick !== 'builtin'

  const choose = (next: SourceKey) => {
    setErrorKey(null)
    setPick(next)
    // 点选即生效：底层就是既有的 ProviderKind，不是本层自己的一份状态
    setProviderKind(SOURCE_KIND[next])
    const baseUrl = getBaseUrl()
    if (baseUrl !== '') {
      setUrlDraft(baseUrl)
    }
    if (next === 'builtin') {
      // 内置服务走服务端下发的 Key：没登录就没有 Key 可领，先登录（原型行为）
      if (!authenticated) {
        onClose()
        onNeedLogin()
        return
      }
      onConfigured()
    }
  }

  const save = () => {
    setErrorKey(null)
    if (needsUrl) {
      const normalized = normalizeBaseUrl(urlDraft)
      if (normalized === null) {
        setErrorKey('settingsBaseUrlInvalid')
        return
      }
      setBaseUrl(normalized)
    }
    if (needsModel && modelDraft.trim() === '') {
      setErrorKey('settingsModelInvalid')
      return
    }
    if (needsModel) {
      setModel(modelDraft.trim())
    }
    const typed = form.value.trim()
    if (typed === '') {
      // 已经存过 Key 的话，这次只是换来源：不必再校验一遍，直接进连通性测试
      if (apiKey !== '') {
        onConfigured()
        return
      }
      setErrorKey('accountConsumeSourceKeyInvalid')
      return
    }
    void form.submit()
  }

  return (
    <div className={styles.mask} data-testid="account-consume-source-mask" onClick={onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-label={t('accountConsumeGroupSource')}
        data-testid="account-consume-source-sheet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.handle} />
        <div className={styles.sheetTitle}>{t('accountConsumeGroupSource')}</div>
        <div className={styles.rows}>
          {SOURCE_ORDER.map((key, index) => (
            <div key={key}>
              {index > 0 ? <div className={styles.divider} /> : null}
              <button
                type="button"
                className={styles.row}
                aria-pressed={pick === key}
                data-testid={`account-consume-source-${key}`}
                onClick={() => choose(key)}
              >
                <span className={pick === key ? styles.valueStrong : undefined}>{t(SOURCE_LABEL[key])}</span>
                <span className={styles.value}>{pick === key ? t('confirm') : ''}</span>
              </button>
            </div>
          ))}
        </div>
        {showFields ? (
          <>
            {needsUrl ? (
              <>
                <div className={styles.label}>{t('settingsBaseUrlLabel')}</div>
                <div className={styles.field}>
                  <input
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={t('settingsBaseUrlLabel')}
                    placeholder={spec.defaults?.baseUrl ?? ''}
                    value={urlDraft}
                    onChange={(event) => {
                      setUrlDraft(event.target.value)
                      setErrorKey(null)
                    }}
                  />
                </div>
              </>
            ) : null}
            {needsModel ? (
              <>
                <div className={styles.label}>{t('settingsModelLabel')}</div>
                <div className={styles.field}>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={t('settingsModelLabel')}
                    placeholder={spec.defaults?.model ?? ''}
                    value={modelDraft}
                    onChange={(event) => {
                      setModelDraft(event.target.value)
                      setErrorKey(null)
                    }}
                  />
                </div>
              </>
            ) : null}
            <div className={styles.label}>{t('settingsApiKeyLabel')}</div>
            <div className={styles.field}>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={t('settingsApiKeyLabel')}
                placeholder={apiKey === '' ? 'sk-…' : '••••••••'}
                value={form.value}
                onChange={(event) => {
                  form.setValue(event.target.value)
                  setErrorKey(null)
                }}
              />
            </div>
            {errorKey === null && form.error === null ? (
              <p className={styles.errorText}>{t('accountConsumeSourcePickHint')}</p>
            ) : null}
            {errorKey === null ? null : <p className={styles.errorText}>{t(errorKey)}</p>}
            {form.error === null ? null : <p className={styles.errorText}>{form.error}</p>}
            <div className={styles.sheetActions} data-testid="account-consume-source-save">
              <Button block size="l" disabled={form.verifying} onClick={save}>
                {form.verifying ? t('apiKeyVerifying') : t('confirm')}
              </Button>
            </div>
          </>
        ) : (
          <p className={styles.errorText}>{t('accountConsumeSourcePickHint')}</p>
        )}
        <div className={styles.band} />
        <div className={styles.cancelRow} data-testid="account-consume-source-cancel" onClick={onClose}>
          {t('cancel')}
        </div>
      </div>
    </div>
  )
}
