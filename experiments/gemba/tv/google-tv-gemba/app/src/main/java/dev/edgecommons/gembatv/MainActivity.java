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
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Native Android TV (Sony / Google TV) OEE board for the Dallas FILLING line (gw-fill-01).
 *
 * A flat "broadsheet" HMI: full-width bands separated by hairline/ink rules (no rounded cards), a
 * strict measure/typography system, and colour used only where it means something. Header · OEE
 * band · status band · content (fill line + fill quality | line speed + reject split) · line-health
 * footer. Driven live from the edge-console app-WebSocket, scoped to the filling device.
 */
public final class MainActivity extends Activity {
    private static final String PREFS = "gemba-tv";
    private static final String PREF_GATEWAY_URL = "gateway-url";
    private static final String DEFAULT_GATEWAY_URL = "ws://192.168.1.224:8080/apps/tv-board/ws";
    private static final String APP_ORIGIN = "https://google-tv.edgecommons.local";
    private static final int PROTOCOL_VERSION = 1;
    private static final String[] CAPABILITIES = {"signals", "alarms"};
    private static final String LINE_DEVICE = "gw-fill-01";
    private static final float TARGET_BPM = 132f; // 60000 / idealCycleMs(454.545)

    // Semantic palette — one meaning each
    private static final int PAPER = Color.rgb(246, 243, 235);
    private static final int PANEL = Color.rgb(255, 253, 248);
    private static final int INK = Color.rgb(35, 35, 61);
    private static final int LINE = Color.rgb(217, 216, 209);
    private static final int MUTED = Color.rgb(111, 112, 128);
    private static final int SAFETY = Color.rgb(234, 181, 69);
    private static final int SAFETY_INK = Color.rgb(88, 68, 21);
    private static final int GOOD = Color.rgb(63, 143, 105);
    private static final int DANGER = Color.rgb(189, 77, 86);
    private static final int COPPER = Color.rgb(214, 122, 78);
    private static final int IRIS = Color.rgb(93, 105, 168);
    private static final int CARTON = Color.rgb(200, 149, 82);
    private static final int ON_INK = Color.WHITE;
    private static final int ON_INK_MUTED = Color.rgb(184, 185, 200);
    private static final int INK_HAIR = Color.rgb(77, 78, 105);
    private static final int TINT_SAFETY = Color.rgb(253, 247, 233);
    private static final int TINT_DANGER = Color.rgb(247, 231, 229);

    private Typeface cond;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();

    private SharedPreferences preferences;
    private String gatewayUrl = DEFAULT_GATEWAY_URL;

    private TextView statusView;
    private TextView clockView;
    private View statusDot;
    // One signal may drive several displays (e.g. FillPressureKpa feeds both the FILLER stage tile
    // and the fill-quality spec bullet), so each key maps to a list of views.
    private final Map<String, List<TextView>> valueViews = new LinkedHashMap<>();
    private final SimpleDateFormat clockFmt = new SimpleDateFormat("HH:mm:ss", Locale.US);

    // graphical + composite elements
    private TankGaugeView tank;
    private BulletBarView pressureBullet, volumeBullet, tempBullet, co2Bullet;
    private BarMeterView splitBar;
    private TextView rateValue, rateDelta, healthEStop, healthConv, healthInfeed;
    private LinearLayout infeedTile, fillerTile, capperTile;
    private View infeedBar, fillerBar, capperBar;
    private TextView statusWord, statusSub, goodSub, oeeVal, rateTargetSub;
    private View oeeAccent, healthStripe;
    private BulletBarView rateBullet;

    private long good = -1, rejects = -1, overfill = -1, underfill = -1, cap = -1;
    private boolean running = true, eStop = true, convRun = true, infeedStarved = false;

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
        cond = Typeface.create("sans-serif-condensed", Typeface.BOLD);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        gatewayUrl = preferences.getString(PREF_GATEWAY_URL, DEFAULT_GATEWAY_URL);
        applyBridgeUrlFromIntent(getIntent());
        buildUi();
        startClock();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (applyBridgeUrlFromIntent(intent)) { manualDisconnect = false; connect(); }
    }

    @Override protected void onStart() {
        super.onStart();
        lifecycleStopped = false;
        if (!manualDisconnect) connect();
    }

    @Override protected void onStop() {
        lifecycleStopped = true;
        cancelReconnect();
        closeCurrentSocket(1001, "TV app stopped");
        super.onStop();
    }

    @Override protected void onDestroy() {
        cancelReconnect();
        closeCurrentSocket(1000, "TV app destroyed");
        super.onDestroy();
    }

    private boolean applyBridgeUrlFromIntent(Intent intent) {
        String supplied = intent == null ? null : intent.getStringExtra("bridgeUrl");
        if (supplied == null || !validGatewayUrl(supplied.trim())) return false;
        gatewayUrl = supplied.trim();
        preferences.edit().putString(PREF_GATEWAY_URL, gatewayUrl).apply();
        return true;
    }

    // ----------------------------------------------------------------- UI

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(20));
        root.setBackgroundColor(PAPER);

        root.addView(rule(4, SAFETY));
        root.addView(header(), band(44));
        root.addView(oeeBand(), band(58));
        root.addView(rule(2, SAFETY));
        root.addView(statusBand(), band(52));
        root.addView(rule(1, LINE));
        root.addView(gap(10));
        root.addView(content(), band(274)); // fixed height so nested MATCH_PARENT columns resolve
        root.addView(gap(8));
        root.addView(rule(2, INK));
        root.addView(footer(), band(42));

        setContentView(root);
        setConn("CONNECTING", SAFETY);
    }

    // Band 1 — header: logo glyph + name | LINE 01 | clock + state
    private LinearLayout header() {
        LinearLayout h = row(Gravity.CENTER_VERTICAL);
        h.setBackgroundColor(INK);
        h.setPadding(dp(20), 0, dp(20), 0);

        // Left group in a weight-1 cell, and the right group in another, so the identity block
        // between them sits at the true screen centre regardless of the side groups' widths.
        LinearLayout left = row(Gravity.CENTER_VERTICAL);
        // brand mark: a filled bottle-cap disc over a body bar — reads as packaging, not signal bars
        LinearLayout glyph = new LinearLayout(this);
        glyph.setOrientation(LinearLayout.HORIZONTAL);
        glyph.setGravity(Gravity.CENTER_VERTICAL);
        View cap = new View(this);
        cap.setBackground(dot(SAFETY));
        glyph.addView(cap, new LinearLayout.LayoutParams(dp(12), dp(12)));
        View body = new View(this);
        body.setBackgroundColor(COPPER);
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(dp(6), dp(22));
        bl.leftMargin = dp(3);
        glyph.addView(body, bl);
        left.addView(glyph, wc());

        LinearLayout name = col();
        LinearLayout.LayoutParams nlp = wc();
        nlp.leftMargin = dp(10);
        TextView brand = new TextView(this);
        brand.setText("BOTTLES R US");
        brand.setTypeface(cond);
        brand.setTextSize(17);
        brand.setTextColor(ON_INK);
        brand.setLetterSpacing(0.08f);
        name.addView(brand, wc());
        name.addView(micro("DALLAS · FILLING HALL", ON_INK_MUTED, 9), wc());
        left.addView(name, nlp);
        h.addView(left, weight(1));

        // centred masthead identity: LINE / FILLING stacked, big 01 to its right
        LinearLayout lineCell = row(Gravity.CENTER_VERTICAL);
        LinearLayout lblStack = col();
        lblStack.addView(micro("LINE", ON_INK_MUTED, 11), wc());
        LinearLayout.LayoutParams f2 = wc();
        f2.topMargin = dp(1);
        lblStack.addView(micro("FILLING", ON_INK_MUTED, 11), f2);
        lineCell.addView(lblStack, wc());
        TextView ln = new TextView(this);
        ln.setText("01");
        ln.setTypeface(cond);
        ln.setTextSize(34);
        ln.setTextColor(ON_INK);
        LinearLayout.LayoutParams llp = wc();
        llp.leftMargin = dp(12);
        lineCell.addView(ln, llp);
        h.addView(lineCell, wc());

        LinearLayout right = col();
        right.setGravity(Gravity.END);
        clockView = new TextView(this);
        clockView.setText("--:--:--");
        clockView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        clockView.setTextSize(16);
        clockView.setTextColor(ON_INK);
        right.addView(clockView, wc());
        LinearLayout st = row(Gravity.CENTER_VERTICAL);
        statusDot = new View(this);
        statusDot.setBackground(dot(SAFETY));
        LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(dp(7), dp(7));
        dl.rightMargin = dp(6);
        st.addView(statusDot, dl);
        statusView = micro("CONNECTING", SAFETY, 10);
        st.addView(statusView, wc());
        right.addView(st, wc());
        h.addView(right, weight(1));
        return h;
    }

    // Band 2 — OEE band: hero + A/P/Q, hairline-divided
    private LinearLayout oeeBand() {
        LinearLayout b = row(Gravity.FILL_VERTICAL);
        b.setBackgroundColor(INK);

        // OEE is the composite hero (A/P/Q are its factors), so it gets a distinct larger baseline
        // treatment. A slim status accent left of the number carries threshold state (see bindGraphic).
        LinearLayout hero = row(Gravity.CENTER_VERTICAL);
        hero.setPadding(dp(20), 0, dp(20), 0);
        oeeAccent = new View(this);
        oeeAccent.setBackgroundColor(GOOD);
        LinearLayout.LayoutParams al = new LinearLayout.LayoutParams(dp(5), dp(38));
        al.rightMargin = dp(12);
        hero.addView(oeeAccent, al);
        LinearLayout oeeLbl = col();
        oeeLbl.addView(micro("OEE", ON_INK_MUTED, 11), wc());
        LinearLayout.LayoutParams brl = wc();
        brl.topMargin = dp(1);
        oeeLbl.addView(micro("SHIFT", ON_INK_MUTED, 8), brl);
        LinearLayout.LayoutParams lblL = wc();
        lblL.rightMargin = dp(10);
        hero.addView(oeeLbl, lblL);
        LinearLayout oeeRow = row(Gravity.BOTTOM);
        oeeVal = val("--", ON_INK, 44);
        bindValue("OEE", oeeVal);
        oeeRow.addView(oeeVal, wc());
        hero.addView(oeeRow, wc());
        b.addView(hero, weightFill(1.15f));

        b.addView(vrule(INK_HAIR));
        b.addView(inkPart("AVAILABILITY", "Availability"), weightFill(1f));
        b.addView(vrule(INK_HAIR));
        b.addView(inkPart("PERFORMANCE", "Performance"), weightFill(1f));
        b.addView(vrule(INK_HAIR));
        b.addView(inkPart("QUALITY", "Quality"), weightFill(1f));
        return b;
    }

    private LinearLayout inkPart(String label, String sig) {
        LinearLayout p = col();
        p.setGravity(Gravity.CENTER_VERTICAL);
        p.setPadding(dp(20), 0, dp(20), 0);
        p.addView(micro(label, ON_INK_MUTED, 11), wc());
        TextView v = val("--", ON_INK, 30);
        bindValue(sig, v);
        LinearLayout.LayoutParams lp = wc();
        lp.topMargin = dp(2);
        p.addView(v, lp);
        return p;
    }

    // Band 3 — status: filling status | good bottles | actual rate (amber)
    private LinearLayout statusBand() {
        LinearLayout b = row(Gravity.FILL_VERTICAL);
        b.setBackgroundColor(PANEL);

        LinearLayout c1 = col();
        c1.setGravity(Gravity.CENTER_VERTICAL);
        c1.setPadding(dp(20), 0, dp(20), 0);
        c1.addView(micro("FILLING STATUS", MUTED, 11), wc());
        LinearLayout wrow = row(Gravity.CENTER_VERTICAL);
        View blk = new View(this);
        blk.setBackgroundColor(GOOD);
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(dp(9), dp(22));
        bl.rightMargin = dp(10);
        wrow.addView(blk, bl);
        statusDotBlock = blk;
        statusWord = val("RUNNING", INK, 30);
        wrow.addView(statusWord, wc());
        LinearLayout.LayoutParams w2 = wc();
        w2.topMargin = dp(2);
        c1.addView(wrow, w2);
        statusSub = sub("Filler synchronized");
        c1.addView(statusSub, wc());
        b.addView(c1, weightFill(1.3f));

        b.addView(vrule(LINE));
        LinearLayout c2 = col();
        c2.setGravity(Gravity.CENTER_VERTICAL);
        c2.setPadding(dp(20), 0, dp(20), 0);
        c2.addView(micro("GOOD BOTTLES", MUTED, 11), wc());
        TextView gv = val("--", INK, 30);
        bindValue("GoodBottleCount", gv);
        LinearLayout.LayoutParams gl = wc();
        gl.topMargin = dp(2);
        c2.addView(gv, gl);
        goodSub = sub("this shift");
        c2.addView(goodSub, wc());
        b.addView(c2, weightFill(1f));

        b.addView(vrule(LINE));
        LinearLayout c3 = col();
        c3.setGravity(Gravity.CENTER_VERTICAL);
        c3.setPadding(dp(20), 0, dp(20), 0);
        c3.addView(micro("ACTUAL RATE", MUTED, 11), wc());
        LinearLayout rrow = row(Gravity.BOTTOM);
        TextView rv = val("--", INK, 30);
        bindValue("LineSpeedBpm", rv);
        rrow.addView(rv, wc());
        rrow.addView(unit(" BPM"), wcBottom());
        c3.addView(rrow, topM(2));
        c3.addView(sub("target " + Math.round(TARGET_BPM)), wc());
        b.addView(c3, weightFill(0.95f));
        return b;
    }
    private View statusDotBlock;

    // Band 4 — content. Columns are wrap-height with fixed-height children, so nothing depends on a
    // MATCH_PARENT height that a nested weighted layout would fail to resolve.
    // A single column: the fill-line strip on top, then one horizontal row of three panels. This
    // uses only the horizontal-row-of-weight-fill-cells pattern (as the status band and flow strip
    // do), which measures reliably — a nested vertical rail collapsed its children.
    private LinearLayout content() {
        LinearLayout c = col();
        c.addView(sectionHead(null, "PROCESS FLOW", null), mw());
        c.addView(flowStrip(), rowW(dp(6), 88));

        LinearLayout r = row(Gravity.FILL_VERTICAL);
        r.addView(qualityPanel(), weightFillM(2.15f, dp(14)));
        r.addView(ratePanel(), weightFillM(1.15f, dp(14)));
        r.addView(rejectPanel(), weightFill(0.95f));
        c.addView(r, rowW(dp(12), 0, 1f));
        return c;
    }

    private LinearLayout.LayoutParams weightW(float w) { return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, w); }
    private LinearLayout.LayoutParams weightWM(float w, int rightDp) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, w); lp.rightMargin = rightDp; return lp; }

    private View sectionHead(String num, String title, String rightTag) {
        LinearLayout h = row(Gravity.CENTER_VERTICAL);
        // a short accent keyline stands in for the old number chip (line identity lives in the header)
        View key = new View(this);
        key.setBackgroundColor(SAFETY);
        LinearLayout.LayoutParams kl = new LinearLayout.LayoutParams(dp(4), dp(16));
        kl.rightMargin = dp(10);
        h.addView(key, kl);
        TextView t = new TextView(this);
        t.setText(title);
        t.setTypeface(cond);
        t.setTextSize(17);
        t.setTextColor(INK);
        h.addView(t, wc());
        if (rightTag != null) {
            h.addView(spacerW(), weight(1));
            h.addView(micro(rightTag, GOOD, 11), wc());
        }
        return h;
    }

    // 01 flow: three instrumented stages
    private View flowStrip() {
        LinearLayout s = row(Gravity.FILL_VERTICAL);
        infeedTile = flowTile("A", "INFEED", "InfeedMetric", "ConveyorSpeedPct", "%");
        infeedBar = (View) infeedTile.getTag();
        s.addView(infeedTile, weightFillM(1f, dp(0)));
        s.addView(chevron());
        fillerTile = flowTile("B", "FILLER", "FillerMetric", "FillPressureKpa", "kPa");
        fillerBar = (View) fillerTile.getTag();
        s.addView(fillerTile, weightFillM(1f, dp(0)));
        s.addView(chevron());
        capperTile = flowTile("C", "CAPPER", "CapperMetric", "CapRejectCount", "rej");
        capperBar = (View) capperTile.getTag();
        s.addView(capperTile, weightFillM(1f, dp(0)));
        return s;
    }

    private LinearLayout flowTile(String idx, String name, String subKey, String valSig, String unitStr) {
        LinearLayout t = col();
        t.setBackground(panelBg(LINE, 1));
        LinearLayout inner = col();
        inner.setPadding(dp(12), dp(9), dp(12), dp(9));
        LinearLayout top = row(Gravity.CENTER_VERTICAL);
        TextView sq = new TextView(this);
        sq.setText(idx);
        sq.setTypeface(cond);
        sq.setTextSize(11);
        sq.setTextColor(ON_INK);
        sq.setGravity(Gravity.CENTER);
        sq.setBackgroundColor(INK);
        sq.setPadding(dp(6), 0, dp(6), 0);
        top.addView(sq, wc());
        LinearLayout.LayoutParams nlp = wc();
        nlp.leftMargin = dp(8);
        top.addView(micro(name, MUTED, 11), nlp);
        inner.addView(top, mw());
        LinearLayout vrow = row(Gravity.BOTTOM);
        TextView v = val("--", INK, 24);
        bindValue(valSig, v);
        vrow.addView(v, wc());
        if (!unitStr.isEmpty()) vrow.addView(unit(" " + unitStr), wcBottom());
        inner.addView(vrow, topM(4));
        TextView sb = sub("—");
        bindValue(subKey, sb);
        inner.addView(sb, wc());
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        t.addView(inner, il);
        View barV = new View(this);
        barV.setBackgroundColor(LINE); // neutral until a state signal drives it (capper stays neutral)
        t.addView(barV, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(4)));
        t.setTag(barV);
        return t;
    }

    private View chevron() {
        TextView c = new TextView(this);
        c.setText("▸");
        c.setTypeface(cond);
        c.setTextSize(30);
        c.setTextColor(SAFETY);
        LinearLayout.LayoutParams lp = wc();
        lp.leftMargin = dp(6);
        lp.rightMargin = dp(6);
        lp.gravity = Gravity.CENTER_VERTICAL;
        c.setLayoutParams(lp);
        return c;
    }

    // 02 fill quality: tank + value, and a 2x2 measure grid
    private View qualityPanel() {
        LinearLayout p = row(Gravity.FILL_VERTICAL);
        p.setBackground(panelBg(LINE, 1));
        p.setPadding(dp(14), dp(12), dp(14), dp(12));

        tank = new TankGaugeView(this);
        tank.setLowThreshold(35);
        p.addView(tank, new LinearLayout.LayoutParams(dp(52), LinearLayout.LayoutParams.MATCH_PARENT));

        LinearLayout bowlV = col();
        bowlV.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams bvl = wc();
        bvl.leftMargin = dp(14);
        bvl.rightMargin = dp(16);
        bowlV.addView(micro("BOWL LEVEL", MUTED, 11), wc());
        LinearLayout brow = row(Gravity.BOTTOM);
        TextView bval = val("--", INK, 24);
        bindValue("BowlLevelPct", bval);
        brow.addView(bval, wc());
        brow.addView(unit(" %"), wcBottom());
        bowlV.addView(brow, topM(2));
        bowlV.addView(sub("low < 35%"), wc());
        p.addView(bowlV, bvl);

        LinearLayout.LayoutParams sepL = new LinearLayout.LayoutParams(dp(1), LinearLayout.LayoutParams.MATCH_PARENT);
        sepL.rightMargin = dp(16);
        p.addView(vrule(LINE), sepL);

        LinearLayout grid = col();
        LinearLayout r1 = row(Gravity.FILL_VERTICAL);
        pressureBullet = new BulletBarView(this);
        pressureBullet.setRange(90, 150);
        pressureBullet.setBand(108, 126);
        pressureBullet.setTarget(117);
        r1.addView(measureBullet("FILL PRESSURE", "FillPressureKpa", "kPa", "108–126", pressureBullet), weightFillM(1f, dp(16)));
        volumeBullet = new BulletBarView(this);
        volumeBullet.setRange(485, 515);
        volumeBullet.setBand(498, 502);
        volumeBullet.setTarget(500);
        r1.addView(measureBullet("FILL VOLUME", "FillVolumeMl", "mL", "498–502", volumeBullet), weightFill(1f));
        grid.addView(r1, rowW(0, 0, 1f));
        LinearLayout r2 = row(Gravity.FILL_VERTICAL);
        tempBullet = new BulletBarView(this);
        tempBullet.setRange(0, 10);
        tempBullet.setBand(2, 6);
        tempBullet.setTarget(4);
        r2.addView(measureBullet("PRODUCT TEMP", "ProductTempC", "°C", "2–6", tempBullet), weightFillM(1f, dp(16)));
        co2Bullet = new BulletBarView(this);
        co2Bullet.setRange(2.0f, 3.2f);
        co2Bullet.setBand(2.5f, 2.8f);
        co2Bullet.setTarget(2.65f);
        r2.addView(measureBullet("CO₂ VOLUMES", "CO2Volumes", "", "2.5–2.8", co2Bullet), weightFill(1f));
        grid.addView(r2, rowW(dp(6), 0, 1f));
        p.addView(grid, weightFill(1f));
        return p;
    }

    private View measureBullet(String label, String sig, String unitStr, String rangeSub, BulletBarView bullet) {
        LinearLayout v = col();
        v.setGravity(Gravity.CENTER_VERTICAL);
        v.addView(micro(label, MUTED, 11), wc());
        LinearLayout row = row(Gravity.BOTTOM);
        TextView val = val("--", INK, 24);
        bindValue(sig, val);
        row.addView(val, wc());
        if (!unitStr.isEmpty()) row.addView(unit(" " + unitStr), wcBottom());
        v.addView(row, topM(2));
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(8));
        bl.topMargin = dp(6);
        v.addView(bullet, bl);
        v.addView(sub("spec " + rangeSub), topM(3));
        return v;
    }

    private View measurePlain(String label, String sig, String unitStr) {
        LinearLayout v = col();
        v.setGravity(Gravity.CENTER_VERTICAL);
        v.addView(micro(label, MUTED, 11), wc());
        LinearLayout row = row(Gravity.BOTTOM);
        TextView val = val("--", INK, 24);
        bindValue(sig, val);
        row.addView(val, wc());
        if (!unitStr.isEmpty()) row.addView(unit(" " + unitStr), wcBottom());
        v.addView(row, topM(2));
        return v;
    }

    // 03 rate vs target: the analytical view — current BPM positioned within its operating band,
    // above the ideal-rate target. The status band carries the bare number; this is where it earns
    // context (how far from target, which side).
    private View ratePanel() {
        LinearLayout p = col();
        p.setBackground(panelBg(LINE, 1));
        p.setPadding(dp(14), dp(12), dp(14), dp(12));
        p.addView(micro("RATE vs TARGET", MUTED, 11), mw());

        LinearLayout head = row(Gravity.BOTTOM);
        rateValue = val("--", INK, 36);
        head.addView(rateValue, wc());
        head.addView(unit(" BPM"), wcBottom());
        rateDelta = new TextView(this);
        rateDelta.setText("—");
        rateDelta.setTypeface(cond);
        rateDelta.setTextSize(20);
        rateDelta.setTextColor(MUTED);
        LinearLayout.LayoutParams ddl = wcBottom();
        ddl.leftMargin = dp(14);
        head.addView(rateDelta, ddl);
        p.addView(head, topM(10));

        // target-band gauge: fill is green in the target band, amber below, copper above; ink tick at value
        rateBullet = new BulletBarView(this);
        rateBullet.setRange(80, 150);
        rateBullet.setBand(126, 138);
        rateBullet.setTarget(TARGET_BPM);
        rateBullet.setBelowColor(SAFETY);
        LinearLayout.LayoutParams gl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(12));
        gl.topMargin = dp(12);
        p.addView(rateBullet, gl);

        // scale legend: end anchors plus the target label positioned under its tick (132 on 80–150 ≈ 0.74)
        LinearLayout sc = row(Gravity.CENTER_VERTICAL);
        sc.addView(sub("80"), wc());
        sc.addView(spacerW(), weight(2.85f));
        rateTargetSub = sub("target " + Math.round(TARGET_BPM));
        sc.addView(rateTargetSub, wc());
        sc.addView(spacerW(), weight(1f));
        sc.addView(sub("150"), wc());
        p.addView(sc, topM(5));
        return p;
    }

    // 04 reject split
    private View rejectPanel() {
        LinearLayout p = col();
        p.setBackground(panelBg(LINE, 1));
        p.setPadding(dp(14), dp(12), dp(14), dp(12));
        p.addView(micro("REJECTS THIS SHIFT", MUTED, 11), mw());

        LinearLayout head = row(Gravity.BOTTOM);
        TextView rt = val("--", INK, 28);
        bindValue("RejectCount", rt);
        head.addView(rt, wc());
        head.addView(unit(" bottles"), wcBottom());
        p.addView(head, topM(6));

        splitBar = new BarMeterView(this);
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(10));
        sl.topMargin = dp(12);
        p.addView(splitBar, sl);

        // category breakdown, each swatch keyed to its bar segment
        LinearLayout cats = row(Gravity.CENTER_VERTICAL);
        rejOver = catCell(cats, "OVER", COPPER);
        rejUnder = catCell(cats, "UNDER", IRIS);
        rejCap = catCell(cats, "CAP", CARTON);
        p.addView(cats, topM(10));
        return p;
    }

    private TextView rejOver, rejUnder, rejCap;

    private TextView catCell(LinearLayout parent, String label, int swatch) {
        LinearLayout c = col();
        LinearLayout lr = row(Gravity.CENTER_VERTICAL);
        View sw = new View(this);
        sw.setBackgroundColor(swatch);
        LinearLayout.LayoutParams swl = new LinearLayout.LayoutParams(dp(8), dp(8));
        swl.rightMargin = dp(5);
        lr.addView(sw, swl);
        lr.addView(micro(label, MUTED, 9), wc());
        c.addView(lr, wc());
        TextView v = val("--", INK, 17);
        c.addView(v, topM(2));
        parent.addView(c, weight(1));
        return v;
    }

    // Band 5 — footer: line health
    private LinearLayout footer() {
        LinearLayout f = row(Gravity.CENTER_VERTICAL);
        f.setBackgroundColor(PANEL);
        f.setPadding(dp(16), 0, dp(16), 0);
        healthStripe = new View(this);
        healthStripe.setBackgroundColor(GOOD);
        LinearLayout.LayoutParams st = new LinearLayout.LayoutParams(dp(10), dp(26));
        st.rightMargin = dp(14);
        f.addView(healthStripe, st);
        f.addView(micro("LINE HEALTH", MUTED, 11), wc());
        LinearLayout clauses = row(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams cl = wc();
        cl.leftMargin = dp(14);
        healthEStop = sub("E-stop healthy");
        clauses.addView(healthEStop, wc());
        clauses.addView(dotSep());
        healthConv = sub("Conveyor running");
        clauses.addView(healthConv, wc());
        clauses.addView(dotSep());
        healthInfeed = sub("Infeed OK");
        clauses.addView(healthInfeed, wc());
        f.addView(clauses, cl);
        f.addView(spacerW(), weight(1));
        f.addView(micro("GW-FILL-01 · EDGE-CONSOLE WS", MUTED, 10), wc());
        return f;
    }

    // ---------------------------------------------------------------- signals

    private void handleUpdates(JSONArray frames) {
        if (frames == null) return;
        for (int i = 0; i < frames.length(); i++) {
            JSONObject frame = frames.optJSONObject(i);
            if (frame == null) continue;
            String type = frame.optString("type");
            if ("signals".equals(type)) {
                JSONArray series = frame.optJSONArray("series");
                for (int j = 0; series != null && j < series.length(); j++) {
                    JSONObject item = series.optJSONObject(j);
                    if (item != null && isFillingLine(item)) ingest(normSignal(item.optString("name", null)), item.opt("latest"));
                }
            } else if ("signal".equals(type)) {
                JSONArray updates = frame.optJSONArray("updates");
                for (int j = 0; updates != null && j < updates.length(); j++) {
                    JSONObject item = updates.optJSONObject(j);
                    if (item == null || !isFillingLine(item)) continue;
                    JSONObject point = item.optJSONObject("point");
                    Object value = point != null ? point.opt("value") : null;
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
        if (s == null) return null;
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

    /** Register a display for a signal; a signal may drive more than one view. */
    private void bindValue(String key, TextView view) {
        valueViews.computeIfAbsent(key, k -> new ArrayList<>()).add(view);
    }

    /** First view registered for a signal, or null — for callers that own a single display. */
    private TextView firstView(String key) {
        List<TextView> views = valueViews.get(key);
        return views == null || views.isEmpty() ? null : views.get(0);
    }

    private void ingest(String name, Object value) {
        if (name == null || value == null) return;
        lastDataAt = SystemClock.elapsedRealtime();
        final List<TextView> views = valueViews.get(name);
        final double d = toDouble(value);
        final String raw = String.valueOf(value);
        post(() -> {
            if (views != null) {
                for (TextView v : views) v.setText(format(name, value, v));
            }
            bindGraphic(name, raw, d);
            setConn("LIVE", GOOD);
        });
    }

    private void bindGraphic(String name, String raw, double d) {
        switch (name) {
            case "OEE": if (oeeAccent != null) oeeAccent.setBackgroundColor(d >= 85 ? GOOD : (d >= 70 ? SAFETY : DANGER)); break;
            case "BowlLevelPct": if (tank != null) tank.setLevel((float) d); break;
            case "FillPressureKpa": if (pressureBullet != null) pressureBullet.setValue((float) d); break;
            case "FillVolumeMl": if (volumeBullet != null) volumeBullet.setValue((float) d); break;
            case "ProductTempC": if (tempBullet != null) tempBullet.setValue((float) d); break;
            case "CO2Volumes": if (co2Bullet != null) co2Bullet.setValue((float) d); break;
            case "LineSpeedBpm": updateRateDelta((float) d); break;
            case "GoodBottleCount": good = (long) d; updateTally(); break;
            case "RejectCount": rejects = (long) d; break;
            case "OverfillRejectCount": overfill = (long) d; updateTally(); break;
            case "UnderfillRejectCount": underfill = (long) d; updateTally(); break;
            case "CapRejectCount": cap = (long) d; updateTally(); break;
            case "FillerState": updateFiller(raw); break;
            case "ConveyorSpeedPct": updateInfeed(); break;
            case "ConveyorRunning": convRun = truthy(raw); updateInfeed(); updateHealth(); break;
            case "InfeedStarved": infeedStarved = truthy(raw); updateInfeed(); updateHealth(); break;
            case "EStopHealthy": eStop = truthy(raw); updateHealth(); break;
            default: break;
        }
    }

    private static boolean truthy(String s) { return "true".equalsIgnoreCase(s) || "1".equals(s); }

    private void updateRateDelta(float bpm) {
        if (rateValue != null) rateValue.setText(String.format(Locale.US, "%.0f", bpm));
        if (rateBullet != null) rateBullet.setValue(bpm);
        if (rateDelta == null) return;
        int delta = Math.round(bpm - TARGET_BPM);
        boolean ok = delta >= 0;
        rateDelta.setText((ok ? "+" : "") + delta + " BPM");
        rateDelta.setTextColor(ok ? GOOD : COPPER);
    }

    private void updateTally() {
        if (splitBar == null) return;
        long o = Math.max(0, overfill), u = Math.max(0, underfill), c = Math.max(0, cap);
        long t = o + u + c;
        if (t > 0) splitBar.set(new float[]{(float) o / t, (float) u / t, (float) c / t},
                new int[]{COPPER, IRIS, CARTON});
        if (rejOver != null) rejOver.setText(commas(o));
        if (rejUnder != null) rejUnder.setText(commas(u));
        if (rejCap != null) rejCap.setText(commas(c));
    }

    private void updateFiller(String state) {
        running = "RUNNING".equalsIgnoreCase(state);
        String up = state == null ? "" : state.toUpperCase(Locale.US);
        boolean fault = up.contains("STOP") || up.contains("FAULT");
        int color = running ? GOOD : (fault ? DANGER : SAFETY);
        if (fillerBar != null) fillerBar.setBackgroundColor(color);
        tileState(fillerTile, color, !running);
        if (statusWord != null) statusWord.setText(pretty(state).toUpperCase(Locale.US));
        if (statusDotBlock != null) statusDotBlock.setBackgroundColor(color);
        if (statusSub != null) statusSub.setText(running ? "Filler synchronized · infeed OK"
                : (up.contains("PRESSURE") ? "Holding CO₂ head pressure"
                : (up.contains("STARV") ? "Waiting on infeed" : "Filler halted")));
        TextView m = firstView("FillerMetric");
        if (m != null) m.setText(pretty(state));
        // the capper runs in lockstep with the filler; give tile C the same live state anatomy as A/B
        if (capperBar != null) capperBar.setBackgroundColor(color);
        TextView cm = firstView("CapperMetric");
        if (cm != null) cm.setText(running ? "Capping" : (fault ? "Stopped" : "Paused"));
    }

    private void updateInfeed() {
        boolean fault = !convRun;
        int color = infeedStarved ? SAFETY : (fault ? DANGER : GOOD);
        if (infeedBar != null) infeedBar.setBackgroundColor(color);
        tileState(infeedTile, color, infeedStarved || fault);
        TextView m = firstView("InfeedMetric");
        if (m != null) m.setText(fault ? "Stopped" : (infeedStarved ? "Starved" : "Feeding"));
    }

    private void updateHealth() {
        setClause(healthEStop, eStop, "E-stop healthy", "E-STOP OPEN");
        setClause(healthConv, convRun, "Conveyor running", "Conveyor stopped");
        setClause(healthInfeed, !infeedStarved, "Infeed OK", "Infeed starved");
        boolean fault = !eStop || !convRun || infeedStarved;
        if (healthStripe != null) healthStripe.setBackgroundColor(fault ? DANGER : GOOD);
    }

    private void setClause(TextView t, boolean ok, String good, String bad) {
        if (t == null) return;
        t.setText(ok ? good : bad);
        t.setTextColor(ok ? MUTED : DANGER);
        t.setTypeface(ok ? Typeface.DEFAULT : Typeface.DEFAULT_BOLD);
    }

    private void tileState(LinearLayout tile, int color, boolean alert) {
        if (tile == null) return;
        GradientDrawable g = new GradientDrawable();
        g.setColor(alert ? (color == DANGER ? TINT_DANGER : TINT_SAFETY) : PANEL);
        g.setStroke(dp(alert ? 2 : 1), alert ? color : LINE);
        tile.setBackground(g);
    }

    private static String pretty(String s) {
        if (s == null || s.isEmpty()) return "—";
        String t = s.replace('_', ' ').toLowerCase(Locale.US);
        return Character.toUpperCase(t.charAt(0)) + t.substring(1);
    }

    private String format(String name, Object value, TextView view) {
        switch (name) {
            case "GoodBottleCount":
            case "RejectCount":
            case "OverfillRejectCount":
            case "UnderfillRejectCount":
                return commas(value);
            case "CapRejectCount":
                return commas(value);
            case "ValveTrackingCount": {
                Object tag = view.getTag();
                return (tag instanceof String ? (String) tag : "") + commas(value);
            }
            case "LineSpeedBpm":
            case "ConveyorSpeedPct":
                return String.format(Locale.US, "%.0f", toDouble(value));
            case "CO2Volumes":
                return String.format(Locale.US, "%.2f", toDouble(value));
            case "FillerState":
            case "InfeedMetric":
            case "FillerMetric":
                return pretty(String.valueOf(value));
            case "CapperMetric":
                return String.valueOf(value);
            default: // OEE, Availability, Performance, Quality, ProductTempC, BowlLevelPct, pressure, volume
                return String.format(Locale.US, "%.1f", toDouble(value));
        }
    }

    private static double toDouble(Object value) {
        if (value instanceof Number) return ((Number) value).doubleValue();
        try { return Double.parseDouble(String.valueOf(value)); } catch (NumberFormatException e) { return 0.0; }
    }

    private static String commas(Object value) { return String.format(Locale.US, "%,d", (long) toDouble(value)); }

    // ---------------------------------------------------------------- transport

    private void connect() {
        if (!validGatewayUrl(gatewayUrl)) return;
        cancelReconnect();
        closeCurrentSocket(1001, "Reconnecting");
        manualDisconnect = false;
        int gen = ++generation;
        post(() -> setConn("CONNECTING", SAFETY));
        Request request = new Request.Builder().url(gatewayUrl).header("Origin", APP_ORIGIN).build();
        webSocket = client.newWebSocket(request, new GembaListener(gen));
    }

    private final class GembaListener extends WebSocketListener {
        private final int gen;
        private GembaListener(int gen) { this.gen = gen; }
        private boolean active() { return gen == generation && !lifecycleStopped; }

        @Override public void onOpen(WebSocket s, Response r) { if (!active()) { s.cancel(); return; } s.send(helloFrame()); }

        @Override public void onMessage(WebSocket s, String text) {
            if (!active()) return;
            try {
                JSONObject m = new JSONObject(text);
                String type = m.optString("type", "unknown");
                if ("welcome".equals(type)) { reconnectAttempt = 0; s.send(subscribeFrame()); post(() -> setConn("LIVE", GOOD)); }
                else if ("updates".equals(type)) { JSONArray fr = m.optJSONArray("frames"); post(() -> handleUpdates(fr)); }
            } catch (JSONException ignored) { }
        }

        @Override public void onClosing(WebSocket s, int code, String reason) { s.close(code, reason); }
        @Override public void onClosed(WebSocket s, int code, String reason) { if (active()) post(() -> { setConn("STALE", DANGER); scheduleReconnect(); }); }
        @Override public void onFailure(WebSocket s, Throwable e, Response r) { if (active()) post(() -> { setConn("STALE", DANGER); scheduleReconnect(); }); }
    }

    private String helloFrame() {
        try { return new JSONObject().put("type", "hello").put("protocolVersion", PROTOCOL_VERSION).toString(); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    private String subscribeFrame() {
        try {
            JSONArray req = new JSONArray();
            for (String c : CAPABILITIES) req.put(c);
            return new JSONObject().put("type", "subscribe").put("protocolVersion", PROTOCOL_VERSION).put("capabilities", req).toString();
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    private void scheduleReconnect() {
        if (reconnectRunnable != null || manualDisconnect || lifecycleStopped) return;
        long delay = Math.min(15000, 2000L * (long) Math.pow(2, Math.min(reconnectAttempt++, 3)));
        reconnectRunnable = () -> { reconnectRunnable = null; if (!manualDisconnect && !lifecycleStopped) connect(); };
        mainHandler.postDelayed(reconnectRunnable, delay);
    }

    private void cancelReconnect() {
        if (reconnectRunnable != null) { mainHandler.removeCallbacks(reconnectRunnable); reconnectRunnable = null; }
    }

    private void closeCurrentSocket(int code, String reason) {
        WebSocket cur = webSocket;
        webSocket = null;
        if (cur != null) cur.close(code, reason);
    }

    private boolean validGatewayUrl(String url) { return url != null && (url.startsWith("ws://") || url.startsWith("wss://")); }

    // ---------------------------------------------------------------- misc

    private void startClock() {
        Runnable tick = new Runnable() {
            @Override public void run() {
                if (clockView != null) clockView.setText(clockFmt.format(new Date()));
                if (webSocket != null && lastDataAt != 0 && SystemClock.elapsedRealtime() - lastDataAt > 12000
                        && !lifecycleStopped && !manualDisconnect) {
                    setConn("STALE", DANGER);
                    closeCurrentSocket(1001, "stalled");
                    scheduleReconnect();
                    lastDataAt = 0;
                }
                mainHandler.postDelayed(this, 1000);
            }
        };
        mainHandler.post(tick);
    }

    private void setConn(String label, int color) {
        if (statusView != null) { statusView.setText(label); statusView.setTextColor(color); }
        if (statusDot != null) statusDot.setBackground(dot(color));
    }

    private void post(Runnable action) { mainHandler.post(action); }

    // ---- typography ----
    private TextView micro(String s, int color, int sizeSp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sizeSp);
        t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        t.setLetterSpacing(0.06f);
        t.setTextColor(color);
        t.setMaxLines(1);
        return t;
    }
    private TextView val(String s, int color, int sizeSp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sizeSp);
        t.setTypeface(cond);
        t.setTextColor(color);
        t.setMaxLines(1);
        t.setIncludeFontPadding(false);
        return t;
    }
    private TextView unit(String s) { TextView t = new TextView(this); t.setText(s); t.setTextSize(12); t.setTextColor(MUTED); t.setMaxLines(1); return t; }
    private TextView unitOn(String s, int color) { TextView t = new TextView(this); t.setText(s); t.setTextSize(12); t.setTextColor(color); t.setMaxLines(1); return t; }
    private TextView sub(String s) { TextView t = new TextView(this); t.setText(s); t.setTextSize(11); t.setTextColor(MUTED); t.setMaxLines(1); return t; }
    private View dotSep() { TextView t = new TextView(this); t.setText(" · "); t.setTextSize(11); t.setTextColor(LINE); return t; }

    // ---- primitives ----
    private LinearLayout row(int gravity) { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(gravity); l.setBaselineAligned(false); return l; }
    private LinearLayout col() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private View rule(int hDp, int color) { View v = new View(this); v.setBackgroundColor(color); v.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(hDp))); return v; }
    private View gap(int hDp) { View v = new View(this); v.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(hDp))); return v; }
    private View vrule(int color) { View v = new View(this); v.setBackgroundColor(color); v.setLayoutParams(new LinearLayout.LayoutParams(dp(1), LinearLayout.LayoutParams.MATCH_PARENT)); return v; }
    private View spacerW() { return new View(this); }
    private View bar(int wDp, int hDp, int color) { return bar(wDp, hDp, color, 0); }
    private View bar(int wDp, int hDp, int color, int leftDp) { View v = new View(this); v.setBackgroundColor(color); LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(wDp), dp(hDp)); lp.leftMargin = dp(leftDp); v.setLayoutParams(lp); return v; }

    private GradientDrawable panelBg(int stroke, int strokeDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(PANEL);
        g.setStroke(dp(strokeDp), stroke);
        return g;
    }
    private GradientDrawable dot(int color) { GradientDrawable g = new GradientDrawable(); g.setShape(GradientDrawable.OVAL); g.setColor(color); return g; }
    private GradientDrawable hazard(int color) { GradientDrawable g = new GradientDrawable(); g.setColor(color); return g; }

    private LinearLayout.LayoutParams band(int hDp) { return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(hDp)); }
    private LinearLayout.LayoutParams mw() { return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT); }
    private LinearLayout.LayoutParams mh() { return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT); }
    private LinearLayout.LayoutParams wc() { return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); }
    private LinearLayout.LayoutParams wcC() { LinearLayout.LayoutParams lp = wc(); lp.gravity = Gravity.CENTER_HORIZONTAL; return lp; }
    private LinearLayout.LayoutParams wcBottom() { LinearLayout.LayoutParams lp = wc(); lp.bottomMargin = dp(3); return lp; }
    private LinearLayout.LayoutParams topM(int t) { LinearLayout.LayoutParams lp = mw(); lp.topMargin = dp(t); return lp; }
    private LinearLayout.LayoutParams rowW(int top, int hDp) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(hDp)); lp.topMargin = top; return lp; }
    private LinearLayout.LayoutParams rowW(int top, int hDp, float weight) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, weight); lp.topMargin = top; return lp; }
    private LinearLayout.LayoutParams weight(float w) { return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, w); }
    private LinearLayout.LayoutParams weightFill(float w) { return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, w); }
    private LinearLayout.LayoutParams weightFillM(float w, int rightDp) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, w); lp.rightMargin = rightDp; return lp; }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
