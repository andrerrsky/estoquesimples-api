import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Card, ConfirmDialog, Empty, Notice, PageHeader, Skeleton, useToast } from '../components/ui';
import { centsToInput, fmtCents, fmtNumber, parseReaisToCents } from '../lib/format';

interface Plan {
  key: string;
  name: string;
  description: string;
  googleProductId: string | null;
  googleBasePlanId: string | null;
  /** Preço cobrado pelo Asaas na web, em centavos; null = ciclo não vendido. */
  webPriceMonthlyCents: number | null;
  /** Total cobrado a cada 6 meses. */
  webPriceSemiannualCents: number | null;
  /** Total cobrado uma vez por ano. */
  webPriceYearlyCents: number | null;
  /** Oferta de entrada do Google Play: só para o relatório financeiro. */
  googleOfferPriceCents: number | null;
  googleOfferCycles: number | null;
  /** O checkout da web vende um plano só; os demais não têm preço web. */
  soldOnWeb: boolean;
  isActive: boolean;
  activeSubscriptions: number;
  activeSubscriptionsByProvider: { google_play: number; asaas: number };
  features: Array<{ key: string; enabled: boolean; limit: number | null }>;
  createdAt: string;
  updatedAt: string;
}

interface PlansResponse {
  items: Plan[];
  asaasConfigured: boolean;
  webPrice: { minCents: number; maxCents: number };
}

const FEATURE_LABEL: Record<string, string> = {
  'sync.nuvem': 'Sincronização em nuvem',
  'produtos.sincronizados': 'Produtos na nuvem (teto)',
  'equipe.membros': 'Pessoas na empresa (teto, inclui o proprietário)',
  'sync.dispositivos': 'Aparelhos sincronizando (não aplicado)',
  'analise.avancada': 'Análise Avançada de Estoque',
  'imagens.armazenamento_mb': 'Fotos de produtos: armazenamento por empresa (MB; vazio = sem limite)',
  'marca.personalizada': 'Identidade visual personalizada (cores, fonte, logotipo e URL de entrada)',
};

type Dialog = null | { kind: 'plan'; plan: Plan } | { kind: 'feature'; plan: Plan; feature: { key: string; enabled: boolean; limit: number | null } };

interface Draft {
  name: string;
  description: string;
  isActive: boolean;
  /** Em reais, como digitado ("29,90"); vazio = não vendido na web. */
  webMonthly: string;
  webSemiannual: string;
  webYearly: string;
  googleOffer: string;
  googleOfferCycles: string;
  enabled: boolean;
  limit: string;
}

const EMPTY_DRAFT: Draft = { name: '', description: '', isActive: true, webMonthly: '', webSemiannual: '', webYearly: '', googleOffer: '', googleOfferCycles: '', enabled: true, limit: '' };

/** Ciclos da web: o valor cadastrado é o total cobrado no ciclo. */
const WEB_CYCLES = [
  { key: 'webMonthly', field: 'webPriceMonthlyCents', label: 'Mensal', months: 1, unit: 'por mês' },
  { key: 'webSemiannual', field: 'webPriceSemiannualCents', label: 'Semestral', months: 6, unit: 'a cada 6 meses' },
  { key: 'webYearly', field: 'webPriceYearlyCents', label: 'Anual', months: 12, unit: 'por ano' },
] as const;

/** "R$ 129,90 a cada 6 meses · R$ 21,65/mês · 13% a menos que o mensal". */
function cycleSummary(totalCents: number, months: number, unit: string, monthlyCents: number | null): string {
  if (months === 1) return `${fmtCents(totalCents)} ${unit}.`;
  // Para baixo: nunca anunciar um centavo a mais do que o cobrado.
  const perMonth = Math.floor(totalCents / months);
  const parts = [`${fmtCents(totalCents)} ${unit}`, `${fmtCents(perMonth)}/mês`];
  if (monthlyCents) {
    const saving = Math.round((1 - totalCents / (monthlyCents * months)) * 100);
    parts.push(saving > 0 ? `${saving}% a menos que o mensal` : 'não sai mais barato que o mensal: confira');
  }
  return parts.join(' · ') + '.';
}

/** Situação da venda na web: preço sozinho não basta, precisa da chave e do plano ativo. */
function webSaleStatus(plan: Plan, asaasConfigured: boolean): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (plan.webPriceMonthlyCents === null && plan.webPriceSemiannualCents === null && plan.webPriceYearlyCents === null) return { label: 'não vendido na web', tone: 'neutral' };
  if (!plan.isActive) return { label: 'plano inativo: checkout desligado', tone: 'warning' };
  if (!asaasConfigured) return { label: 'Asaas não configurado: checkout desligado', tone: 'warning' };
  return { label: 'à venda na web', tone: 'success' };
}

export function PlansPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const query = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => api.get<PlansResponse>('/billing/plans') });
  const limits = query.data?.webPrice ?? { minCents: 500, maxCents: 1_000_000 };
  const asaasConfigured = query.data?.asaasConfigured ?? false;

  const openPlan = (plan: Plan) => {
    setDraft({ ...EMPTY_DRAFT, name: plan.name, description: plan.description, isActive: plan.isActive, webMonthly: centsToInput(plan.webPriceMonthlyCents), webSemiannual: centsToInput(plan.webPriceSemiannualCents), webYearly: centsToInput(plan.webPriceYearlyCents), googleOffer: centsToInput(plan.googleOfferPriceCents), googleOfferCycles: plan.googleOfferCycles === null ? '' : String(plan.googleOfferCycles) });
    setDialog({ kind: 'plan', plan });
  };
  const openFeature = (plan: Plan, feature: { key: string; enabled: boolean; limit: number | null }) => {
    setDraft({ ...EMPTY_DRAFT, enabled: feature.enabled, limit: feature.limit === null ? '' : String(feature.limit) });
    setDialog({ kind: 'feature', plan, feature });
  };

  /** Campo em reais → centavos, com a mesma faixa que a API valida. */
  const readPrice = (text: string, label: string): number | null => {
    const cents = parseReaisToCents(text);
    if (cents === undefined) throw new Error(`${label}: valor inválido. Use reais com vírgula nos centavos, por exemplo 29,90.`);
    if (cents !== null && (cents < limits.minCents || cents > limits.maxCents)) {
      throw new Error(`${label}: deve ficar entre ${fmtCents(limits.minCents)} e ${fmtCents(limits.maxCents)} (ou vazio para não vender).`);
    }
    return cents;
  };

  const monthlyPreview = parseReaisToCents(draft.webMonthly);

  return (
    <div className="page">
      <PageHeader title="Planos e recursos" subtitle="O que cada plano libera e quanto custa na web. Modelado como dados para não caçar números no código." />
      <Notice tone="info">
        Alterar um recurso vale para todas as empresas do plano na próxima consulta de direitos. Modelo atual: a nuvem é grátis com conta (só para o proprietário, até o teto de produtos); a assinatura libera equipe, produtos sem limite e a Análise Avançada.
      </Notice>
      <Notice tone="info" title="Dois preços, dois lugares">
        <strong>App Android:</strong> o preço e a cobrança ficam no Google Play Console; aqui só o mapeamento produto → plano → recursos. <strong>Web:</strong> o preço é o que o Asaas cobra de quem assina pelo navegador e é definido aqui, por ciclo. Vale para novas contratações — quem já assina continua com o valor contratado. Ciclo sem preço não é vendido; sem nenhum preço o checkout da web fica desligado.
      </Notice>
      {query.data && !asaasConfigured && (
        <Notice tone="warning" title="Asaas não configurado neste ambiente">
          Sem a chave do Asaas a web não vende, mesmo com preço cadastrado. O preço pode ser preparado antes.
        </Notice>
      )}
      {query.isLoading ? (
        <Skeleton lines={6} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <Empty icon="tag" title="Nenhum plano cadastrado" />
      ) : (
        <div className="grid grid--2">
          {query.data?.items.map((plan) => {
            const sale = webSaleStatus(plan, asaasConfigured);
            return (
              <Card
                key={plan.key}
                title={<span className="row">{plan.name} {!plan.isActive && <Badge tone="error">inativo</Badge>}</span>}
                subtitle={plan.description || <span className="faint">sem descrição</span>}
                actions={can('owner') && <button type="button" className="btn btn--ghost btn--sm" onClick={() => openPlan(plan)}>Editar</button>}
              >
                <dl className="kv" style={{ marginBottom: 14 }}>
                  <dt>Chave</dt><dd><code>{plan.key}</code></dd>
                  <dt>App (Google Play)</dt>
                  <dd>
                    {plan.googleProductId ? (
                      <><code>{plan.googleProductId}{plan.googleBasePlanId ? ` / ${plan.googleBasePlanId}` : ''}</code> <span className="caption">· preço na Play Console</span></>
                    ) : (
                      <span className="muted">sem cobrança (uso local)</span>
                    )}
                  </dd>
                  <dt>Web (Asaas)</dt>
                  <dd>
                    {plan.soldOnWeb ? (
                      <div className="stack stack--tight">
                        {WEB_CYCLES.map((cycle) => {
                          const value = plan[cycle.field];
                          return (
                            <div key={cycle.key}>
                              {cycle.label}:{' '}
                              {value !== null ? (
                                <><strong>{fmtCents(value)}</strong> <span className="caption">{cycleSummary(value, cycle.months, cycle.unit, plan.webPriceMonthlyCents).replace(`${fmtCents(value)} `, '')}</span></>
                              ) : (
                                <span className="muted">não vendido</span>
                              )}
                            </div>
                          );
                        })}
                        <div><Badge tone={sale.tone}>{sale.label}</Badge></div>
                      </div>
                    ) : (
                      <span className="muted">este plano não é vendido na web</span>
                    )}
                  </dd>
                  {plan.googleProductId && (
                    <>
                      <dt>Oferta de entrada (Play)</dt>
                      <dd>
                        {plan.googleOfferPriceCents !== null && plan.googleOfferCycles !== null
                          ? <>{fmtCents(plan.googleOfferPriceCents)}/mês nos {plan.googleOfferCycles} primeiros meses <span className="caption">· usado no relatório financeiro</span></>
                          : <span className="muted">não informada (o relatório usa o preço cheio)</span>}
                      </dd>
                    </>
                  )}
                  <dt>Assinaturas com acesso</dt>
                  <dd>
                    {fmtNumber(plan.activeSubscriptions)}
                    {plan.activeSubscriptions > 0 && <span className="caption"> · {fmtNumber(plan.activeSubscriptionsByProvider.google_play)} Google Play · {fmtNumber(plan.activeSubscriptionsByProvider.asaas)} web</span>}
                  </dd>
                </dl>
                <div className="caption" style={{ marginBottom: 6 }}>Recursos</div>
                <div className="list">
                  {plan.features.map((feature) => (
                    <div key={feature.key} className="list__item">
                      <div className="list__main">
                        <div className="list__title">{FEATURE_LABEL[feature.key] ?? feature.key}</div>
                        <div className="list__sub"><code>{feature.key}</code>{feature.limit !== null && ` · limite ${fmtNumber(feature.limit)}`}</div>
                      </div>
                      <Badge tone={feature.enabled ? 'success' : 'neutral'}>{feature.enabled ? 'liberado' : 'bloqueado'}</Badge>
                      {can('owner') && <button type="button" className="btn btn--link small" onClick={() => openFeature(plan, feature)}>alterar</button>}
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={dialog?.kind === 'plan'}
        onClose={() => setDialog(null)}
        title={`Editar plano ${dialog?.kind === 'plan' ? dialog.plan.name : ''}`}
        confirmLabel="Salvar"
        onConfirm={async (reason) => {
          if (dialog?.kind !== 'plan') return;
          const body: Record<string, unknown> = { name: draft.name, description: draft.description, isActive: draft.isActive, reason };
          if (dialog.plan.soldOnWeb) {
            for (const cycle of WEB_CYCLES) body[cycle.field] = readPrice(draft[cycle.key], `Preço ${cycle.label.toLowerCase()} na web`);
          }
          if (dialog.plan.googleProductId) {
            const offer = parseReaisToCents(draft.googleOffer);
            if (offer === undefined) throw new Error('Oferta do Google Play: valor inválido. Use 19,99.');
            const cycles = draft.googleOfferCycles.trim() === '' ? null : Number(draft.googleOfferCycles);
            if (cycles !== null && (!Number.isInteger(cycles) || cycles < 1 || cycles > 24)) throw new Error('Meses da oferta: de 1 a 24.');
            if ((offer === null) !== (cycles === null)) throw new Error('Informe o preço e os meses da oferta juntos (ou deixe os dois vazios).');
            body['googleOfferPriceCents'] = offer;
            body['googleOfferCycles'] = cycles;
          }
          await api.patch(`/billing/plans/${dialog.plan.key}`, body);
          toast.push('Plano atualizado.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['billing', 'plans'] });
        }}
      >
        <label className="field"><span className="field__label">Nome</span><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={80} /></label>
        <label className="field"><span className="field__label">Descrição</span><input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={500} /></label>
        <label className="checkbox"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /> plano ativo</label>
        {dialog?.kind === 'plan' && dialog.plan.soldOnWeb && (
          <>
            <div className="caption">Preço na web (cobrado pelo Asaas). O preço do app Android é alterado no Google Play Console, não aqui.</div>
            <div className="form-grid">
              {WEB_CYCLES.map((cycle) => {
                const preview = parseReaisToCents(draft[cycle.key]);
                return (
                  <label key={cycle.key} className="field">
                    <span className="field__label">{cycle.label} na web (R$, total {cycle.unit})</span>
                    <input className="input" inputMode="decimal" placeholder="vazio = não vendido" value={draft[cycle.key]} onChange={(event) => setDraft({ ...draft, [cycle.key]: event.target.value })} maxLength={14} />
                    <span className={preview === undefined ? 'field__error' : 'field__hint'}>
                      {preview === undefined
                        ? 'Valor inválido: use 129,90.'
                        : preview === null
                          ? `Ciclo ${cycle.label.toLowerCase()} não vendido na web.`
                          : cycleSummary(preview, cycle.months, cycle.unit, monthlyPreview ?? null)}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="field__hint">Vale para novas contratações; assinaturas existentes continuam com o valor contratado. A mudança fica na auditoria com o motivo.</div>
          </>
        )}
        {dialog?.kind === 'plan' && dialog.plan.googleProductId && (
          <>
            <div className="caption">Oferta de entrada do Google Play (a mesma da Play Console). Não muda o preço do app: só faz o relatório financeiro estimar o que cada assinatura paga nos primeiros meses.</div>
            <div className="form-grid">
              <label className="field">
                <span className="field__label">Preço da oferta (R$ por mês)</span>
                <input className="input" inputMode="decimal" placeholder="vazio = sem oferta" value={draft.googleOffer} onChange={(event) => setDraft({ ...draft, googleOffer: event.target.value })} maxLength={14} />
              </label>
              <label className="field">
                <span className="field__label">Por quantos meses</span>
                <input className="input" type="number" min={1} max={24} placeholder="ex.: 2" value={draft.googleOfferCycles} onChange={(event) => setDraft({ ...draft, googleOfferCycles: event.target.value })} />
              </label>
            </div>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'feature'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'feature' ? `${FEATURE_LABEL[dialog.feature.key] ?? dialog.feature.key} · ${dialog.plan.name}` : ''}
        description="Vale para todas as empresas do plano."
        confirmLabel="Salvar"
        onConfirm={async (reason) => {
          if (dialog?.kind !== 'feature') return;
          await api.put(`/billing/plans/${dialog.plan.key}/features/${dialog.feature.key}`, { enabled: draft.enabled, limit: draft.limit === '' ? null : Number(draft.limit), reason });
          toast.push('Recurso atualizado.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['billing', 'plans'] });
        }}
      >
        <label className="checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> liberado</label>
        <label className="field"><span className="field__label">Limite (vazio = ilimitado)</span><input className="input" type="number" min={0} value={draft.limit} onChange={(event) => setDraft({ ...draft, limit: event.target.value })} /></label>
      </ConfirmDialog>
    </div>
  );
}
