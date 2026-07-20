package dev.edgecommons.gembatv;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.Random;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class MainActivity extends Activity {
    private static final String PREFS = "gemba-tv";
    private static final String PREF_GATEWAY_URL = "gateway-url";
    private static final String DEFAULT_GATEWAY_URL =
            "ws://192.168.1.224:18445/apps/tv-board/ws";
    private static final String APP_ORIGIN = "https://google-tv.edgecommons.local";
    private static final int PROTOCOL_VERSION = 1;
    private static final String[] CAPABILITIES = {
            "fleet", "events", "signals", "attributes", "alarms"
    };

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Random random = new Random();
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();

    private SharedPreferences preferences;
    private EditText gatewayInput;
    private TextView statusView;
    private TextView envelopeCountView;
    private TextView rateView;
    private TextView frameCountView;
    private TextView reconnectCountView;
    private TextView lastMessageView;
    private TextView lastErrorView;
    private TextView latestUpdateView;

    private WebSocket webSocket;
    private Runnable reconnectRunnable;
    private boolean manualDisconnect;
    private boolean lifecycleStopped = true;
    private int generation;
    private int reconnectAttempt;
    private long reconnects;
    private long envelopes;
    private long frames;
    private long rateWindowStartedAt = SystemClock.elapsedRealtime();
    private long rateWindowEnvelopes;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildUi();
        applyBridgeUrlFromIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (applyBridgeUrlFromIntent(intent)) {
            manualDisconnect = false;
            connect();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        lifecycleStopped = false;
        if (!manualDisconnect) {
            connect();
        }
    }

    @Override
    protected void onStop() {
        lifecycleStopped = true;
        cancelReconnect();
        closeCurrentSocket(1001, "TV app stopped");
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        cancelReconnect();
        closeCurrentSocket(1000, "TV app destroyed");
        super.onDestroy();
    }

    private boolean applyBridgeUrlFromIntent(Intent intent) {
        String supplied = intent == null ? null : intent.getStringExtra("bridgeUrl");
        if (supplied == null || !validGatewayUrl(supplied.trim())) {
            return false;
        }
        String value = supplied.trim();
        gatewayInput.setText(value);
        preferences.edit().putString(PREF_GATEWAY_URL, value).apply();
        return true;
    }

    private void buildUi() {
        int background = Color.rgb(7, 25, 35);
        int panel = Color.rgb(13, 38, 49);
        int border = Color.rgb(36, 69, 83);
        int primary = Color.rgb(54, 194, 180);
        int muted = Color.rgb(158, 181, 194);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(44), dp(32), dp(44), dp(24));
        root.setBackgroundColor(background);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text("Dallas Gemba Board", 36, Color.WHITE, true);
        header.addView(title, weighted(1));
        statusView = text("Starting", 20, Color.WHITE, true);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(24), dp(12), dp(24), dp(12));
        setStatus("Starting", false, false);
        header.addView(statusView, wrap());
        root.addView(header, matchWrap());

        View accent = new View(this);
        accent.setBackgroundColor(primary);
        LinearLayout.LayoutParams accentParams = match(dp(5));
        accentParams.setMargins(0, dp(16), 0, dp(20));
        root.addView(accent, accentParams);

        LinearLayout metricsRow = new LinearLayout(this);
        metricsRow.setOrientation(LinearLayout.HORIZONTAL);
        envelopeCountView = metricCard(metricsRow, "UPDATE ENVELOPES", panel, border);
        rateView = metricCard(metricsRow, "CURRENT RATE", panel, border);
        frameCountView = metricCard(metricsRow, "FRAMES OBSERVED", panel, border);
        reconnectCountView = metricCard(metricsRow, "RECONNECTS", panel, border);
        root.addView(metricsRow, matchWrap());

        LinearLayout details = new LinearLayout(this);
        details.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams detailsParams = match(0);
        detailsParams.weight = 1;
        detailsParams.setMargins(0, dp(20), 0, 0);
        root.addView(details, detailsParams);

        LinearLayout connectionPanel = panel(panel, border);
        LinearLayout.LayoutParams connectionParams = weighted(42);
        connectionParams.setMargins(0, 0, dp(12), 0);
        details.addView(connectionPanel, connectionParams);
        connectionPanel.addView(text("Connection", 24, Color.WHITE, true), matchWrap());

        TextView gatewayLabel = text("Gateway WebSocket URL", 15, muted, false);
        LinearLayout.LayoutParams labelParams = matchWrap();
        labelParams.setMargins(0, dp(16), 0, dp(6));
        connectionPanel.addView(gatewayLabel, labelParams);

        gatewayInput = new EditText(this);
        gatewayInput.setSingleLine(true);
        gatewayInput.setTextColor(background);
        gatewayInput.setTextSize(17);
        gatewayInput.setSelectAllOnFocus(true);
        gatewayInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        gatewayInput.setText(preferences.getString(PREF_GATEWAY_URL, DEFAULT_GATEWAY_URL));
        gatewayInput.setBackground(rounded(Color.rgb(236, 245, 248), primary, 2, 8));
        gatewayInput.setPadding(dp(12), dp(9), dp(12), dp(9));
        connectionPanel.addView(gatewayInput, matchWrap());

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams buttonsParams = matchWrap();
        buttonsParams.setMargins(0, dp(12), 0, dp(14));
        connectionPanel.addView(buttons, buttonsParams);

        Button connectButton = button("Save and connect", Color.rgb(22, 123, 114));
        connectButton.setOnClickListener(view -> {
            manualDisconnect = false;
            connect();
        });
        LinearLayout.LayoutParams buttonParams = weighted(1);
        buttonParams.setMargins(0, 0, dp(8), 0);
        buttons.addView(connectButton, buttonParams);

        Button disconnectButton = button("Disconnect", Color.rgb(77, 101, 112));
        disconnectButton.setOnClickListener(view -> {
            manualDisconnect = true;
            cancelReconnect();
            closeCurrentSocket(1000, "User disconnected");
            setStatus("Disconnected", false, false);
        });
        buttons.addView(disconnectButton, weighted(1));

        connectionPanel.addView(keyValue("Client", "Native Android / OkHttp", muted), matchWrap());
        connectionPanel.addView(keyValue("Origin header", APP_ORIGIN, muted), matchWrap());
        lastMessageView = keyValue("Last message", "None", muted);
        connectionPanel.addView(lastMessageView, matchWrap());
        lastErrorView = keyValue("Last error", "None", muted);
        connectionPanel.addView(lastErrorView, matchWrap());

        LinearLayout payloadPanel = panel(panel, border);
        LinearLayout.LayoutParams payloadParams = weighted(58);
        payloadParams.setMargins(dp(12), 0, 0, 0);
        details.addView(payloadPanel, payloadParams);
        payloadPanel.addView(text("Latest update", 24, Color.WHITE, true), matchWrap());

        latestUpdateView = text("Waiting for the gateway...", 14, Color.rgb(213, 237, 242), false);
        latestUpdateView.setTypeface(Typeface.MONOSPACE);
        latestUpdateView.setTextIsSelectable(true);
        ScrollView payloadScroll = new ScrollView(this);
        payloadScroll.addView(latestUpdateView, matchWrap());
        LinearLayout.LayoutParams scrollParams = match(0);
        scrollParams.weight = 1;
        scrollParams.setMargins(0, dp(12), 0, 0);
        payloadPanel.addView(payloadScroll, scrollParams);

        TextView footer = text(
                "D-pad selects controls. Native ping every 15 seconds. Gateway delivery ceiling: 30 Hz.",
                14,
                muted,
                false
        );
        footer.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams footerParams = matchWrap();
        footerParams.setMargins(0, dp(14), 0, 0);
        root.addView(footer, footerParams);

        setContentView(root);
        envelopeCountView.setText("0");
        rateView.setText("0.0 Hz");
        frameCountView.setText("0");
        reconnectCountView.setText("0");
    }

    private TextView metricCard(LinearLayout row, String label, int background, int border) {
        LinearLayout card = panel(background, border);
        card.setPadding(dp(18), dp(14), dp(18), dp(14));
        card.addView(text(label, 14, Color.rgb(158, 181, 194), false), matchWrap());
        TextView value = text("0", 31, Color.WHITE, true);
        LinearLayout.LayoutParams valueParams = matchWrap();
        valueParams.setMargins(0, dp(8), 0, 0);
        card.addView(value, valueParams);
        LinearLayout.LayoutParams cardParams = weighted(1);
        cardParams.setMargins(dp(5), 0, dp(5), 0);
        row.addView(card, cardParams);
        return value;
    }

    private LinearLayout panel(int background, int border) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(22), dp(20), dp(22), dp(20));
        panel.setBackground(rounded(background, border, 1, 12));
        return panel;
    }

    private TextView keyValue(String key, String value, int muted) {
        TextView view = text(key + ":  " + value, 15, Color.WHITE, false);
        view.setPadding(0, dp(5), 0, dp(5));
        view.setContentDescription(key);
        view.setTag(key);
        return view;
    }

    private Button button(String label, int color) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(16);
        button.setAllCaps(false);
        button.setFocusable(true);
        button.setBackground(rounded(color, Color.rgb(255, 207, 74), 0, 8));
        return button;
    }

    private TextView text(String value, int sizeSp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        }
        return view;
    }

    private GradientDrawable rounded(int fill, int stroke, int strokeWidthDp, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeWidthDp > 0) {
            drawable.setStroke(dp(strokeWidthDp), stroke);
        }
        return drawable;
    }

    private void connect() {
        String url = gatewayInput.getText().toString().trim();
        if (!validGatewayUrl(url)) {
            setLastError("Enter a ws:// or wss:// gateway URL.");
            gatewayInput.requestFocus();
            return;
        }

        preferences.edit().putString(PREF_GATEWAY_URL, url).apply();
        cancelReconnect();
        closeCurrentSocket(1001, "Reconnecting");
        manualDisconnect = false;
        int connectionGeneration = ++generation;
        setStatus("Connecting", false, true);
        setLastError("None");

        Request request = new Request.Builder()
                .url(url)
                .header("Origin", APP_ORIGIN)
                .build();
        webSocket = client.newWebSocket(request, new GembaListener(connectionGeneration));
    }

    private final class GembaListener extends WebSocketListener {
        private final int connectionGeneration;

        private GembaListener(int connectionGeneration) {
            this.connectionGeneration = connectionGeneration;
        }

        private boolean active() {
            return connectionGeneration == generation && !lifecycleStopped;
        }

        @Override
        public void onOpen(WebSocket socket, Response response) {
            if (!active()) {
                socket.cancel();
                return;
            }
            post(() -> setStatus("Handshaking", false, true));
            socket.send(helloFrame());
        }

        @Override
        public void onMessage(WebSocket socket, String text) {
            if (!active()) {
                return;
            }
            try {
                JSONObject message = new JSONObject(text);
                String type = message.optString("type", "unknown");
                post(() -> setLastMessage(type));
                if ("welcome".equals(type)) {
                    reconnectAttempt = 0;
                    post(() -> setStatus("Live", true, false));
                    socket.send(subscribeFrame());
                } else if ("updates".equals(type)) {
                    JSONArray updateFrames = message.optJSONArray("frames");
                    int frameDelta = updateFrames == null ? 0 : updateFrames.length();
                    post(() -> recordUpdate(text, frameDelta));
                } else if ("error".equals(type)) {
                    String error = message.optString("code", "gateway-error") + ": "
                            + message.optString("message", text);
                    post(() -> setLastError(error));
                }
            } catch (JSONException error) {
                post(() -> setLastError("Invalid JSON: " + error.getMessage()));
            }
        }

        @Override
        public void onClosing(WebSocket socket, int code, String reason) {
            socket.close(code, reason);
        }

        @Override
        public void onClosed(WebSocket socket, int code, String reason) {
            if (active()) {
                post(() -> {
                    setLastError("Closed " + code + (reason.isEmpty() ? "" : ": " + reason));
                    scheduleReconnect();
                });
            }
        }

        @Override
        public void onFailure(WebSocket socket, Throwable error, Response response) {
            if (active()) {
                String detail = response == null
                        ? error.getClass().getSimpleName() + ": " + error.getMessage()
                        : "HTTP " + response.code() + ": " + error.getMessage();
                post(() -> {
                    setLastError(detail);
                    scheduleReconnect();
                });
            }
        }
    }

    private String helloFrame() {
        try {
            return new JSONObject()
                    .put("type", "hello")
                    .put("protocolVersion", PROTOCOL_VERSION)
                    .toString();
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private String subscribeFrame() {
        try {
            JSONArray requested = new JSONArray();
            for (String capability : CAPABILITIES) {
                requested.put(capability);
            }
            return new JSONObject()
                    .put("type", "subscribe")
                    .put("protocolVersion", PROTOCOL_VERSION)
                    .put("capabilities", requested)
                    .toString();
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void recordUpdate(String payload, int frameDelta) {
        envelopes += 1;
        frames += frameDelta;
        rateWindowEnvelopes += 1;
        long now = SystemClock.elapsedRealtime();
        long elapsed = now - rateWindowStartedAt;
        if (elapsed >= 1000) {
            double rate = rateWindowEnvelopes * 1000.0 / elapsed;
            rateView.setText(String.format(Locale.US, "%.1f Hz", rate));
            rateWindowStartedAt = now;
            rateWindowEnvelopes = 0;
        }
        envelopeCountView.setText(String.valueOf(envelopes));
        frameCountView.setText(String.valueOf(frames));
        latestUpdateView.setText(payload.length() <= 12000
                ? payload
                : payload.substring(0, 12000) + "\n... truncated for TV rendering ...");
    }

    private void scheduleReconnect() {
        if (manualDisconnect || lifecycleStopped || reconnectRunnable != null) {
            return;
        }
        long base = Math.min(30000L, 1000L << Math.min(reconnectAttempt, 5));
        long delay = base + random.nextInt(500);
        reconnectAttempt += 1;
        reconnects += 1;
        reconnectCountView.setText(String.valueOf(reconnects));
        setStatus("Retry in " + ((delay + 999) / 1000) + "s", false, true);
        reconnectRunnable = () -> {
            reconnectRunnable = null;
            connect();
        };
        mainHandler.postDelayed(reconnectRunnable, delay);
    }

    private void cancelReconnect() {
        if (reconnectRunnable != null) {
            mainHandler.removeCallbacks(reconnectRunnable);
            reconnectRunnable = null;
        }
    }

    private void closeCurrentSocket(int code, String reason) {
        generation += 1;
        WebSocket current = webSocket;
        webSocket = null;
        if (current != null && !current.close(code, reason)) {
            current.cancel();
        }
    }

    private void setStatus(String text, boolean connected, boolean connecting) {
        statusView.setText(text);
        int fill = connected
                ? Color.rgb(29, 131, 72)
                : connecting ? Color.rgb(154, 103, 0) : Color.rgb(161, 43, 49);
        statusView.setBackground(rounded(fill, Color.TRANSPARENT, 0, 28));
    }

    private void setLastMessage(String type) {
        lastMessageView.setText("Last message:  " + type);
    }

    private void setLastError(String error) {
        lastErrorView.setText("Last error:  " + (error == null ? "Unknown" : error));
    }

    private void post(Runnable runnable) {
        mainHandler.post(runnable);
    }

    private boolean validGatewayUrl(String value) {
        return value.startsWith("ws://") || value.startsWith("wss://");
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private LinearLayout.LayoutParams match(int height) {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, height);
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private LinearLayout.LayoutParams weighted(float weight) {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, weight);
    }
}
