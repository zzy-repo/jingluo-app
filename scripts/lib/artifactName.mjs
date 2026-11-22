#!/usr/bin/env node
/**
 * artifactName.mjs —— 安装包产物文件名的**唯一入口**（Issue #836 scope ①）。
 *
 * 分工：
 *   - `shared/artifact-name.mjs`  纯函数（怎么拼、哪些算本仓产物），零依赖、可被 deploy/ 单独拷走；
 *   - 本模块                     把纯函数**绑到唯一来源** `config/appIdentity.json` 的 `artifactPrefix`；
 *   - 所有生产者（发布脚本 / CI / 分发接口）只许走这两个之一，**不许再写字面量**。
 *
 * 为什么前缀要去配置文件里读：这次改名（`deepseek-chat` → `jingluo-chat`）只动了产物名，
 * 应用显示名与 applicationId 都还没定，将来那两项也要「一处改」。把产物前缀跟它们放在同一份
 * `config/appIdentity.json` 里，维护者改一处就能同时看到三件事的现状。
 *
 * 历史前缀（`deepseek-chat`）只用于**识别**：dl / 62 两台分发机上已有的 12 个老包不改名、
 * 不删除，清单里老条目的 `file` 原样保留（客户端按 `file` 下载，从不拿版本号拼名字）。
 * 所以孤儿检测这类「哪些文件是本仓产物」的判据必须**同时认老前缀**，见 `apkArtifactRegExp()`。
 */
import {
  LEGACY_ARTIFACT_PREFIXES,
  RE_ARTIFACT_PREFIX,
  RE_ARTIFACT_VERSION,
  artifactFileField,
  artifactFileName,
  artifactFileRegExp,
  artifactPrefixes,
  isArtifactFile,
  isArtifactPrefix,
  isLegacyArtifactPrefix,
} from '../../shared/artifact-name.mjs';
import { APP_IDENTITY_REL_PATH, loadAppIdentity } from './appIdentity.mjs';

export {
  LEGACY_ARTIFACT_PREFIXES,
  RE_ARTIFACT_PREFIX,
  RE_ARTIFACT_VERSION,
  artifactFileField,
  artifactFileName,
  artifactFileRegExp,
  artifactPrefixes,
  isArtifactFile,
  isArtifactPrefix,
  isLegacyArtifactPrefix,
  APP_IDENTITY_REL_PATH,
};

/**
 * 当前产物前缀（唯一来源：`config/appIdentity.json` 的 `artifactPrefix`）。
 * 读不到 / 不合法 → 抛 AppIdentityError（不猜默认值：猜出来的名字会静默写进线上清单）。
 * @param {string} [root]
 * @returns {string}
 */
export const artifactPrefix = (root) => loadAppIdentity(root).artifactPrefix;

/**
 * 生成产物文件名（不含目录），前缀来自配置。
 * @param {{version:string, variant?:string|null, suffix?:string|null, root?:string}} p
 * @returns {string}
 */
export const buildArtifactFileName = (p) =>
  artifactFileName({
    prefix: artifactPrefix(p.root),
    version: p.version,
    variant: p.variant === undefined ? null : p.variant,
    suffix: p.suffix === undefined ? null : p.suffix,
  });

/**
 * 「本仓产物」的判据（当前前缀 + 历史前缀），返回 RegExp。
 * 孤儿检测用它：老包躺在 `apk/` 下却没登记 = 已经泄漏了一半，不能因为改了前缀就失明。
 * @param {string} [root]
 * @returns {RegExp}
 */
export const apkArtifactRegExp = (root) => artifactFileRegExp({ prefix: artifactPrefix(root) });

/**
 * 同上的函数式判据。
 * @param {string} relPath
 * @param {string} [root]
 * @returns {boolean}
 */
export const isRepoArtifactFile = (relPath, root) =>
  isArtifactFile(relPath, { prefix: artifactPrefix(root) });
