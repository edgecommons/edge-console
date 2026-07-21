package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

import java.util.Locale;

/**
 * The board's hero: a rotary filler carousel. A ring of fill valves rotates continuously; the valves
 * passing through the "fill zone" arc glow copper (filling), the rest read as open stations. The hub
 * shows the live fill rate. Rotation speed tracks the line speed, so the whole thing visibly runs
 * faster or slower with the line — the filling analogue of the packaging board's pallet-build grid.
 */
public final class FillerRingView extends View {
    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint valve = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint zone = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint hub = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint big = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint small = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint unitP = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF oval = new RectF();

    private static final int INK = Color.rgb(35, 35, 61);
    private static final int MUTED = Color.rgb(111, 112, 128);
    private static final int LINE = Color.rgb(217, 216, 209);
    private static final int COPPER = Color.rgb(214, 122, 78);
    private static final int GOOD = Color.rgb(63, 143, 105);

    private final int valves = 22;
    private float angle = 0f;         // radians
    private float rate = 0f;          // BPM
    private long lastNanos = 0L;
    private boolean running = true;

    public FillerRingView(Context c) {
        super(c);
        track.setStyle(Paint.Style.STROKE);
        track.setColor(LINE);
        zone.setStyle(Paint.Style.STROKE);
        zone.setStrokeCap(Paint.Cap.ROUND);
        zone.setColor(Color.argb(70, 214, 122, 78));
        big.setColor(INK);
        big.setFakeBoldText(true);
        big.setTextAlign(Paint.Align.CENTER);
        small.setColor(MUTED);
        small.setFakeBoldText(true);
        small.setTextAlign(Paint.Align.CENTER);
        unitP.setColor(MUTED);
        unitP.setTextAlign(Paint.Align.CENTER);
        hub.setStyle(Paint.Style.STROKE);
        hub.setColor(LINE);
    }

    public void setRate(float bpm) { rate = bpm; }
    public void setRunning(boolean r) { running = r; invalidate(); }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float labH = dp(26);
        small.setTextSize(dp(15));
        cv.drawText("ROTARY FILLER", w / 2f, labH - dp(8), small);

        float cx = w / 2f, cy = labH + (h - labH) / 2f;
        float radius = Math.min(w, h - labH) / 2f - dp(10);

        // rotating fill zone (a ~110° arc) behind the valves
        float zoneStart = (float) Math.toDegrees(angle);
        oval.set(cx - radius, cy - radius, cx + radius, cy + radius);
        zone.setStrokeWidth(dp(20));
        cv.drawArc(oval, zoneStart, 110, false, zone);

        // ring track
        track.setStrokeWidth(dp(2));
        cv.drawCircle(cx, cy, radius, track);

        // valves around the ring; those inside the fill zone glow copper
        float r2 = dp(9);
        for (int i = 0; i < valves; i++) {
            float a = angle + (float) (i * 2 * Math.PI / valves);
            float vx = cx + radius * (float) Math.cos(a);
            float vy = cy + radius * (float) Math.sin(a);
            float deg = (float) Math.toDegrees(i * 2 * Math.PI / valves);
            boolean filling = running && deg <= 110;
            valve.setColor(filling ? COPPER : (running ? GOOD : LINE));
            cv.drawCircle(vx, vy, filling ? r2 + dp(2) : r2, valve);
        }

        // hub (white fill so the value reads cleanly over the rotating valves)
        float hubR = radius * 0.72f;
        hub.setStyle(Paint.Style.FILL);
        hub.setColor(Color.rgb(255, 253, 248));
        cv.drawCircle(cx, cy, hubR, hub);
        hub.setStyle(Paint.Style.STROKE);
        hub.setColor(LINE);
        hub.setStrokeWidth(dp(2));
        cv.drawCircle(cx, cy, hubR, hub);
        big.setTextSize(dp(34));
        cv.drawText(rate > 0 ? String.format(Locale.US, "%.0f", rate) : "--", cx, cy - dp(4), big);
        unitP.setTextSize(dp(11));
        cv.drawText("BOTTLES / MIN", cx, cy + dp(16), unitP);

        // advance rotation; speed scales with line rate (≈132 BPM nominal)
        long now = System.nanoTime();
        if (lastNanos != 0 && running) {
            float dt = (now - lastNanos) / 1_000_000_000f;
            float speed = 0.35f + (rate / 132f) * 0.9f; // rad/s
            angle += dt * speed;
            if (angle > 2 * Math.PI) angle -= 2 * Math.PI;
        }
        lastNanos = now;
        if (running) postInvalidateOnAnimation();
    }

    private float dp(float v) { return v * getResources().getDisplayMetrics().density; }
}
