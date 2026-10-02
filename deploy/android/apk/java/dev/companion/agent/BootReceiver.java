package dev.companion.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机自启。
 *
 * BOOT_COMPLETED 在 Android 12+ 是"允许从后台启动前台服务"的豁免之一，
 * 所以这里可以直接拉起 CompanionService。
 *
 * 注意（系统约定，不是 bug）：应用装好之后**必须被手动打开过一次**，
 * 才会收到 BOOT_COMPLETED —— 安装后从未启动过的应用处于 stopped 状态。
 */
public final class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        App.log("收到广播: " + action);
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            CompanionService.ensure(context.getApplicationContext());
        }
    }
}
