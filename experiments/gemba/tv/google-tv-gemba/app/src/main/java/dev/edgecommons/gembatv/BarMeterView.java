package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

/**
 * A flat, square-cornered stacked bar over a track — used for the reject split (overfill / underfill
 * / cap). Fractions are of the full width and should sum to <= 1.
 */
public final class BarMeterView extends View {
    private static final int TRACK = Color.rgb(233, 230, 221);

    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    private float[] fractions = new float[0];
    private int[] colors = new int[0];

    public BarMeterView(Context c) {
        super(c);
        p.setStyle(Paint.Style.FILL);
    }

    public void set(float[] fr, int[] cols) {
        fractions = fr;
        colors = cols;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        p.setColor(TRACK);
        cv.drawRect(0, 0, w, h, p);
        float x = 0;
        for (int i = 0; i < fractions.length && i < colors.length; i++) {
            float seg = Math.max(0, fractions[i]) * w;
            if (seg <= 0) continue;
            p.setColor(colors[i]);
            cv.drawRect(x, 0, Math.min(w, x + seg), h, p);
            x += seg;
        }
    }
}
