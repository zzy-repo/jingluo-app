# 应用图标（#266）

| 文件 | 说明 |
| --- | --- |
| `source.png` | 源图原样存档（1254×1254，白底 + 深色圆角方块），由提出者贴在 #266 评论区 |
| `icon-512.png` | 512×512 商店/分享用主稿（full-bleed 深色，四角已填深色，无白像素） |

## 重新生成

```bash
python scripts/gen-app-icon.py   # 需要本机 Python 3 + Pillow + numpy，非构建依赖
```

脚本会把产物直接写进 `android/app/src/main/res/`：

- `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`：legacy 48/72/96/144/192px 圆角方块（形状取自源图 flood fill 的真实 squircle 轮廓）
- `mipmap-*/ic_launcher_foreground.png`：自适应图标前景，透明背景的鲸鱼图形，内容占画布 68%（官方安全区 66%–72%）
- `mipmap-*/ic_launcher_round.png`：圆形 legacy 图标
- `values/ic_launcher_background.xml`：自适应图标背景纯色 `#0F162F`（源图边缘实测中位色）

## 校验

```bash
pnpm run check:icon   # 四边各 2px 的 (r>245 && g>245 && b>245) 像素数必须为 0
```

## 已知未验证边界

- 桌面实际观感（深色/浅色壁纸）、圆形遮罩下的尾鳍完整性**未在设备上肉眼确认**：本次按范围收窄不做模拟器验收，白边与安全区由脚本与像素统计保证。
- 圆形遮罩在国产 ROM（方形/泪滴等自定义遮罩）上未测；Android 7 及以下 legacy png 的实际观感未真机确认。
