package br.com.gameloop.estoquesimples.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

public class ReorderPlannerTest {

    @Test
    public void entraNaListaQuemZerouOuChegouNoMinimo() {
        assertTrue(ReorderPlanner.needsReorder(0, 0));
        assertTrue(ReorderPlanner.needsReorder(3, 10));
        assertTrue(ReorderPlanner.needsReorder(10, 10));
        assertFalse(ReorderPlanner.needsReorder(11, 10));
        assertFalse(ReorderPlanner.needsReorder(5, 0));
    }

    @Test
    public void sugereODobroDoMinimoArredondandoUnidadesInteiras() {
        assertEquals(17, ReorderPlanner.suggest(3, 10, "un"), 1e-9);
        assertEquals(20, ReorderPlanner.suggest(-4, 10, "un"), 1e-9);
        assertEquals(1, ReorderPlanner.suggest(0, 0, "un"), 1e-9);
        assertEquals(5, ReorderPlanner.suggest(1.5, 3.25, "cx"), 1e-9);
        assertEquals(1.75, ReorderPlanner.suggest(0.75, 1.25, "kg"), 1e-9);
    }

    @Test
    public void agrupaPorFornecedorComSemFornecedorPorUltimo() {
        List<ReorderPlanner.Item> itens = new ArrayList<>(Arrays.asList(
                new ReorderPlanner.Item("Feijão", "un", 1, 5, ""),
                new ReorderPlanner.Item("Café", "un", 0, 4, "Distribuidora Sul"),
                new ReorderPlanner.Item("Açúcar", "un", 2, 6, "Atacadão"),
                new ReorderPlanner.Item("Arroz", "un", 1, 6, "Atacadão")));
        Map<String, List<ReorderPlanner.Item>> grupos = ReorderPlanner.bySupplier(itens);
        assertEquals(Arrays.asList("Atacadão", "Distribuidora Sul", ReorderPlanner.SEM_FORNECEDOR),
                new ArrayList<>(grupos.keySet()));
        assertEquals("Arroz", grupos.get("Atacadão").get(0).name);
    }

    @Test
    public void mensagemSoComOsMarcados() {
        ReorderPlanner.Item cafe = new ReorderPlanner.Item("Café 500g", "pct", 1, 5, "Atacadão");
        ReorderPlanner.Item acucar = new ReorderPlanner.Item("Açúcar 2kg", "un", 0, 3, "Atacadão");
        acucar.selected = false;
        String texto = ReorderPlanner.message("Atacadão", Arrays.asList(cafe, acucar), "Mercadinho do Zé");
        assertTrue(texto.startsWith("Olá, Atacadão! Gostaria de fazer um pedido para Mercadinho do Zé:"));
        assertTrue(texto.contains("• 9 pct — Café 500g"));
        assertFalse(texto.contains("Açúcar"));

        cafe.selected = false;
        assertNull(ReorderPlanner.message("Atacadão", Arrays.asList(cafe, acucar), null));
    }

    @Test
    public void quantidadeSemCasasInuteis() {
        assertEquals("17", ReorderPlanner.formatQuantity(17));
        assertEquals("2,5", ReorderPlanner.formatQuantity(2.5));
        assertEquals("1,75", ReorderPlanner.formatQuantity(1.75));
    }

    @Test
    public void maisUrgentesPrimeiroComTeto() {
        List<ReorderPlanner.Item> itens = Arrays.asList(
                new ReorderPlanner.Item("No mínimo", "un", 10, 10, ""),
                new ReorderPlanner.Item("Zerado", "un", 0, 10, ""),
                new ReorderPlanner.Item("Quase zerado", "un", 1, 10, ""));
        List<ReorderPlanner.Item> top = ReorderPlanner.mostUrgent(itens, 2);
        assertEquals(2, top.size());
        assertEquals("Zerado", top.get(0).name);
        assertEquals("Quase zerado", top.get(1).name);
    }
}
