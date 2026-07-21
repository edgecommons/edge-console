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
 *
 * A composed industrial HMI in the same visual language as the packaging board: a light "paper"
 * theme with dark ink header + OEE band, numbered titled sections (01 FILL LINE / 02 FILL QUALITY /
 * 03 THROUGHPUT) that break the screen into areas of focus, and a rotary-filler-ring hero anchoring
 * the right column. Driven live from the edge-console app-WebSocket, scoped to the filling device.
 */
public final class MainActivity extends Activity {
    private static final String PREFS = "gemba-tv";
    private static final String PREF_GATEWAY_URL = "gateway-url";
    private static final String DEFAULT_GATEWAY_URL = "ws://192.168.1.224:8080/apps/tv-board/ws";
    private static final String APP_ORIGIN = "https://google-tv.edgecommons.local";
    private static final int PROTOCOL_VERSION = 1;
    private static final String[] CAPABILITIES = {"signals", "alarms"};
    private static final String LINE_DEVICE = "gw-fill-01";

    // Palette — the packaging board's light industrial HMI theme
    private static final int PAPER = Color.rgb(246, 243, 235);
    private static final int PANEL = Color.rgb(255, 253, 248);
    private static final int INK = Color.rgb(35, 35, 61);
    private static final int LINE = Color.rgb(217, 216, 209);
    private static final int MUTED = Color.rgb(111, 112, 128);
    private static final int SAFETY = Color.rgb(234, 181, 69);
    private static final int COPPER = Color.rgb(214, 122, 78);
    private static final int GOOD = Color.rgb(63, 143, 105);
    private static final int DANGER = Color.rgb(189, 77, 86);
    private static final int ON_INK = Color.rgb(232, 232, 240);
    private static final int ON_INK_MUTED = Color.rgb(160, 162, 186);

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

    // Graphical elements
    private TankGaugeView bowlGauge;
    private ArcGaugeView pressureGauge;
    private ArcGaugeView volumeGauge;
    private FillerRingView fillerRing;
    private BarMeterView rejectBar;
    private LinearLayout fillerStep;
    private TextView fillerStepState;

    private long good = -1, overfill = -1, underfill = -1;

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
        root.setPadding(dp(44), dp(22), dp(44), dp(22));
        root.setBackgroundColor(PAPER);

        root.addView(header(), mw());
        root.addView(oeeBand(), rowWeight(dp(14), 1.42f));
        root.addView(content(), rowWeight(dp(14), 4.0f));
        root.addView(footer(), rowWeight(dp(12), 0.46f));

        setContentView(root);
        setStatus("Connecting…", SAFETY);
    }

    private View header() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(22), dp(10), dp(22), dp(10));
        header.setBackground(rounded(INK, INK, 0, 14));

        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.VERTICAL);
        brand.addView(text("BOTTLES R US", 28, ON_INK, true), wc());
        brand.addView(text("DALLAS · FILLING HALL", 16, ON_INK_MUTED, true), wc());
        header.addView(brand, weight(1));

        TextView line = text("LINE 01", 34, SAFETY, true);
        line.setPadding(dp(22), 0, dp(22), 0);
        header.addView(line, wc());

        LinearLayout right = new LinearLayout(this);
        right.setOrientation(LinearLayout.VERTICAL);
        right.setGravity(Gravity.END);
        clockView = text("--:--:--", 24, ON_INK, true);
        statusView = text("Connecting…", 20, SAFETY, true);
        right.addView(clockView, wc());
        right.addView(statusView, wc());
        header.addView(right, wc());
        return header;
    }

    private View oeeBand() {
        LinearLayout band = new LinearLayout(this);
        band.setOrientation(LinearLayout.HORIZONTAL);
        band.setPadding(dp(14), dp(8), dp(14), dp(8));
        band.setBackground(rounded(INK, INK, 0, 14));

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER);
        hero.setPadding(dp(16), dp(6), dp(16), dp(6));
        hero.setBackground(rounded(SAFETY, SAFETY, 0, 12));
        hero.addView(text("OEE", 22, Color.rgb(88, 68, 21), true), wc());
        TextView oee = text("--", 42, INK, true);
        oee.setGravity(Gravity.CENTER);
        autoSize(oee, 28, 42);
        valueViews.put("OEE", oee);
        hero.addView(oee, fillCell(0));
        band.addView(hero, weightMargins(1.1f, 0, 0, dp(12), 0));

        band.addView(oeePart("AVAILABILITY", "Availability"), weightMargins(1, 0, 0, 0, 0));
        band.addView(oeePart("PERFORMANCE", "Performance"), weightMargins(1, 0, 0, 0, 0));
        band.addView(oeePart("QUALITY", "Quality"), weightMargins(1, 0, 0, 0, 0));
        return band;
    }

    private View oeePart(String label, String signal) {
        LinearLayout p = new LinearLayout(this);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setPadding(dp(18), dp(6), dp(18), dp(6));
        TextView lbl = text(label, 18, ON_INK_MUTED, true);
        autoSize(lbl, 13, 18);
        LinearLayout.LayoutParams lblLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.addView(lbl, lblLp);
        TextView v = text("--", 44, ON_INK, true);
        v.setGravity(Gravity.CENTER_VERTICAL);
        autoSize(v, 22, 46);
        valueViews.put(signal, v);
        p.addView(v, fillCell(dp(2)));
        return p;
    }

    // --- the main content: three numbered sections on the left, the filler-ring hero on the right ---
    private View content() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);

        // LEFT — two roomy titled sections: the fill line and the fill-quality gauges
        LinearLayout ops = new LinearLayout(this);
        ops.setOrientation(LinearLayout.VERTICAL);

        LinearLayout s1 = section("01", "FILL LINE");
        s1.addView(processFlow(), rowWeight(dp(8), 1f));
        ops.addView(s1, rowWeight(0, 1.4f));

        LinearLayout s2 = section("02", "FILL QUALITY");
        s2.addView(qualityRow(), rowWeight(dp(8), 1f));
        ops.addView(s2, rowWeight(dp(12), 1.55f));

        row.addView(ops, weightMargins(1.55f, 0, 0, dp(16), 0));

        // RIGHT — the filler-ring hero, with throughput + rejects beneath it
        row.addView(heroAside(), weightMargins(1.0f, 0, 0, 0, 0));
        return row;
    }

    /** A numbered section: "01 · FILL LINE" heading floating above its content (like the pack board). */
    private LinearLayout section(String num, String title) {
        LinearLayout s = new LinearLayout(this);
        s.setOrientation(LinearLayout.VERTICAL);
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView badge = text(num, 15, INK, true);
        badge.setBackground(rounded(SAFETY, SAFETY, 0, 6));
        badge.setPadding(dp(8), dp(1), dp(8), dp(1));
        head.addView(badge, wc());
        TextView t = text("  " + title, 20, INK, true);
        head.addView(t, wc());
        s.addView(head, mw());
        return s;
    }

    // --- 01 flow: the line-stage schematic. Stages with live sim data show it (infeed at the
    //     depalletizer, filler state, cap rejects at the capper); the rinser and labeler emit no
    //     signals in this sim, so they read a static "Running". ---
    private View processFlow() {
        LinearLayout flow = new LinearLayout(this);
        flow.setOrientation(LinearLayout.HORIZONTAL);
        flow.setGravity(Gravity.CENTER_VERTICAL);
        // {badge, name, initial metric, live signal or null}
        String[][] steps = {
                {"A", "DEPALLETIZER", "Feeding", "InfeedStarved"},
                {"B", "RINSER", "Running", null},
                {"C", "FILLER", "Running", "FillerState"},
                {"D", "CAPPER", "0 rej", "CapRejectCount"},
                {"E", "LABELER", "Running", null},
        };
        for (int i = 0; i < steps.length; i++) {
            flow.addView(flowCard(steps[i][0], steps[i][1], steps[i][2], steps[i][3]), weight(1));
            if (i < steps.length - 1) {
                TextView chev = text("›", 26, Color.rgb(160, 160, 160), true);
                chev.setPadding(dp(3), 0, dp(3), 0);
                flow.addView(chev, wc());
            }
        }
        return flow;
    }

    /** A vertical stage card: badge, full-width name (fits any card width), and a live metric line. */
    private LinearLayout flowCard(String idx, String name, String metricInit, String signal) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(8), dp(8), dp(8), dp(8));
        card.setBackground(rounded(PANEL, LINE, 1, 12));

        TextView badge = text(idx, 15, PANEL, true);
        badge.setGravity(Gravity.CENTER);
        badge.setBackground(rounded(GOOD, GOOD, 0, 7));
        badge.setPadding(dp(10), dp(1), dp(10), dp(1));
        card.addView(badge, wc());

        TextView nameV = text(name, 14, INK, true);
        nameV.setMaxLines(1);
        nameV.setGravity(Gravity.CENTER);
        autoSize(nameV, 8, 14);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nlp.topMargin = dp(4);
        card.addView(nameV, nlp);

        TextView metricV = text(metricInit, 12, MUTED, false);
        metricV.setMaxLines(1);
        metricV.setGravity(Gravity.CENTER);
        card.addView(metricV, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        if ("FillerState".equals(signal)) {
            fillerStep = card;
            fillerStepState = metricV;
        } else if (signal != null) {
            valueViews.put(signal, metricV);
        }
        return card;
    }

    // --- 02 fill quality: bowl tank + pressure + volume gauges ---
    private View qualityRow() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        bowlGauge = new TankGaugeView(this);
        bowlGauge.setLabel("BOWL LEVEL");
        bowlGauge.setLowThreshold(35);
        r.addView(card(bowlGauge), weightMargins(1.2f, 0, 0, dp(12), 0));

        pressureGauge = new ArcGaugeView(this);
        pressureGauge.setRange(90, 150);
        pressureGauge.setBand(108, 126);
        pressureGauge.config("FILL PRESSURE", "kPa");
        r.addView(card(pressureGauge), weightMargins(1, dp(12), 0, dp(12), 0));

        volumeGauge = new ArcGaugeView(this);
        volumeGauge.setRange(485, 515);
        volumeGauge.setBand(498, 502);
        volumeGauge.config("FILL VOLUME", "mL");
        r.addView(card(volumeGauge), weightMargins(1, dp(12), 0, 0, 0));
        return r;
    }

    // --- hero aside: rotary filler ring, then throughput + rejects beneath it ---
    private View heroAside() {
        LinearLayout aside = new LinearLayout(this);
        aside.setOrientation(LinearLayout.VERTICAL);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView badge = text("LIVE", 15, PANEL, true);
        badge.setBackground(rounded(GOOD, GOOD, 0, 6));
        badge.setPadding(dp(8), dp(1), dp(8), dp(1));
        head.addView(badge, wc());
        head.addView(text("  FILL CAROUSEL", 20, INK, true), wc());
        aside.addView(head, mw());

        fillerRing = new FillerRingView(this);
        LinearLayout ringCard = panel();
        ringCard.addView(fillerRing, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));
        aside.addView(ringCard, rowWeight(dp(8), 1.9f));

        // shift tally: good and rejects with their numbers aligned across the panel, over a single
        // bar that spans both — green good · copper overfill · blue underfill — with a legend to match.
        LinearLayout shift = panel();

        LinearLayout hr = new LinearLayout(this);
        hr.setOrientation(LinearLayout.HORIZONTAL);
        hr.addView(text("GOOD BOTTLES", 15, MUTED, true), weight(1));
        hr.addView(text("REJECTS", 15, MUTED, true), wc());
        shift.addView(hr, mw());

        LinearLayout nr = new LinearLayout(this);
        nr.setOrientation(LinearLayout.HORIZONTAL);
        nr.setGravity(Gravity.CENTER_VERTICAL);
        TextView goodV = text("--", 34, GOOD, true);
        goodV.setMaxLines(1);
        autoSize(goodV, 20, 34);
        valueViews.put("GoodBottleCount", goodV);
        nr.addView(goodV, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView rejTot = text("--", 34, INK, true);
        rejTot.setMaxLines(1);
        rejTot.setGravity(Gravity.END);
        autoSize(rejTot, 20, 34);
        valueViews.put("RejectCount", rejTot);
        nr.addView(rejTot, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams nrp = mw();
        nrp.topMargin = dp(2);
        shift.addView(nr, nrp);

        // one yield bar spanning both metrics: green good · copper overfill · blue underfill
        rejectBar = new BarMeterView(this);
        LinearLayout.LayoutParams yb = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(16));
        yb.topMargin = dp(12);
        shift.addView(rejectBar, yb);
        TextView cap = text("first-pass yield", 13, MUTED, false);
        LinearLayout.LayoutParams cl = mw();
        cl.topMargin = dp(6);
        shift.addView(cap, cl);
        aside.addView(shift, rowWeight(dp(10), 1.25f));
        return aside;
    }

    private View footer() {
        LinearLayout foot = new LinearLayout(this);
        foot.setOrientation(LinearLayout.HORIZONTAL);
        foot.setGravity(Gravity.CENTER_VERTICAL);
        foot.setPadding(dp(16), dp(6), dp(16), dp(6));
        foot.setBackground(rounded(PANEL, LINE, 1, 12));
        View stripe = new View(this);
        stripe.setBackground(rounded(SAFETY, SAFETY, 0, 3));
        LinearLayout.LayoutParams st = new LinearLayout.LayoutParams(dp(8), dp(30));
        st.rightMargin = dp(16);
        foot.addView(stripe, st);
        foot.addView(readout("PRODUCT TEMP", "ProductTempC", "°C"), weight(1));
        foot.addView(readout("CO₂ VOLUMES", "CO2Volumes", "vol"), weight(1));
        foot.addView(readout("VALVE TRACKING", "ValveTrackingCount", ""), weight(1));
        foot.addView(readout("CONVEYOR", "ConveyorSpeedPct", "%"), weight(1));
        return foot;
    }

    private View readout(String label, String signal, String unit) {
        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.HORIZONTAL);
        cell.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = text(label, 14, MUTED, true);
        name.setMaxLines(1);
        LinearLayout.LayoutParams nl = wc();
        nl.rightMargin = dp(8);
        cell.addView(name, nl);
        TextView v = text("--", 18, INK, true);
        v.setMaxLines(1);
        valueViews.put(signal, v);
        cell.addView(v, wc());
        if (!unit.isEmpty()) {
            TextView u = text(unit, 13, MUTED, false);
            LinearLayout.LayoutParams up = wc();
            up.leftMargin = dp(4);
            cell.addView(u, up);
        }
        return cell;
    }

    /** Wrap a custom view in a light bordered card. */
    private View card(View child) {
        LinearLayout p = panel();
        p.addView(child, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));
        return p;
    }

    private LinearLayout panel() {
        LinearLayout p = new LinearLayout(this);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setPadding(dp(16), dp(9), dp(16), dp(9));
        p.setBackground(rounded(PANEL, LINE, 1, 14));
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
                        ingest(normSignal(item.optString("name", null)), item.opt("latest"));
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
        lastDataAt = SystemClock.elapsedRealtime();
        final TextView view = valueViews.get(name);
        final String out = view != null ? format(name, value) : null;
        final double d = toDouble(value);
        final String raw = String.valueOf(value);
        post(() -> {
            if (view != null && out != null) {
                view.setText(out);
            }
            bindGraphic(name, raw, d);
            setStatus("Live", GOOD);
        });
    }

    private void bindGraphic(String name, String raw, double d) {
        switch (name) {
            case "BowlLevelPct":
                if (bowlGauge != null) bowlGauge.setLevel((float) d);
                break;
            case "FillPressureKpa":
                if (pressureGauge != null) pressureGauge.setValue((float) d);
                break;
            case "FillVolumeMl":
                if (volumeGauge != null) volumeGauge.setValue((float) d);
                break;
            case "LineSpeedBpm":
                if (fillerRing != null) fillerRing.setRate((float) d);
                break;
            case "GoodBottleCount":
                good = (long) d;
                updateTally();
                break;
            case "OverfillRejectCount":
                overfill = (long) d;
                updateTally();
                break;
            case "UnderfillRejectCount":
                underfill = (long) d;
                updateTally();
                break;
            case "FillerState":
                updateFiller(raw);
                break;
            default:
                break;
        }
    }

    private void updateTally() {
        if (rejectBar == null) return;
        long g = Math.max(0, good), o = Math.max(0, overfill), u = Math.max(0, underfill);
        long t = g + o + u;
        if (t <= 0) return;
        rejectBar.set(new float[]{(float) g / t, (float) o / t, (float) u / t},
                new int[]{GOOD, COPPER, Color.rgb(90, 150, 200)});
    }

    private void updateFiller(String state) {
        if (fillerStep == null) return;
        boolean running = "RUNNING".equalsIgnoreCase(state);
        boolean stopped = state != null && (state.toUpperCase(Locale.US).contains("STOP")
                || state.toUpperCase(Locale.US).contains("FAULT"));
        int accent = running ? GOOD : (stopped ? DANGER : SAFETY);
        fillerStep.setBackground(rounded(running ? PANEL : Color.rgb(253, 247, 233), accent,
                running ? 1 : 2, 12));
        TextView badge = (TextView) fillerStep.getChildAt(0);
        badge.setBackground(rounded(accent, accent, 0, 8));
        if (fillerStepState != null) {
            fillerStepState.setText(pretty(state));
        }
        if (fillerRing != null) fillerRing.setRunning(!stopped);
    }

    private static String pretty(String s) {
        if (s == null || s.isEmpty()) return "—";
        String t = s.replace('_', ' ').toLowerCase(Locale.US);
        return Character.toUpperCase(t.charAt(0)) + t.substring(1);
    }

    private static String format(String name, Object value) {
        switch (name) {
            case "GoodBottleCount":
            case "RejectCount":
            case "OverfillRejectCount":
            case "UnderfillRejectCount":
            case "ValveTrackingCount":
                return commas(value);
            case "CapRejectCount":
                return commas(value) + " rej";
            case "LineSpeedBpm":
            case "ConveyorSpeedPct":
                return String.format(Locale.US, "%.0f", toDouble(value));
            case "CO2Volumes":
                return String.format(Locale.US, "%.2f", toDouble(value));
            case "InfeedStarved":
                return Boolean.parseBoolean(String.valueOf(value)) ? "Starved" : "Feeding";
            case "FillerState":
                return pretty(String.valueOf(value));
            default: // OEE, Availability, Performance, Quality, ProductTempC
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
                    post(() -> setStatus("Live · max 30/s", GOOD));
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

    private LinearLayout.LayoutParams rowWeight(int top, float w) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, w);
        lp.topMargin = top;
        return lp;
    }

    private LinearLayout.LayoutParams fillCell(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        lp.topMargin = top;
        return lp;
    }

    private LinearLayout.LayoutParams weight(float w) {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, w);
    }

    private LinearLayout.LayoutParams weightMargins(float w, int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.MATCH_PARENT, w);
        lp.setMargins(l, t, r, b);
        return lp;
    }

    /** Legible-but-bounded: one line, scaled uniformly to the largest size that fits, with headroom. */
    private void autoSize(TextView v, int minSp, int maxSp) {
        v.setMaxLines(1);
        int pv = dp(2);
        v.setPadding(v.getPaddingLeft(), pv, v.getPaddingRight(), pv);
        v.setAutoSizeTextTypeUniformWithConfiguration(minSp, maxSp, 2, TypedValue.COMPLEX_UNIT_SP);
    }
}
