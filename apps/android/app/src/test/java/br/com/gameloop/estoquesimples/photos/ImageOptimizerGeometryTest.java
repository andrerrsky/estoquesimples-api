package br.com.gameloop.estoquesimples.photos;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ImageOptimizerGeometryTest {

    @Test
    public void largePhotoIsScaledToLongEdge1280KeepingRatio() {
        // 12 MP típico: 4000 x 3000
        assertArrayEquals(new int[]{1280, 960}, ImageOptimizer.fit(4000, 3000, 1280));
        assertArrayEquals(new int[]{960, 1280}, ImageOptimizer.fit(3000, 4000, 1280));
    }

    @Test
    public void smallPhotoIsNeverUpscaled() {
        assertArrayEquals(new int[]{800, 600}, ImageOptimizer.fit(800, 600, 1280));
        assertArrayEquals(new int[]{1280, 720}, ImageOptimizer.fit(1280, 720, 1280));
    }

    @Test
    public void sampleSizeKeepsDecodedLongEdgeAtLeastTarget() {
        assertEquals(1, ImageOptimizer.sampleSize(1000, 800, 1280));
        assertEquals(1, ImageOptimizer.sampleSize(2559, 1500, 1280));
        assertEquals(2, ImageOptimizer.sampleSize(4000, 3000, 1280));
        assertEquals(4, ImageOptimizer.sampleSize(8000, 6000, 1280));
        for (int longEdge : new int[]{1281, 2560, 4032, 6000, 12000}) {
            int sample = ImageOptimizer.sampleSize(longEdge, longEdge / 2, 1280);
            assertTrue(longEdge / sample >= 1280);
        }
    }

    @Test
    public void shrinkReducesBy15PercentAndNeverReachesZero() {
        assertArrayEquals(new int[]{1088, 816}, ImageOptimizer.shrink(1280, 960));
        assertArrayEquals(new int[]{1, 1}, ImageOptimizer.shrink(1, 1));
    }

    @Test
    public void ladderEventuallyReachesTheFloor() {
        int[] size = {1280, 960};
        int steps = 0;
        while (Math.max(size[0], size[1]) > ImageOptimizer.MIN_EDGE) {
            size = ImageOptimizer.shrink(size[0], size[1]);
            steps++;
            assertTrue(steps < 20);
        }
    }

    @Test
    public void budgetsMatchTheContract() {
        assertEquals(1280, ImageOptimizer.MAX_EDGE);
        assertEquals(250 * 1024, ImageOptimizer.TARGET_BYTES);
        assertArrayEquals(new int[]{80, 70, 60}, ImageOptimizer.QUALITIES);
    }
}
