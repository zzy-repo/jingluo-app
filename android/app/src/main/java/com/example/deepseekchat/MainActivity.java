package com.example.deepseekchat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(ExportTextPlugin.class);
        registerPlugin(CheckoutBrowserPlugin.class);
        registerPlugin(DiagnosticsDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
