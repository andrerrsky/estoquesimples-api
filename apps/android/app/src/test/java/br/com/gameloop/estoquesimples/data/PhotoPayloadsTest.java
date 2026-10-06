package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class PhotoPayloadsTest {

    private static final String OLD = "a".repeat(64);
    private static final String NEW = "b".repeat(64);

    @Test
    public void ordinaryEditOmitsPhotoHash() throws Exception {
        JSONObject previous = new JSONObject().put("name", "Antes");
        assertFalse(PhotoPayloads.touchesPhoto(previous));
        assertFalse(PhotoPayloads.touchesPhoto(null));
    }

    @Test
    public void setPhotoCarriesHashAndPreviousValue() throws Exception {
        JSONObject payload = new JSONObject().put("id", "x");
        JSONObject previous = PhotoPayloads.previousFor(OLD);
        assertTrue(PhotoPayloads.touchesPhoto(previous));
        PhotoPayloads.attach(payload, NEW);
        assertEquals(NEW, payload.getString("photoHash"));
        assertEquals(OLD, previous.getString("photoHash"));
    }

    @Test
    public void firstPhotoHasNullPrevious() throws Exception {
        JSONObject previous = PhotoPayloads.previousFor(null);
        assertTrue(previous.has("photoHash"));
        assertTrue(previous.isNull("photoHash"));
    }

    @Test
    public void removalSendsExplicitNull() throws Exception {
        JSONObject payload = new JSONObject().put("id", "x");
        PhotoPayloads.attach(payload, null);
        assertTrue(payload.has("photoHash"));
        assertTrue(payload.isNull("photoHash"));
        assertEquals(OLD, PhotoPayloads.previousFor(OLD).getString("photoHash"));
    }

    @Test
    public void compactionKeepsThePhotoChangeWhenALaterEditHasNone() throws Exception {
        // op1: troca de foto (photoHash NEW, previous OLD); op2: edição de nome.
        JSONObject survivor = new JSONObject().put("id", "x").put("name", "Novo");
        JSONObject merged = new JSONObject().put("name", "Antes").put("photoHash", OLD);
        PhotoPayloads.carryOver(survivor, merged, true, NEW);
        assertEquals(NEW, survivor.getString("photoHash"));
    }

    @Test
    public void compactionCarriesRemovalAsNull() throws Exception {
        JSONObject survivor = new JSONObject().put("id", "x");
        JSONObject merged = PhotoPayloads.previousFor(OLD);
        PhotoPayloads.carryOver(survivor, merged, true, JSONObject.NULL);
        assertTrue(survivor.has("photoHash"));
        assertTrue(survivor.isNull("photoHash"));
    }

    @Test
    public void compactionDoesNotInventAPhotoChange() throws Exception {
        JSONObject survivor = new JSONObject().put("id", "x");
        PhotoPayloads.carryOver(survivor, new JSONObject().put("name", "A"), false, null);
        assertFalse(survivor.has("photoHash"));

        JSONObject withOwn = new JSONObject().put("photoHash", NEW);
        PhotoPayloads.carryOver(withOwn, PhotoPayloads.previousFor(OLD), true, "c".repeat(64));
        assertEquals(NEW, withOwn.getString("photoHash"));
    }
}
