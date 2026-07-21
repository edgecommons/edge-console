package dev.edgecommons.gembatv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * A rounded horizontal meter that draws one or more coloured segments over a track — used both for
 * the production-vs-target progress bar (one segment) and the reject split (overfill/underfill).
 */
public final class BarMeterView extends View {
    private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint seg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF r = new RectF();
    private float[] fractions = new float[0];
    private int[] colors = new int[0];

    public BarMeterView(Context c) {
        super(c);
        track.setColor(Color.rgb(228, 226, 218));
        seg.setStyle(Paint.Style.FILL);
    }

    /** Segments are drawn left-to-right; fractions are of the full width and should sum to <= 1. */
    public void set(float[] fr, int[] cols) {
        fractions = fr;
        colors = cols;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float rad = h / 2f;
        r.set(0, 0, w, h);
        cv.drawRoundRect(r, rad, rad, track);
        float x = 0;
        for (int i = 0; i < fractions.length && i < colors.length; i++) {
            float seww = Math.max(0, Math.min(1, fractions[i])) * w;
            if (seww <= 0) continue;
            seg.setColor(colors[i]);
            r.set(x, 0, Math.min(w, x + seww + rad), h);
            cv.save();
            cv.clipRect(x, 0, Math.min(w, x + seww), h);
            cv.drawRoundRect(new RectF(x == 0 ? 0 : x - rad, 0, x + seww + rad, h), rad, rad, seg);
            cv.restore();
            x += seww;
        }
    }
}
