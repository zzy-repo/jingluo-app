import type { LinkedMessage } from '../../i18n/index.js'

/**
 * 设置页展示的抖音号（用户直接指定的展示项，不是从服务端下发的配置）。
 * 写在这里而不是写死在 JSX 里，是为了让「复制出去的值」与「提示文案」都能被纯逻辑单测覆盖。
 */
export const DOUYIN_ACCOUNT_ID = 'shiro_0824'

/**
 * 复制抖音号之后的轻提示：成功说「已复制」，失败复用通用的「复制失败」文案。
 * 复制失败不能静默——手机上剪贴板被拒时用户会以为已经复制好了。
 */
export const douyinCopyToast = (copied: boolean): LinkedMessage =>
  copied ? { key: 'settingDouyinCopied' } : { key: 'copyFailed', type: 'error' }
