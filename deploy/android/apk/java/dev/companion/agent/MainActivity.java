package dev.companion.agent;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * 唯一的界面：一个 WebView 帧。
 *
 * 没有地址栏、没有浏览器 UI —— 用户看到的直接是 companion-agent 自己的页面
 * （guest 里 node 监听 127.0.0.1:4180）。首启时盖一层原生进度页，
 * 显示解包运行时的进度；就绪后自动切到 WebView。
 *
 * 右上角一个半透明的 "⋯"：不是浏览器，是应用的逃生口
 * （重新载入 / 填 API Key / 看日志 / 重启运行时）。
 */
public final class MainActivity extends Activity implements ServerBus.Listener {

    private static final int REQ_NOTIFICATIONS = 0x91;
    private static final int REQ_AUDIO = 0x92;

    private WebView webView;
    private View splash;
    private TextView status;
    private ProgressBar bar;
    private View keyPanel;
    private EditText keyInput;
    private boolean loaded;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 键盘弹出时**不让系统缩小 WebView**（原来这里是 ADJUST_RESIZE）：
        // 一缩小，页面视口跟着变矮，9:16 的立绘就被压扁——用户实测反馈"点开输入框 UI 变形"。
        // 改成 ADJUST_NOTHING 后键盘改为覆盖在页面上，输入框由页面自己用 visualViewport 抬高
        // （见 app/public/app.js 的 --kb 与 style.css 的 #composer translateY）。
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getResources().getColor(R.color.bg));

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        // 便于用 chrome://inspect 远程调试（用户自己的机器，无额外暴露面）
        WebView.setWebContentsDebuggingEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 外部链接交给系统浏览器；本机地址留在 WebView 里
                if (url != null && (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost"))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Throwable error) {
                    App.log("打不开外部链接 " + url + ": " + error);
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 立绘页的语音入口要麦克风；只有本机页面 + 已授权才放行
                runOnUiThread(() -> {
                    boolean audio = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            audio = true;
                        }
                    }
                    if (audio && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        request.deny();
                    }
                });
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                App.log("[web] " + message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(buildSplash(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView menu = new TextView(this);
        menu.setText("⋯");
        menu.setTextSize(20f);
        menu.setTextColor(getResources().getColor(R.color.muted));
        menu.setGravity(Gravity.CENTER);
        menu.setAlpha(0.55f);
        menu.setOnClickListener(view -> showMenu());
        FrameLayout.LayoutParams menuParams = new FrameLayout.LayoutParams(dp(40), dp(40));
        menuParams.gravity = Gravity.TOP | Gravity.END;
        menuParams.topMargin = dp(28);
        menuParams.rightMargin = dp(6);
        root.addView(menu, menuParams);

        setContentView(root);

        askNotificationPermission();
        CompanionService.ensure(this);
        ServerBus.addListener(this);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private View buildSplash() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(getResources().getColor(R.color.bg));
        column.setGravity(Gravity.CENTER);
        int pad = dp(28);
        column.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(getString(R.string.splash_title));
        title.setTextColor(getResources().getColor(R.color.fg));
        title.setTextSize(20f);
        title.setGravity(Gravity.CENTER);
        column.addView(title);

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setIndeterminate(true);
        LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(6));
        barParams.topMargin = dp(18);
        column.addView(bar, barParams);

        status = new TextView(this);
        status.setText("等待运行时…");
        status.setTextColor(getResources().getColor(R.color.accent));
        status.setTextSize(14f);
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusParams.topMargin = dp(12);
        column.addView(status, statusParams);

        TextView hint = new TextView(this);
        hint.setText(getString(R.string.splash_hint));
        hint.setTextColor(getResources().getColor(R.color.muted));
        hint.setTextSize(12f);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintParams.topMargin = dp(16);
        column.addView(hint, hintParams);

        column.addView(buildKeyPanel());

        Button retry = new Button(this);
        retry.setText(getString(R.string.retry));
        retry.setOnClickListener(view -> ServerBus.restart(MainActivity.this));
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.topMargin = dp(10);
        column.addView(retry, retryParams);

        splash = column;
        return column;
    }

    /** 只有在"本机没有任何凭据"时才露出来：填一次就写进 guest 的 HOME。 */
    private View buildKeyPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams panelParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        panelParams.topMargin = dp(24);
        panel.setLayoutParams(panelParams);
        panel.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText(getString(R.string.key_title));
        title.setTextColor(getResources().getColor(R.color.fg));
        title.setTextSize(15f);
        panel.addView(title);

        keyInput = new EditText(this);
        keyInput.setHint(getString(R.string.key_hint));
        keyInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        keyInput.setTextColor(getResources().getColor(R.color.fg));
        keyInput.setHintTextColor(getResources().getColor(R.color.muted));
        panel.addView(keyInput);

        Button save = new Button(this);
        save.setText(getString(R.string.key_save));
        save.setOnClickListener(view -> saveKey());
        panel.addView(save);

        TextView note = new TextView(this);
        note.setText(getString(R.string.key_note));
        note.setTextColor(getResources().getColor(R.color.muted));
        note.setTextSize(11f);
        note.setGravity(Gravity.CENTER);
        panel.addView(note);

        keyPanel = panel;
        return panel;
    }

    private void saveKey() {
        String value = keyInput.getText().toString().trim();
        if (value.isEmpty()) {
            Toast.makeText(this, "先填一个 key", Toast.LENGTH_SHORT).show();
            return;
        }
        File dir = new File(App.i().homeDir, ".dsh");
        App.mkdirs(dir);
        File env = new File(dir, "companion.env");
        try {
            Files.write(env.toPath(), ("DEEPSEEK_API_KEY=" + value + "\n").getBytes(StandardCharsets.UTF_8));
            App.log("已写入 guest 凭据 " + env);
            keyPanel.setVisibility(View.GONE);
            Toast.makeText(this, "已保存，正在重启运行时", Toast.LENGTH_SHORT).show();
            ServerBus.restart(this);
        } catch (IOException error) {
            App.log("写凭据失败: " + error);
            Toast.makeText(this, "写入失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void showMenu() {
        final String[] items = {"重新载入页面", "重启运行时", "停止运行时", "填写 API Key", "查看日志尾部", "退出应用"};
        new AlertDialog.Builder(this)
                .setTitle("伴侣")
                .setItems(items, (dialog, which) -> {
                    switch (which) {
                        case 0:
                            loaded = false;
                            showWeb();
                            break;
                        case 1:
                            loaded = false;
                            ServerBus.restart(this);
                            break;
                        case 2:
                            CompanionService.stopRuntime(this);
                            break;
                        case 3:
                            keyPanel.setVisibility(View.VISIBLE);
                            splash.setVisibility(View.VISIBLE);
                            break;
                        case 4:
                            showLogTail();
                            break;
                        default:
                            finishAndRemoveTask();
                            break;
                    }
                })
                .show();
    }

    private void showLogTail() {
        File log = new File(App.i().logsDir, "companion.log");
        StringBuilder text = new StringBuilder();
        try {
            if (log.exists()) {
                byte[] all = Files.readAllBytes(log.toPath());
                int from = Math.max(0, all.length - 6000);
                text.append(new String(all, from, all.length - from, StandardCharsets.UTF_8));
            } else {
                text.append("（还没有日志）");
            }
        } catch (IOException error) {
            text.append("读日志失败: ").append(error);
        }
        new AlertDialog.Builder(this)
                .setTitle("日志（尾部）")
                .setMessage(text.toString())
                .setPositiveButton("好", null)
                .show();
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFICATIONS);
        }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        }
    }

    @Override
    public void onServerState(final ServerBus.State state, final String detail) {
        runOnUiThread(() -> {
            if (state == ServerBus.State.RUNNING) {
                status.setText("已就绪");
                showWeb();
                return;
            }
            status.setText(detail == null || detail.isEmpty() ? String.valueOf(state) : detail);
            if (state == ServerBus.State.ERROR) {
                bar.setIndeterminate(false);
                bar.setProgress(100);
            } else {
                bar.setIndeterminate(true);
            }
            if (state == ServerBus.State.PREPARING) {
                splash.setVisibility(View.VISIBLE);
            }
        });
    }

    private void showWeb() {
        if (ServerBus.state() != ServerBus.State.RUNNING) {
            return;
        }
        if (!hasCredential()) {
            keyPanel.setVisibility(View.VISIBLE);
        }
        splash.setVisibility(View.GONE);
        if (!loaded) {
            loaded = true;
            String url = "http://127.0.0.1:" + App.PORT + "/";
            App.log("WebView 打开 " + url);
            webView.loadUrl(url);
        }
    }

    /** guest 的 /root 就是 filesDir/home（bind 挂载），凭据写在宿主侧同一路径。 */
    private boolean hasCredential() {
        File env = new File(new File(App.i().homeDir, ".dsh"), "companion.env");
        if (!env.exists()) {
            return false;
        }
        try {
            String text = new String(Files.readAllBytes(env.toPath()), StandardCharsets.UTF_8);
            return text.contains("DEEPSEEK_API_KEY=") && text.replaceAll("(?m)^\\s*#.*$", "").contains("sk-");
        } catch (IOException error) {
            return false;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ServerBus.state() == ServerBus.State.RUNNING) {
            showWeb();
        }
    }

    @Override
    public void onBackPressed() {
        // 应用式行为：能回退就回退，否则退到后台而不是杀掉运行时
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        ServerBus.removeListener(this);
        super.onDestroy();
    }
}
