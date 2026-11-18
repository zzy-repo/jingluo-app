package com.example.deepseekchat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(ExportTextPlugin.class);
        registerPlugin(DiagnosticsDevicePlugin.class);
        registerPlugin(CheckoutBrowserPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
