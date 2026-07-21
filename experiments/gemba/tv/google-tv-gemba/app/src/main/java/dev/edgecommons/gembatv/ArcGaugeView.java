package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

import java.util.Locale;

/**
 * A 270° radial gauge for a bounded process value (fill pressure, fill volume, CO2). Draws a track,
 * a yellow target band, and a value arc that reads green inside the band and copper outside it, with
 * the value and unit in the centre — the operator sees "in spec / out of spec" without reading digits.
 */
public final class ArcGaugeView extends View {
    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint arc = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint band = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint value = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint label = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint unitP = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF oval = new RectF();
    private float min = 0, max = 100, val = 0, bandLo = 0, bandHi = 100;
    private String title = "", unit = "";
    private boolean has = false;
    private static final float START = 135f, SWEEP = 270f;

    public ArcGaugeView(Context c) {
        super(c);
        track.setStyle(Paint.Style.STROKE);
        track.setStrokeCap(Paint.Cap.ROUND);
        track.setColor(Color.rgb(228, 226, 218));
        arc.setStyle(Paint.Style.STROKE);
        arc.setStrokeCap(Paint.Cap.ROUND);
        band.setStyle(Paint.Style.STROKE);
        band.setStrokeCap(Paint.Cap.ROUND);
        band.setColor(Color.rgb(234, 181, 69));
        value.setColor(Color.rgb(35, 35, 61));
        value.setFakeBoldText(true);
        value.setTextAlign(Paint.Align.CENTER);
        label.setColor(Color.rgb(111, 112, 128));
        label.setFakeBoldText(true);
        label.setTextAlign(Paint.Align.CENTER);
        unitP.setColor(Color.rgb(111, 112, 128));
        unitP.setTextAlign(Paint.Align.CENTER);
    }

    public void setRange(float mn, float mx) { min = mn; max = mx; }
    public void setBand(float lo, float hi) { bandLo = lo; bandHi = hi; }
    public void config(String t, String u) { title = t; unit = u; invalidate(); }
    public void setValue(float v) { val = v; has = true; invalidate(); }

    private float frac(float v) {
        if (max <= min) return 0;
        return Math.max(0, Math.min(1, (v - min) / (max - min)));
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float labH = dp(24);
        label.setTextSize(dp(15));
        cv.drawText(title, w / 2f, labH - dp(6), label);

        float sw = dp(14);
        float size = Math.min(w, h - labH) - dp(6);
        float cx = w / 2f, cy = labH + (h - labH) / 2f;
        oval.set(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2);

        track.setStrokeWidth(sw);
        cv.drawArc(oval, START, SWEEP, false, track);

        band.setStrokeWidth(dp(6));
        cv.drawArc(oval, START + frac(bandLo) * SWEEP, (frac(bandHi) - frac(bandLo)) * SWEEP, false, band);

        if (has) {
            boolean inBand = val >= bandLo && val <= bandHi;
            arc.setColor(inBand ? Color.rgb(116, 195, 152) : Color.rgb(214, 122, 78));
            arc.setStrokeWidth(sw);
            cv.drawArc(oval, START, frac(val) * SWEEP, false, arc);
        }

        // value + unit stacked inside the ring
        value.setTextSize(dp(29));
        cv.drawText(has ? fmt(val) : "--", cx, cy + dp(2), value);
        unitP.setTextSize(dp(14));
        cv.drawText(unit, cx, cy + dp(24), unitP);
    }

    private String fmt(float v) {
        return (Math.abs(v - Math.round(v)) < 0.05f)
                ? String.valueOf(Math.round(v))
                : String.format(Locale.US, "%.1f", v);
    }

    private float dp(float v) { return v * getResources().getDisplayMetrics().density; }
}
