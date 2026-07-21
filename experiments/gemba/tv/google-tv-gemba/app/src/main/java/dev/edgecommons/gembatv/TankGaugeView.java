package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

/**
 * A liquid-tank gauge for the filler bowl: the tank fills from the bottom to a percentage with a
 * gently waved surface, turns amber below a low-level threshold, and prints the level large in the
 * centre. This is the board's graphical centrepiece — the operator reads bowl level at a glance.
 */
public final class TankGaugeView extends View {
    private final Paint shell = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint liquid = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint grid = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint title = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint value = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF body = new RectF();
    private final Path wave = new Path();
    private float level = 0f;         // 0..100
    private float low = 35f;          // amber below this
    private String label = "BOWL LEVEL";
    private boolean has = false;

    public TankGaugeView(Context c) {
        super(c);
        shell.setStyle(Paint.Style.STROKE);
        shell.setColor(Color.rgb(210, 208, 200));
        grid.setStyle(Paint.Style.STROKE);
        grid.setColor(Color.argb(50, 255, 255, 255));
        title.setColor(Color.rgb(111, 112, 128));
        title.setFakeBoldText(true);
        value.setColor(Color.WHITE);
        value.setFakeBoldText(true);
        value.setTextAlign(Paint.Align.CENTER);
    }

    public void setLabel(String t) { label = t; invalidate(); }
    public void setLowThreshold(float pct) { low = pct; }
    public void setLevel(float pct) { level = Math.max(0, Math.min(100, pct)); has = true; invalidate(); }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float pad = dp(6);
        float labelH = dp(28);
        title.setTextSize(dp(15));
        cv.drawText(label, pad, labelH - dp(9), title);

        float top = labelH, bottom = h - pad, left = pad, right = w - pad, rad = dp(12);
        body.set(left, top, right, bottom);

        boolean lowLvl = level < low;
        int c1 = lowLvl ? Color.rgb(224, 138, 86) : Color.rgb(70, 158, 216);
        int c2 = lowLvl ? Color.rgb(184, 96, 60) : Color.rgb(38, 104, 176);
        float fillTop = has ? bottom - (level / 100f) * (bottom - top) : bottom;

        cv.save();
        Path clip = new Path();
        clip.addRoundRect(body, rad, rad, Path.Direction.CW);
        cv.clipPath(clip);
        // faint level gridlines at 25/50/75
        grid.setStrokeWidth(dp(1));
        for (int i = 1; i < 4; i++) {
            float y = bottom - i / 4f * (bottom - top);
            cv.drawLine(left, y, right, y, grid);
        }
        if (has) {
            liquid.setShader(new LinearGradient(0, fillTop, 0, bottom, c1, c2, Shader.TileMode.CLAMP));
            wave.reset();
            wave.moveTo(left, fillTop);
            float amp = dp(6);
            int steps = 28;
            for (int i = 0; i <= steps; i++) {
                float x = left + (right - left) * i / steps;
                float y = fillTop + (float) Math.sin((double) i / steps * 3 * 2 * Math.PI) * amp;
                wave.lineTo(x, y);
            }
            wave.lineTo(right, bottom);
            wave.lineTo(left, bottom);
            wave.close();
            cv.drawPath(wave, liquid);
        }
        cv.restore();

        shell.setStrokeWidth(dp(2));
        cv.drawRoundRect(body, rad, rad, shell);

        value.setTextSize(dp(46));
        String txt = has ? Math.round(level) + "%" : "--";
        cv.drawText(txt, (left + right) / 2f, (top + bottom) / 2f + dp(16), value);
    }

    private float dp(float v) { return v * getResources().getDisplayMetrics().density; }
}
