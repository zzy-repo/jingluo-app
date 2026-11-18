package com.example.deepseekchat;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 用系统浏览器（ACTION_VIEW）打开收银台。
 *
 * 只放行 https：支付页必须是加密连接，明文地址既不安全也可能被中间人替换。
 * 插件本身不校验业务参数、不拼 URL —— 收银台地址一律由服务端下发。
 */
@CapacitorPlugin(name = "CheckoutBrowser")
public class CheckoutBrowserPlugin extends Plugin {

  @PluginMethod
  public void open(PluginCall call) {
    String url = call.getString("url", "");
    if (url == null || !url.startsWith("https://")) {
      call.reject("checkout-url-must-be-https");
      return;
    }
    try {
      Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      JSObject result = new JSObject();
      result.put("opened", true);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("no-browser-available", error);
    }
  }
}
