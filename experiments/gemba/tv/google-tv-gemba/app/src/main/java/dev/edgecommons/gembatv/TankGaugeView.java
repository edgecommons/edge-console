package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * A flat filler-bowl tank: a square-cornered shell filled to a level from the bottom, with a single
 * meniscus line, faint 25/50/75 ticks, and a dashed low-level threshold. No gradient, no wave, and
 * no text — the numeric value lives beside the tank in the board's standard measure style, so the
 * bowl reads like every other measure. The liquid is a declared material colour; it turns caution
 * amber only when the level drops below the low threshold.
 */
public final class TankGaugeView extends View {
    private static final int SHELL = Color.rgb(185, 181, 170);
    private static final int TICK = Color.rgb(217, 216, 209);
    private static final int LIQUID = Color.rgb(74, 127, 181);
    private static final int MENISCUS = Color.rgb(46, 95, 145);
    private static final int SAFETY = Color.rgb(234, 181, 69);

    private final Paint shell = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint tick = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint liquid = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint meniscus = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint lowLine = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint lowText = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF body = new RectF();

    private float level = -1f;
    private float low = 35f;

    public TankGaugeView(Context c) {
        super(c);
        shell.setStyle(Paint.Style.STROKE);
        shell.setColor(SHELL);
        tick.setStyle(Paint.Style.STROKE);
        tick.setColor(TICK);
        liquid.setStyle(Paint.Style.FILL);
        meniscus.setStyle(Paint.Style.STROKE);
        meniscus.setColor(MENISCUS);
        lowLine.setStyle(Paint.Style.STROKE);
        lowLine.setColor(SAFETY);
        lowText.setColor(SAFETY);
        lowText.setTextSize(dp(9));
    }

    public void setLevel(float pct) {
        level = Math.max(0, Math.min(100, pct));
        invalidate();
    }

    public void setLowThreshold(float pct) { low = pct; }

    @Override
    protected void onDraw(Canvas cv) {
        float pad = dp(2);
        float left = pad, right = getWidth() - pad, top = pad, bottom = getHeight() - pad;
        body.set(left, top, right, bottom);

        // liquid
        if (level >= 0) {
            boolean lowLvl = level < low;
            liquid.setColor(lowLvl ? SAFETY : LIQUID);
            float fillTop = bottom - (level / 100f) * (bottom - top);
            cv.drawRect(left, fillTop, right, bottom, liquid);
            meniscus.setStrokeWidth(dp(2));
            cv.drawLine(left, fillTop, right, fillTop, meniscus);
        }

        // 25/50/75 ticks
        tick.setStrokeWidth(dp(1));
        for (int i = 1; i < 4; i++) {
            float y = bottom - i / 4f * (bottom - top);
            cv.drawLine(left, y, right, y, tick);
        }

        // low threshold
        lowLine.setStrokeWidth(dp(1.5f));
        lowLine.setPathEffect(new DashPathEffect(new float[]{dp(4), dp(3)}, 0));
        float ly = bottom - (low / 100f) * (bottom - top);
        cv.drawLine(left, ly, right, ly, lowLine);
        cv.drawText("LOW", left + dp(3), ly - dp(4), lowText);

        // shell
        shell.setStrokeWidth(dp(1.5f));
        cv.drawRect(body, shell);
    }

    private float dp(float v) { return v * getResources().getDisplayMetrics().density; }
}
