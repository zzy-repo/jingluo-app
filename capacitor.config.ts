import type { CapacitorConfig } from '@capacitor/cli';
import { readFileSync } from 'node:fs';

// 应用标识（包名 / 应用名）的唯一来源是仓库根 config/appIdentity.json（Issue #271）。
// 这里的 appId / appName 以前是第 2、第 3 份副本：改包名时漏改一处，Capacitor 生成的原生工程
// 就和 android/app/build.gradle 对不上（桌面名不一致 / 脚本去 adb 查一个不存在的包）。
//
// 为什么是「同步读 + JSON.parse」而不是 import 断言：
//   - @capacitor/cli 用 ts.transpileModule 把本文件转成 CommonJS 再 require（见 cli/dist/util/node.js
//     的 requireTS），import 断言在各种 Node/TypeScript 组合下不通用；
//   - 也不能用 __dirname / import.meta.url：前者在原生 ESM 加载路径下不存在，后者在 CJS 下不存在；
//   - CLI 加载配置时把 process.cwd() 当作 appRootDir（cli/dist/config.js loadConfig），
//     所以相对路径就是项目根 —— build-apk.sh 也是在仓库根跑 `npx cap sync android`。
const identity = JSON.parse(readFileSync('config/appIdentity.json', 'utf8')) as {
  applicationId: string;
  label: { zh: string; en: string };
};

const config: CapacitorConfig = {
  appId: identity.applicationId,
  appName: identity.label.zh,
  webDir: 'dist',
  android: {
    allowMixedContent: true
  }
};

export default config;
