package br.com.gameloop.estoquesimples.photos;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.util.AttributeSet;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;

import androidx.annotation.Nullable;
import androidx.appcompat.widget.AppCompatImageView;

/**
 * Imagem com zoom por pinça, toque duplo (2,5×/volta ao tamanho da tela) e
 * arraste quando ampliada. A imagem nunca sai da tela: o deslocamento é
 * limitado às bordas e, sem zoom, ela fica centralizada. Um toque simples
 * avisa quem usa (o visualizador fecha).
 */
public class ZoomImageView extends AppCompatImageView {

    private static final float MAX_SCALE = 5f;
    private static final float DOUBLE_TAP_SCALE = 2.5f;

    private final Matrix base = new Matrix();
    private final Matrix user = new Matrix();
    private final Matrix shown = new Matrix();
    private final RectF bounds = new RectF();
    private float userScale = 1f;

    private final ScaleGestureDetector scaleDetector;
    private final GestureDetector gestureDetector;
    @Nullable
    private Runnable onSingleTap;

    public ZoomImageView(Context context) {
        this(context, null);
    }

    public ZoomImageView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        setScaleType(ScaleType.MATRIX);
        scaleDetector = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector detector) {
                zoomBy(detector.getScaleFactor(), detector.getFocusX(), detector.getFocusY());
                return true;
            }
        });
        gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (onSingleTap != null) {
                    onSingleTap.run();
                }
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                if (userScale > 1.05f) {
                    reset();
                } else {
                    zoomBy(DOUBLE_TAP_SCALE, e.getX(), e.getY());
                }
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                if (userScale <= 1.01f) {
                    return false;
                }
                user.postTranslate(-dx, -dy);
                apply();
                return true;
            }
        });
    }

    /** Ação para o toque simples (fora do zoom e do arraste). */
    public void setOnSingleTap(@Nullable Runnable action) {
        onSingleTap = action;
    }

    @Override
    public void setImageDrawable(@Nullable Drawable drawable) {
        super.setImageDrawable(drawable);
        fit();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        fit();
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(MotionEvent event) {
        scaleDetector.onTouchEvent(event);
        if (!scaleDetector.isInProgress()) {
            gestureDetector.onTouchEvent(event);
        }
        // Ampliada, o pai (ex.: um ViewPager) não deve roubar o arraste.
        if (getParent() != null) {
            getParent().requestDisallowInterceptTouchEvent(userScale > 1.01f || event.getPointerCount() > 1);
        }
        return true;
    }

    private void reset() {
        user.reset();
        userScale = 1f;
        apply();
    }

    private void zoomBy(float factor, float focusX, float focusY) {
        float target = Math.max(1f, Math.min(MAX_SCALE, userScale * factor));
        float applied = target / userScale;
        userScale = target;
        user.postScale(applied, applied, focusX, focusY);
        apply();
    }

    /** "Caber na tela, centralizada": a escala de base, sobre a qual o zoom é aplicado. */
    private void fit() {
        Drawable drawable = getDrawable();
        int vw = getWidth() - getPaddingLeft() - getPaddingRight();
        int vh = getHeight() - getPaddingTop() - getPaddingBottom();
        if (drawable == null || vw <= 0 || vh <= 0) {
            return;
        }
        int dw = drawable.getIntrinsicWidth();
        int dh = drawable.getIntrinsicHeight();
        if (dw <= 0 || dh <= 0) {
            return;
        }
        float scale = Math.min((float) vw / dw, (float) vh / dh);
        base.reset();
        base.postScale(scale, scale);
        base.postTranslate(getPaddingLeft() + (vw - dw * scale) / 2f, getPaddingTop() + (vh - dh * scale) / 2f);
        user.reset();
        userScale = 1f;
        apply();
    }

    /** Junta base + zoom e prende a imagem às bordas (ou ao centro, se menor que a tela). */
    private void apply() {
        Drawable drawable = getDrawable();
        if (drawable == null) {
            return;
        }
        shown.set(base);
        shown.postConcat(user);
        bounds.set(0, 0, drawable.getIntrinsicWidth(), drawable.getIntrinsicHeight());
        shown.mapRect(bounds);
        float dx = 0;
        float dy = 0;
        float w = getWidth();
        float h = getHeight();
        if (bounds.width() <= w) {
            dx = (w - bounds.width()) / 2f - bounds.left;
        } else if (bounds.left > 0) {
            dx = -bounds.left;
        } else if (bounds.right < w) {
            dx = w - bounds.right;
        }
        if (bounds.height() <= h) {
            dy = (h - bounds.height()) / 2f - bounds.top;
        } else if (bounds.top > 0) {
            dy = -bounds.top;
        } else if (bounds.bottom < h) {
            dy = h - bounds.bottom;
        }
        if (dx != 0 || dy != 0) {
            user.postTranslate(dx, dy);
            shown.postTranslate(dx, dy);
        }
        setImageMatrix(shown);
    }
}
