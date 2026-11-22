#!/usr/bin/env node
/**
 * artifact-name.mjs —— 打印产物文件名（Issue #836 scope ①）
 *
 * 存在的理由：`.github/workflows/release.yml` 里曾经直接写 `apk="deepseek-chat-${version}.apk"`，
 * 那就是「目录里第二份硬编码前缀」—— CI 改漏了，GitHub Release 资产名就和线上清单不一致，
 * 而两边都还能跑绿。现在 CI 只调这个 CLI，前缀始终来自 `config/appIdentity.json`。
 *
 * 用法（标准包 = 公网清单 / GitHub Release 资产）：
 *   node scripts/artifact-name.mjs --version 1.5.0
 *   → jingluo-chat-1.5.0.apk
 *
 * 私有（internal）包带变体与 8 位随机段（见 scripts/publish-private-apk.mjs）：
 *   node scripts/artifact-name.mjs --version 1.5.0 --variant internal --suffix HJ5NWRHQ
 *   → jingluo-chat-1.5.0-internal-HJ5NWRHQ.apk
 *
 * 清单 `file` 字段（要的是 `apk/<name>.apk` 不是裸名时）：
 *   node scripts/artifact-name.mjs --version 1.5.0 --field
 *   → apk/jingluo-chat-1.5.0.apk
 *
 * 只打印前缀（shell 里要自己拼别的尾巴时用）：
 *   node scripts/artifact-name.mjs --prefix
 *   → jingluo-chat
 *
 * 退出码：0 成功；2 参数/配置问题（前缀读不到就**不打印任何名字**——
 * 让 CI 在「猜一个名字」之前就失败，而不是把错名字写进发布记录）。
 */
import { buildArtifactFileName, artifactFileField, artifactPrefix } from './lib/artifactName.mjs';

const USAGE = `用法: node scripts/artifact-name.mjs --version <x.y.z[-suffix]>
                               [--variant internal --suffix <8位base32>] [--field | --prefix]

  --prefix            只打印前缀（来自 config/appIdentity.json 的 artifactPrefix）
  --field             打印清单里的 file 字段（apk/<name>.apk）
`;

/**
 * 极简参数解析（不引第三方依赖，与其它脚本同风格）
 * @param {string[]} argv
 */
const parseArgs = (argv) => {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      out.flags.add('help');
      continue;
    }
    if (token === '--prefix' || token === '--field') {
      out.flags.add(token.slice(2));
      continue;
    }
    if (token === '--version' || token === '--variant' || token === '--suffix') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${token} 缺值`);
      out.values[token.slice(2)] = value;
      i += 1;
      continue;
    }
    throw new Error(`不认的参数：${token}`);
  }
  return out;
};

const main = (argv) => {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    if (args.flags.has('prefix')) {
      process.stdout.write(`${artifactPrefix()}\n`);
      return 0;
    }
    if (!args.values.version) {
      console.error(`缺 --version\n\n${USAGE}`);
      return 2;
    }
    const name = buildArtifactFileName({
      version: args.values.version,
      variant: args.values.variant,
      suffix: args.values.suffix,
    });
    process.stdout.write(`${args.flags.has('field') ? artifactFileField(name) : name}\n`);
    return 0;
  } catch (error) {
    // 配置/参数问题一律 exit 2：让调用方（CI / 发布脚本）在「名字还没算出来」时停下
    console.error(`${error.message}`);
    return 2;
  }
};

process.exitCode = main(process.argv.slice(2));
