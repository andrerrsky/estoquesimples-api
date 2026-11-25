import { formatReleaseDate, releases } from '@estoquesimples/changelog';

import { Badge, Card, PageHeader } from '../components/ui';

/**
 * Novidades: o que mudou em cada versão do aplicativo.
 *
 * Mesma fonte do app (`packages/changelog`), para as duas pontas nunca
 * contarem histórias diferentes. Aqui não existe "sua versão": a web é sempre
 * a mais recente — quem lê daqui costuma estar conferindo se já pode esperar
 * algo no celular.
 */
export function WhatsNewPage() {
  const maisNova = releases[0];

  return (
    <div className="stack">
      <PageHeader
        title="Novidades"
        subtitle="O que mudou em cada versão do aplicativo Android"
      />

      <p className="muted">
        A versão mais recente é a <strong>{maisNova?.version}</strong>, de {formatReleaseDate(maisNova?.date ?? '')}. As
        atualizações chegam pela Play Store; na web, você sempre usa a versão mais nova.
      </p>

      {releases.map((release) => (
        <Card
          key={release.version}
          title={release.title}
          subtitle={
            <span className="row" style={{ gap: 8 }}>
              <Badge tone={release === maisNova ? 'brand' : 'neutral'}>Versão {release.version}</Badge>
              <span>{formatReleaseDate(release.date)}</span>
            </span>
          }
        >
          <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
            {release.highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {release.fixes.map((item) => (
              <li key={item} className="muted">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
