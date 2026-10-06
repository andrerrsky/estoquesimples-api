package br.com.gameloop.estoquesimples.photos;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import br.com.gameloop.estoquesimples.photos.PhotoRules.PullDecision;

public class PhotoRulesTest {

    private static final String H1 = "a".repeat(64);
    private static final String H2 = "b".repeat(64);

    @Test
    public void sha256MatchesKnownVector() {
        byte[] abc = "abc".getBytes(StandardCharsets.UTF_8);
        String expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assertEquals(expected, PhotoRules.sha256Hex(abc));
        assertTrue(PhotoRules.matchesHash(abc, expected));
    }

    @Test
    public void downloadedBytesThatDoNotMatchAreRejected() {
        byte[] data = "conteudo".getBytes(StandardCharsets.UTF_8);
        assertFalse(PhotoRules.matchesHash(data, H1));
        assertFalse(PhotoRules.matchesHash(null, H1));
        assertFalse(PhotoRules.matchesHash(data, "nao-e-hash"));
    }

    @Test
    public void hashValidationRequiresLowercaseHex64() {
        assertTrue(PhotoRules.isValidHash(H1));
        assertFalse(PhotoRules.isValidHash(H1.toUpperCase()));
        assertFalse(PhotoRules.isValidHash(H1.substring(1)));
        assertFalse(PhotoRules.isValidHash(null));
    }

    @Test
    public void needsUploadOnlyWithPhotoAndNoHash() {
        assertTrue(PhotoRules.needsUpload("/x/a.jpg", null));
        assertFalse(PhotoRules.needsUpload("/x/a.jpg", H1));
        assertFalse(PhotoRules.needsUpload(null, null));
        assertFalse(PhotoRules.needsUpload("", null));
        assertFalse(PhotoRules.needsUpload("null", null));
    }

    @Test
    public void needsDownloadWhenHashKnownAndFileMissing() {
        assertTrue(PhotoRules.needsDownload(H1, false));
        assertFalse(PhotoRules.needsDownload(H1, true));
        assertFalse(PhotoRules.needsDownload(null, false));
    }

    @Test
    public void serverWithoutPhotoFieldNeverTouchesLocalPhoto() {
        assertEquals(PullDecision.NOTHING, PhotoRules.decidePull(false, null, "/x/a.webp", H1));
        assertEquals(PullDecision.NOTHING, PhotoRules.decidePull(false, null, "/x/a.webp", null));
    }

    @Test
    public void sameHashDoesNothing() {
        assertEquals(PullDecision.NOTHING, PhotoRules.decidePull(true, H1, "/x/a.webp", H1));
    }

    @Test
    public void newServerHashIsAdopted() {
        assertEquals(PullDecision.ADOPT_SERVER, PhotoRules.decidePull(true, H2, "/x/a.webp", H1));
        assertEquals(PullDecision.ADOPT_SERVER, PhotoRules.decidePull(true, H1, null, null));
        assertEquals(PullDecision.ADOPT_SERVER, PhotoRules.decidePull(true, H1, "", null));
    }

    @Test
    public void unsyncedLocalPhotoIsKeptWhateverTheServerSays() {
        assertEquals(PullDecision.KEEP_LOCAL, PhotoRules.decidePull(true, H2, "/x/new.webp", null));
        assertEquals(PullDecision.KEEP_LOCAL, PhotoRules.decidePull(true, null, "/x/new.webp", null));
    }

    @Test
    public void serverRemovalOnlyRemovesASyncedLocalPhoto() {
        assertEquals(PullDecision.REMOVE_LOCAL, PhotoRules.decidePull(true, null, "/x/a.webp", H1));
        assertEquals(PullDecision.NOTHING, PhotoRules.decidePull(true, null, null, null));
    }

    @Test
    public void invalidServerHashIsIgnored() {
        assertEquals(PullDecision.NOTHING, PhotoRules.decidePull(true, "xyz", "/x/a.webp", H1));
    }

    @Test
    public void permanentUploadFailures() {
        assertTrue(PhotoRules.isPermanentUploadFailure(415, "IMAGE_UNSUPPORTED_TYPE"));
        assertTrue(PhotoRules.isPermanentUploadFailure(422, "IMAGE_INVALID"));
        assertTrue(PhotoRules.isPermanentUploadFailure(413, "PAYLOAD_TOO_LARGE"));
        assertFalse(PhotoRules.isPermanentUploadFailure(403, "PLAN_LIMIT_REACHED"));
        assertFalse(PhotoRules.isPermanentUploadFailure(503, "IMAGES_UNAVAILABLE"));
        assertFalse(PhotoRules.isPermanentUploadFailure(429, null));
        assertFalse(PhotoRules.isPermanentUploadFailure(0, "SEM_REDE"));
    }

    @Test
    public void canonicalFileNameIsTheHash() {
        assertEquals(H1 + ".webp", PhotoRules.canonicalName(H1));
    }
}
