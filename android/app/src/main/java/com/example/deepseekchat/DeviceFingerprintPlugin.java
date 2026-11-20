package com.example.deepseekchat;

import android.media.MediaDrm;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

/**
 * 设备指纹：客户端这一半（Issue #243）。
 *
 * <p>为什么单独一个插件、而不是塞进 {@link DiagnosticsDevicePlugin}：那个插件的契约写在类注释里
 * ——「never reads identifiers」，还有一条单测按文件扫 {@code ANDROID_ID|IMEI|MAC|phone|location}，
 * 保证诊断上传里永远不出现标识。指纹是**身份**，诊断是**事实**，两者混在一个类里，
 * 迟早有人顺手把标识塞进诊断日志。所以：诊断插件一个字节不动，身份的事放这里，
 * 名字也直说（{@code DeviceFingerprint}）。
 *
 * <p>为什么客户端要报这个：{@code POST /apply} 按 device_id 发 100 积分（≈¥1，立刻能花），
 * 而 device_id 是客户端自己生成、存在 localStorage 里的字符串（见 services/invite/device.ts）
 * —— 清应用数据 / 改 localStorage / 脚本随机值都能无限领。真正的止血在服务端（按「指纹 ∪ IP」
 * 双维度限流 + 历史数据迁移绑定），客户端唯一能做、也只该做的是**如实上报一个用户改不动的
 * 设备指纹**，让服务端将来有得可判。判定「是不是新人」是服务端的事，客户端一个字都不判。
 *
 * <p>三条实现纪律：
 * <ul>
 *   <li><b>先哈希再出去</b>：只回 {@code sha256(小写(ANDROID_ID) + 包名)} 的 64 位小写十六进制。
 *       ANDROID_ID 明文不出本方法，JS 侧根本拿不到，也就不可能进日志 / 诊断上传 / 错误文案。
 *       包名参与哈希：同一台机器上不同 App（含分身）不会串号。</li>
 *   <li><b>拿不到就是拿不到，别猜</b>：没有 ANDROID_ID、或者它是老设备那个人人相同的常量、
 *       或者哈希失败，一律回 {@code available=false} + 一个可诊断的 reason。JS 侧照常注册
 *       （绝不阻塞），只留一条「无指纹」信号 —— 降级到纯 IP 限流，比卡住用户强。</li>
 *   <li><b>MediaDrm 只当可选增强位</b>：拿得到 {@code PROPERTY_DEVICE_UNIQUE_ID} 时把 strength
 *       标成 {@code strong}，拿不到就是 {@code base}，**不因为取不到而失败**（模拟器 / 无
 *       Widevine 的机器都属正常）。它<b>不参与哈希</b>：Widevine 密钥箱状态会在系统升级 /
 *       恢复出厂后变化，拌进哈希会让同一台机器突然变成「新设备」，反而白送一次重新领取 ——
 *       指纹的首要性质是稳定，其次才是熵。原始 ID 也绝不回给 JS，只回一个强度枚举。</li>
 * </ul>
 *
 * <p>返回形状（永远 {@code resolve}，永不 {@code reject}）：
 * {@code { available: true, deviceFp, strength, source }} 或
 * {@code { available: false, reason }}, reason ∈
 * {@code android_id_missing | android_id_placeholder | hash_failed}。
 *
 * <p><b>服务端现状</b>（2026-11 实测，证据贴在 Issue #243）：{@code invite/1.0} 目前不认识
 * 指纹，CORS 允许头只有 {@code Content-Type} 与旧设备码头，同一枚指纹换 3 个新设备码照样
 * 各发 100 分。所以这一段是「能力就绪」，不是「漏洞已堵」。
 */
@CapacitorPlugin(name = "DeviceFingerprint")
public class DeviceFingerprintPlugin extends Plugin {

    /** Widevine 的 UUID：用来问 MediaDrm「这台机器有没有设备级密钥」。 */
    private static final UUID WIDEVINE_UUID = UUID.fromString("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed");

    /**
     * 老设备（Android 8.0 之前）上人人相同的 ANDROID_ID。它不是标识而是常量，
     * 拿它算指纹等于给所有这类机器发同一枚指纹 —— 比没有指纹更坏，所以当没有处理。
     */
    private static final String ANDROID_ID_PLACEHOLDER = "9774d56d682e549c";

    /**
     * 读设备指纹。{@code call.resolve} 恒定成功；拿不到指纹用 {@code available=false} 表达，
     * 让 JS 侧走降级分支，而不是让一次注册卡在一个 reject 上。
     */
    @PluginMethod
    public void deviceFingerprint(PluginCall call) {
        JSObject out = new JSObject();
        String raw;
        try {
            raw = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Exception error) {
            raw = null;
        }
        String androidId = raw == null ? "" : raw.trim().toLowerCase(Locale.US);
        if (androidId.isEmpty()) {
            out.put("available", false);
            out.put("reason", "android_id_missing");
            call.resolve(out);
            return;
        }
        if (ANDROID_ID_PLACEHOLDER.equals(androidId)) {
            out.put("available", false);
            out.put("reason", "android_id_placeholder");
            call.resolve(out);
            return;
        }
        try {
            out.put("available", true);
            out.put("deviceFp", sha256Hex(androidId + getContext().getPackageName()));
            out.put("strength", hasWidevineDeviceId() ? "strong" : "base");
            out.put("source", "Settings.Secure.ANDROID_ID+PackageManager");
            call.resolve(out);
        } catch (Exception error) {
            // 理论上不存在（Android 一定带 SHA-256），但也不能因此挡住注册
            out.put("available", false);
            out.put("reason", "hash_failed");
            call.resolve(out);
        }
    }

    /** SHA-256 → 小写十六进制。手写而不引第三方库：这里不值得为一行哈希多一个依赖。 */
    private static String sha256Hex(String text) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) {
            int unsigned = value & 0xFF;
            hex.append(Character.forDigit(unsigned >>> 4, 16));
            hex.append(Character.forDigit(unsigned & 0x0F, 16));
        }
        return hex.toString();
    }

    /**
     * MediaDrm 有没有设备级唯一 ID（Widevine）。取不到 / 机型不支持 / 模拟器一律 false，
     * 只用来给指纹标 strength：不改哈希、不抛给调用方、原始 ID 不出本方法。
     */
    private static boolean hasWidevineDeviceId() {
        MediaDrm drm = null;
        try {
            drm = new MediaDrm(WIDEVINE_UUID);
            byte[] id = drm.getPropertyByteArray(MediaDrm.PROPERTY_DEVICE_UNIQUE_ID);
            return id != null && id.length > 0;
        } catch (Exception error) {
            return false;
        } finally {
            if (drm != null) {
                try {
                    // close() 是 API 28+，minSdkVersion 是 24，旧机上只能 release()
                    if (Build.VERSION.SDK_INT >= 28) {
                        drm.close();
                    } else {
                        drm.release();
                    }
                } catch (Exception ignored) {
                    // 释放失败不影响「有没有 ID」这个结论
                }
            }
        }
    }
}
