/**
 * artifact-name.mjs —— **安装包产物文件名**的单一实现（Issue #836 scope ①）。
 *
 * 这里只放**纯函数**（零依赖、不读 fs），因为同一套名字要由三类不同部署单元算出来：
 *
 *   1. 发布脚本 / CI：`scripts/lib/artifactName.mjs`（读 `config/appIdentity.json` 的
 *      `artifactPrefix` 再调这里）—— `publish-private-apk.mjs`、`.github/workflows/release.yml`；
 *   2. 分发接口 `deploy/dl-release/server.mjs`（公网 `POST /api/v1/release` 落盘名）；
 *   3. 校验器 `scripts/validate-releases-manifest.mjs`（判 `file` 与 `version` 是否同构）。
 *
 * **前缀本身不在这里**：唯一来源是 `config/appIdentity.json` 的 `artifactPrefix`
 * （与 applicationId / label / expectedCertSha256 同一份配置）。本文件只负责「照着前缀拼名字」，
 * 以及「哪些前缀算本仓产物」（历史资产用老前缀，必须继续被认出来）。
 *
 * ## 为什么老前缀还要留着（`LEGACY_ARTIFACT_PREFIXES`）
 *
 * 2026-11 之前的 12 个包在 dl / 62 两台分发机上叫 `deepseek-chat-*.apk`，它们**不改名、不删除**
 * （清单里的 `file` 字段原样保留，客户端按 `file` 下载，见 `src/services/updateManifest.ts`
 * 的 `releaseUrl()` / `downloadTarget()` —— 从来不拿版本号拼文件名）。所以：
 *
 *   - 新产物只用 `artifactPrefix`；
 *   - 「本仓产物」的**识别**必须同时认老前缀 —— 否则 `publish-private-apk.mjs` 的 G4 孤儿检测
 *     （`apk/` 下有包却没登记 = 泄漏了一半）就会对老文件失明，那正是 #601 的形态。
 */

/** 历史产物前缀：只用于**识别**（孤儿检测 / 清理 / 文档），永不用于生成新名字 */
/** @type {readonly string[]} */
export const LEGACY_ARTIFACT_PREFIXES = Object.freeze(['deepseek-chat']);

/** 前缀语法：小写字母/数字打头，允许连字符分段（`jingluo-chat` / `deepseek-chat`） */
export const RE_ARTIFACT_PREFIX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 版本号语法（与 package.json / 清单校验器同口径） */
export const RE_ARTIFACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 前缀**语法**是否合法（`jingluo-chat` ✓ / `Jingluo_Chat` ✗ / `'  jingluo'` ✗）。
 *
 * 「不许拿历史前缀生成新名字」是另一条判据（`isLegacyArtifactPrefix()`）——
 * 改回 `deepseek-chat` 就等于 #836 的改名白做，而且新老包在分发机上混在一处，
 * 人一眼看不出哪个是新的。语法与应用规则分开写，是为了让报错能说清是哪一类。
 * @param {unknown} prefix
 * @returns {boolean}
 */
export const isArtifactPrefix = (prefix) =>
  typeof prefix === 'string' && RE_ARTIFACT_PREFIX.test(prefix);

/** 这个前缀是历史前缀吗（= 只许用来「认」，不许用来「生成」） */
/** @param {unknown} prefix */
export const isLegacyArtifactPrefix = (prefix) =>
  typeof prefix === 'string' && LEGACY_ARTIFACT_PREFIXES.indexOf(prefix) !== -1;

/**
 * 生成产物文件名（不含目录）。
 *
 *   standard：`<prefix>-<version>.apk`（公网清单 / GitHub Release 资产）
 *   internal：`<prefix>-<version>-<variant>-<8位随机>.apk`（私有清单，文件名不可猜测）
 *
 * @param {{prefix:string, version:string, variant?:string|null, suffix?:string|null}} p
 * @returns {string}
 */
export const artifactFileName = ({ prefix, version, variant = null, suffix = null }) => {
  if (!isArtifactPrefix(prefix)) throw new Error(`artifactPrefix 非法：${JSON.stringify(prefix)}`);
  const ver = String(version);
  if (!RE_ARTIFACT_VERSION.test(ver)) throw new Error(`version 格式非法：${ver}`);
  if (variant === null || variant === undefined) return `${prefix}-${ver}.apk`;
  if (!/^[a-z]+$/.test(String(variant))) throw new Error(`variant 非法：${variant}`);
  if (!/^[A-Z2-7]{8}$/.test(String(suffix))) throw new Error(`随机段必须正好 8 个 base32 字符：${suffix}`);
  return `${prefix}-${ver}-${variant}-${suffix}.apk`;
};

/** 清单里 `file` 字段的目录段（站点根下唯一放包的子目录，与 publish-private-apk 的 APK_SUBDIR 同一份） */
export const ARTIFACT_SUBDIR = 'apk';

/** 清单里的 `file` 字段（相对站点根的路径，`apk/<name>.apk`） */
export const artifactFileField = (fileName) => `${ARTIFACT_SUBDIR}/${fileName}`;

/**
 * 这些前缀合起来算「本仓产物」。生成侧只认传入的那一个；识别侧应当传当前 + 历史。
 * @param {string} prefix
 * @param {{includeLegacy?:boolean}} [options]
 * @returns {string[]}
 */
export const artifactPrefixes = (prefix, options = {}) => {
  const includeLegacy = options.includeLegacy !== false;
  if (!isArtifactPrefix(prefix)) throw new Error(`artifactPrefix 非法：${JSON.stringify(prefix)}`);
  if (!includeLegacy) return [prefix];
  return [prefix].concat(LEGACY_ARTIFACT_PREFIXES.filter((p) => p !== prefix));
};

/**
 * 「这个相对路径是不是本仓的 APK 产物」—— 孤儿检测（#609 G4）与清理脚本的判据。
 *
 * 默认同时认历史前缀：老包躺在 `apk/` 下却不在清单里，同样是「已经泄漏了一半」。
 *
 * @param {string} relPath 形如 `apk/<name>.apk`
 * @param {{prefix:string, includeLegacy?:boolean}} options
 * @returns {boolean}
 */
export const isArtifactFile = (relPath, options) =>
  artifactFileRegExp(options).test(String(relPath));

/**
 * 同上，但返回 RegExp（给 `Array.filter` 反复用，省得每次重建）。
 * @param {{prefix:string, includeLegacy?:boolean}} options
 * @returns {RegExp}
 */
export const artifactFileRegExp = (options) => {
  const prefixes = artifactPrefixes(options.prefix, { includeLegacy: options.includeLegacy });
  const dir = options.dir === undefined ? ARTIFACT_SUBDIR : String(options.dir);
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${dir}/(?:${escaped.join('|')})-[A-Za-z0-9._-]+\\.apk$`);
};
