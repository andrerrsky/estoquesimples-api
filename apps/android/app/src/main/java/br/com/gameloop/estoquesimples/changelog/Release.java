package br.com.gameloop.estoquesimples.changelog;

import java.util.List;

/** Uma versão do app e o que ela trouxe. */
public final class Release {

    public final int version;
    /** `YYYY-MM-DD`: dia de calendário, sem hora nem fuso. */
    public final String date;
    public final String title;
    /** O que a pessoa ganhou. */
    public final List<String> highlights;
    /** O que foi corrigido. */
    public final List<String> fixes;

    public Release(int version, String date, String title, List<String> highlights, List<String> fixes) {
        this.version = version;
        this.date = date;
        this.title = title;
        this.highlights = highlights;
        this.fixes = fixes;
    }

    /** dd/MM/aaaa; vazio quando a data não veio no formato esperado. */
    public String dataLegivel() {
        if (date == null || date.length() < 10) {
            return "";
        }
        return date.substring(8, 10) + "/" + date.substring(5, 7) + "/" + date.substring(0, 4);
    }
}
