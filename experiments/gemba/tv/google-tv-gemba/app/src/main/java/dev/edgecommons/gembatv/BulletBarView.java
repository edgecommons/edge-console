package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

/**
 * A flat bullet bar in the proper bullet-chart grammar: a track, a pale tolerance band, a value fill
 * from the range minimum to the current value (GOOD inside the band, COPPER above it, the configured
 * below-colour under it), and a bold ink TARGET marker (the perpendicular tick) at the setpoint. The
 * gap between the fill end and the target tick is the deviation, read at a glance without a needle.
 */
public final class BulletBarView extends View {
    private static final int TRACK = Color.rgb(233, 230, 221);
    private static final int BAND = Color.rgb(241, 223, 174);
    private static final int GOOD = Color.rgb(63, 143, 105);
    private static final int COPPER = Color.rgb(214, 122, 78);
    private static final int IRIS = Color.rgb(93, 105, 168);
    private static final int INK = Color.rgb(35, 35, 61);

    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    private float min = 0, max = 100, bandLo = 0, bandHi = 100, value = Float.NaN, target = Float.NaN;
    private int belowColor = IRIS; // colour of the fill when the value sits below the target band

    public BulletBarView(Context c) {
        super(c);
        p.setStyle(Paint.Style.FILL);
    }

    public void setRange(float mn, float mx) { min = mn; max = mx; }
    public void setBand(float lo, float hi) { bandLo = lo; bandHi = hi; }
    public void setValue(float v) { value = v; invalidate(); }

    /** The setpoint marker (perpendicular tick). Leave unset to draw no target. */
    public void setTarget(float t) { target = t; invalidate(); }

    /** Fill colour used when the value is below the target band (default IRIS; amber for rate). */
    public void setBelowColor(int c) { belowColor = c; }

    private float frac(float v) {
        if (max <= min) return 0;
        return Math.max(0, Math.min(1, (v - min) / (max - min)));
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        p.setColor(TRACK);
        cv.drawRect(0, 0, w, h, p);
        p.setColor(BAND);
        cv.drawRect(frac(bandLo) * w, 0, frac(bandHi) * w, h, p);
        if (!Float.isNaN(value)) {
            p.setColor(value > bandHi ? COPPER : (value < bandLo ? belowColor : GOOD));
            cv.drawRect(0, 0, frac(value) * w, h, p);
        }
        if (!Float.isNaN(target)) {
            // target marker stands a little proud of the bar so it reads as a setpoint, not a fill edge
            float tx = frac(target) * w;
            p.setColor(INK);
            cv.drawRect(tx - dp(1.5f), -dp(3), tx + dp(1.5f), h + dp(3), p);
        }
    }

    private float dp(float v) { return v * getResources().getDisplayMetrics().density; }
}
