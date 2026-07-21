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
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Native Android TV (Sony / Google TV) OEE dashboard for the Dallas FILLING line (gw-fill-01).
 * Consumes the edge-console app-WebSocket signal stream over OkHttp and binds it to large,
 * at-a-distance-legible TV tiles. The gateway delivers all site signals; this board scopes to the
 * filling device and normalizes the delta channel-path to the short signal name.
 */
public final class MainActivity extends Activity {
    private static final String PREFS = "gemba-tv";
    private static final String PREF_GATEWAY_URL = "gateway-url";
    private static final String DEFAULT_GATEWAY_URL = "ws://192.168.1.224:8080/apps/tv-board/ws";
    private static final String APP_ORIGIN = "https://google-tv.edgecommons.local";
    private static final int PROTOCOL_VERSION = 1;
    private static final String[] CAPABILITIES = {"signals", "alarms"};
    private static final String LINE_DEVICE = "gw-fill-01";

    // Colours
    private static final int BG = Color.rgb(20, 20, 34);
    private static final int PANEL = Color.rgb(31, 33, 52);
    private static final int INK_ON_DARK = Color.WHITE;
    private static final int MUTED = Color.rgb(150, 156, 184);
    private static final int SAFETY = Color.rgb(234, 181, 69);
    private static final int GOODC = Color.rgb(116, 195, 152);
    private static final int COPPER = Color.rgb(214, 122, 78);

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();

    private SharedPreferences preferences;
    private String gatewayUrl = DEFAULT_GATEWAY_URL;

    private TextView statusView;
    private TextView clockView;
    private final Map<String, TextView> valueViews = new LinkedHashMap<>();
    private final SimpleDateFormat clockFmt = new SimpleDateFormat("HH:mm:ss", Locale.US);

    private WebSocket webSocket;
    private Runnable reconnectRunnable;
    private boolean manualDisconnect;
    private boolean lifecycleStopped = true;
    private int generation;
    private int reconnectAttempt;
    private long lastDataAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        gatewayUrl = preferences.getString(PREF_GATEWAY_URL, DEFAULT_GATEWAY_URL);
        applyBridgeUrlFromIntent(getIntent());
        buildUi();
        startClock();
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
        gatewayUrl = supplied.trim();
        preferences.edit().putString(PREF_GATEWAY_URL, gatewayUrl).apply();
        return true;
    }

    // ----------------------------------------------------------------- UI

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(52), dp(36), dp(52), dp(36)); // TV overscan-safe
        root.setBackgroundColor(BG);

        // Header is fixed at the top; the OEE band and the production grid divide ALL the
        // remaining height by weight, so the board fills the panel exactly — no bottom clip on a
        // dense panel, no dead band on a sparse one — regardless of the TV's reported density.
        root.addView(header(), mw());
        root.addView(oeeBand(), rowWeight(dp(22), 1.05f));
        root.addView(productionGrid(), rowWeight(dp(20), 1.95f));

        setContentView(root);
        setStatus("Connecting…", SAFETY);
    }

    private View header() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.VERTICAL);
        brand.addView(text("BOTTLES R US", 34, INK_ON_DARK, true), wc());
        brand.addView(text("DALLAS · FILLING HALL", 20, MUTED, true), wc());
        header.addView(brand, weight(1));

        TextView line = text("LINE 01", 40, SAFETY, true);
        line.setPadding(dp(28), 0, dp(28), 0);
        header.addView(line, wc());

        LinearLayout right = new LinearLayout(this);
        right.setOrientation(LinearLayout.VERTICAL);
        right.setGravity(Gravity.END);
        statusView = text("Connecting…", 26, SAFETY, true);
        clockView = text("--:--:--", 30, INK_ON_DARK, true);
        right.addView(clockView, wc());
        right.addView(statusView, wc());
        header.addView(right, wc());
        return header;
    }

    private View oeeBand() {
        LinearLayout band = new LinearLayout(this);
        band.setOrientation(LinearLayout.HORIZONTAL);

        // Hero OEE tile
        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER);
        hero.setPadding(dp(24), dp(22), dp(24), dp(22));
        hero.setBackground(rounded(SAFETY, SAFETY, 0, 16));
        hero.addView(text("OEE", 30, Color.rgb(88, 68, 21), true), wc());
        TextView oee = text("--", 118, Color.rgb(35, 35, 61), true);
        oee.setGravity(Gravity.CENTER);
        autoSize(oee, 48, 132);
        valueViews.put("OEE", oee);
        hero.addView(oee, fillCell(0));
        band.addView(hero, weightMargins(34, 0, 0, dp(14), 0));

        band.addView(oeePart("AVAILABILITY", "Availability"), weightMargins(22, dp(14), 0, dp(14), 0));
        band.addView(oeePart("PERFORMANCE", "Performance"), weightMargins(22, dp(14), 0, dp(14), 0));
        band.addView(oeePart("QUALITY", "Quality"), weightMargins(22, dp(14), 0, 0, 0));
        return band;
    }

    private View oeePart(String label, String signal) {
        LinearLayout p = panel();
        p.setGravity(Gravity.CENTER_VERTICAL);
        p.addView(text(label, 22, MUTED, true), wc());
        TextView v = text("--", 64, INK_ON_DARK, true);
        v.setGravity(Gravity.CENTER_VERTICAL);
        autoSize(v, 34, 72);
        p.addView(v, fillCell(dp(6)));
        valueViews.put(signal, v);
        return p;
    }

    private View productionGrid() {
        // Two equal-weight rows so the eight tiles split the grid's height evenly and grow with it.
        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        grid.addView(tileRow(new String[][]{
                {"LINE SPEED", "LineSpeedBpm", "BPM"},
                {"GOOD BOTTLES", "GoodBottleCount", ""},
                {"FILL PRESSURE", "FillPressureKpa", "kPa"},
                {"FILL VOLUME", "FillVolumeMl", "mL"}
        }), rowWeight(0, 1f));
        grid.addView(tileRow(new String[][]{
                {"BOWL LEVEL", "BowlLevelPct", "%"},
                {"PRODUCT TEMP", "ProductTempC", "°C"},
                {"FILLER STATE", "FillerState", ""},
                {"REJECTS", "RejectCount", ""}
        }), rowWeight(dp(18), 1f));
        return grid;
    }

    private View tileRow(String[][] specs) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < specs.length; i++) {
            String[] s = specs[i];
            LinearLayout tile = panel();
            tile.addView(text(s[0], 24, MUTED, true), wc());
            LinearLayout valRow = new LinearLayout(this);
            valRow.setOrientation(LinearLayout.HORIZONTAL);
            valRow.setGravity(Gravity.BOTTOM);
            TextView v = text("--", 54, INK_ON_DARK, true);
            v.setGravity(Gravity.BOTTOM);
            autoSize(v, 30, 58);
            // value takes the cell width (bounded for autosize); the unit sits beside it
            LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
            valRow.addView(v, vlp);
            if (!s[2].isEmpty()) {
                TextView unit = text("  " + s[2], 26, MUTED, false);
                valRow.addView(unit, wc());
            }
            tile.addView(valRow, fillCell(dp(10)));
            valueViews.put(s[1], v);
            int rm = (i == specs.length - 1) ? 0 : dp(16);
            row.addView(tile, weightMargins(1, 0, 0, rm, 0));
        }
        return row;
    }

    private LinearLayout panel() {
        LinearLayout p = new LinearLayout(this);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setPadding(dp(26), dp(22), dp(26), dp(22));
        p.setBackground(rounded(PANEL, Color.rgb(52, 54, 83), 1, 14));
        return p;
    }

    // ---------------------------------------------------------------- signals

    private void handleUpdates(JSONArray frames) {
        if (frames == null) {
            return;
        }
        for (int i = 0; i < frames.length(); i++) {
            JSONObject frame = frames.optJSONObject(i);
            if (frame == null) {
                continue;
            }
            String type = frame.optString("type");
            if ("signals".equals(type)) {
                JSONArray series = frame.optJSONArray("series");
                for (int j = 0; series != null && j < series.length(); j++) {
                    JSONObject item = series.optJSONObject(j);
                    if (item != null && isFillingLine(item)) {
                        ingest(item.optString("name", null), item.opt("latest"));
                    }
                }
            } else if ("signal".equals(type)) {
                JSONArray updates = frame.optJSONArray("updates");
                for (int j = 0; updates != null && j < updates.length(); j++) {
                    JSONObject item = updates.optJSONObject(j);
                    if (item == null || !isFillingLine(item)) {
                        continue;
                    }
                    Object value = null;
                    JSONObject point = item.optJSONObject("point");
                    if (point != null) {
                        value = point.opt("value");
                    }
                    ingest(normSignal(item.optString("signal", null)), value);
                }
            }
        }
    }

    private boolean isFillingLine(JSONObject item) {
        JSONObject key = item.optJSONObject("key");
        return key != null && LINE_DEVICE.equals(key.optString("device"));
    }

    /** Snapshot series carry the short display name; deltas carry `signal` as a channel PATH that
     *  differs per adapter — modbus: bare name; OPC UA: full nodeId; OEE: gemba/oee/&lt;metric&gt;. */
    private static String normSignal(String s) {
        if (s == null) {
            return null;
        }
        if (s.contains("gemba/oee/")) {
            String seg = s.substring(s.lastIndexOf('/') + 1);
            switch (seg) {
                case "availability": return "Availability";
                case "overall": return "OEE";
                case "performance": return "Performance";
                case "quality": return "Quality";
                default: return seg;
            }
        }
        int dot = s.lastIndexOf('.');
        return dot >= 0 ? s.substring(dot + 1) : s;
    }

    private void ingest(String name, Object value) {
        if (name == null || value == null) {
            return;
        }
        final TextView view = valueViews.get(name);
        if (view == null) {
            return;
        }
        final String out = format(name, value);
        lastDataAt = SystemClock.elapsedRealtime();
        post(() -> {
            view.setText(out);
            setStatus("Live", GOODC);
        });
    }

    private static String format(String name, Object value) {
        switch (name) {
            case "GoodBottleCount":
            case "RejectCount":
                return commas(value);
            case "LineSpeedBpm":
            case "BowlLevelPct":
                return String.format(Locale.US, "%.0f", toDouble(value));
            case "FillerState":
                return String.valueOf(value);
            default: // OEE, Availability, Performance, Quality, FillPressureKpa, FillVolumeMl, ProductTempC
                return String.format(Locale.US, "%.1f", toDouble(value));
        }
    }

    private static double toDouble(Object value) {
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException error) {
            return 0.0;
        }
    }

    private static String commas(Object value) {
        return String.format(Locale.US, "%,d", (long) toDouble(value));
    }

    // ---------------------------------------------------------------- transport

    private void connect() {
        if (!validGatewayUrl(gatewayUrl)) {
            return;
        }
        cancelReconnect();
        closeCurrentSocket(1001, "Reconnecting");
        manualDisconnect = false;
        int connectionGeneration = ++generation;
        post(() -> setStatus("Connecting…", SAFETY));
        Request request = new Request.Builder()
                .url(gatewayUrl)
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
                if ("welcome".equals(type)) {
                    reconnectAttempt = 0;
                    socket.send(subscribeFrame());
                    post(() -> setStatus("Live · max 30/s", GOODC));
                } else if ("updates".equals(type)) {
                    JSONArray frames = message.optJSONArray("frames");
                    post(() -> handleUpdates(frames));
                }
            } catch (JSONException ignored) {
                // Skip malformed frames; the stream continues.
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
                    setStatus("Reconnecting…", SAFETY);
                    scheduleReconnect();
                });
            }
        }

        @Override
        public void onFailure(WebSocket socket, Throwable error, Response response) {
            if (active()) {
                post(() -> {
                    setStatus("Reconnecting…", SAFETY);
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

    private void scheduleReconnect() {
        if (reconnectRunnable != null || manualDisconnect || lifecycleStopped) {
            return;
        }
        long delay = Math.min(15000, 2000L * (long) Math.pow(2, Math.min(reconnectAttempt++, 3)));
        reconnectRunnable = () -> {
            reconnectRunnable = null;
            if (!manualDisconnect && !lifecycleStopped) {
                connect();
            }
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
        WebSocket current = webSocket;
        webSocket = null;
        if (current != null) {
            current.close(code, reason);
        }
    }

    private boolean validGatewayUrl(String url) {
        return url != null && (url.startsWith("ws://") || url.startsWith("wss://"));
    }

    // ---------------------------------------------------------------- misc

    private void startClock() {
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (clockView != null) {
                    clockView.setText(clockFmt.format(new Date()));
                }
                // stalled-socket watchdog: if live but silent for 12s, force a reconnect
                if (webSocket != null && lastDataAt != 0
                        && SystemClock.elapsedRealtime() - lastDataAt > 12000
                        && !lifecycleStopped && !manualDisconnect) {
                    setStatus("Reconnecting…", SAFETY);
                    closeCurrentSocket(1001, "stalled");
                    scheduleReconnect();
                    lastDataAt = 0;
                }
                mainHandler.postDelayed(this, 1000);
            }
        };
        mainHandler.post(tick);
    }

    private void setStatus(String label, int color) {
        if (statusView != null) {
            statusView.setText(label);
            statusView.setTextColor(color);
        }
    }

    private void post(Runnable action) {
        mainHandler.post(action);
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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private LinearLayout.LayoutParams mw() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams wc() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    /** Full-width child that takes a weighted share of its parent's height (the vertical-fill seam). */
    private LinearLayout.LayoutParams rowWeight(int top, float w) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, w);
        lp.topMargin = top;
        return lp;
    }

    /** Full-width child that fills the remaining height of its (bounded) cell — gives an autosizing
     *  value a concrete box to scale into, so the big numbers grow to fill without ever clipping. */
    private LinearLayout.LayoutParams fillCell(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        lp.topMargin = top;
        return lp;
    }

    /** Legible-but-bounded: one line, scaled uniformly to the largest size that fits the cell. */
    private void autoSize(TextView v, int minSp, int maxSp) {
        v.setMaxLines(1);
        v.setAutoSizeTextTypeUniformWithConfiguration(minSp, maxSp, 2, TypedValue.COMPLEX_UNIT_SP);
    }

    private LinearLayout.LayoutParams weight(float w) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, w);
        return lp;
    }

    private LinearLayout.LayoutParams weightMargins(float w, int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.MATCH_PARENT, w);
        lp.setMargins(l, t, r, b);
        return lp;
    }
}
