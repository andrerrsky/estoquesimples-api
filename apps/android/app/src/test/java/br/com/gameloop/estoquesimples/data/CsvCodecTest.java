package br.com.gameloop.estoquesimples.data;

import org.junit.Test;

import java.io.StringReader;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CsvCodecTest {

    @Test
    public void quotedCommaStaysInOneField() {
        List<String> fields = CsvCodec.parseLine("Café, \" grãos, torrados \", 10", ',');
        assertEquals("Café", fields.get(0));
        assertEquals("grãos, torrados", fields.get(1));
        assertEquals("10", fields.get(2));
    }

    @Test
    public void escapedQuotes() {
        List<String> fields = CsvCodec.parseLine("\"Diz \"\"olá\"\"\",1", ',');
        assertEquals("Diz \"olá\"", fields.get(0));
        assertEquals("1", fields.get(1));
    }

    @Test
    public void headerIsDetectedAndBomStripped() {
        assertTrue(CsvCodec.looksLikeHeader(Arrays.asList("Nome", "Quantidade")));
        assertTrue(CsvCodec.looksLikeHeader(Arrays.asList("\uFEFFnome", "sku")));
        assertFalse(CsvCodec.looksLikeHeader(Arrays.asList("Café", "10")));
    }

    @Test
    public void semicolonWinsWhenPlanilhaBrasileira() {
        assertEquals(';', CsvCodec.detectDelimiter("nome;quantidade;valor"));
        assertEquals(',', CsvCodec.detectDelimiter("nome,quantidade,valor"));
    }

    @Test
    public void formulaIsNeutralizedButNegativeNumberIsNot() {
        assertEquals("'=CMD()", CsvCodec.neutralizeFormula("=CMD()"));
        assertEquals("-5.5", CsvCodec.neutralizeFormula("-5.5"));
    }

    @Test
    public void parseKeepsQuotedNewlines() throws Exception {
        List<List<String>> rows = CsvCodec.parse(new StringReader(
                "nome,descricao\n\"Café\",\"linha 1\nlinha 2\"\n"));
        assertEquals(2, rows.size());
        assertEquals("Café", rows.get(1).get(0));
        assertTrue(rows.get(1).get(1).contains("linha 1"));
        assertTrue(rows.get(1).get(1).contains("linha 2"));
    }

    @Test
    public void escapeQuotesFieldsWithComma() {
        assertEquals("\"grãos, torrados\"", CsvCodec.escape("grãos, torrados"));
        assertEquals("Café", CsvCodec.escape("Café"));
    }
}
