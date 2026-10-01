import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Card, ConfirmDialog, Empty, Notice, PageHeader, Skeleton, useToast } from '../components/ui';
import { fmtNumber } from '../lib/format';

interface Plan {
  key: string;
  name: string;
  description: string;
  googleProductId: string | null;
  googleBasePlanId: string | null;
  isActive: boolean;
  activeSubscriptions: number;
  features: Array<{ key: string; enabled: boolean; limit: number | null }>;
  createdAt: string;
  updatedAt: string;
}

const FEATURE_LABEL: Record<string, string> = {
  'sync.nuvem': 'Sincronização em nuvem',
  'produtos.sincronizados': 'Produtos na nuvem (teto)',
  'equipe.membros': 'Pessoas na empresa (teto, inclui o proprietário)',
  'sync.dispositivos': 'Aparelhos sincronizando (não aplicado)',
  'analise.avancada': 'Análise Avançada de Estoque',
};

type Dialog = null | { kind: 'plan'; plan: Plan } | { kind: 'feature'; plan: Plan; feature: { key: string; enabled: boolean; limit: number | null } };

export function PlansPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; isActive: boolean; enabled: boolean; limit: string }>({ name: '', description: '', isActive: true, enabled: true, limit: '' });

  const query = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => api.get<{ items: Plan[] }>('/billing/plans') });

  const openPlan = (plan: Plan) => {
    setDraft({ name: plan.name, description: plan.description, isActive: plan.isActive, enabled: true, limit: '' });
    setDialog({ kind: 'plan', plan });
  };
  const openFeature = (plan: Plan, feature: { key: string; enabled: boolean; limit: number | null }) => {
    setDraft({ name: '', description: '', isActive: true, enabled: feature.enabled, limit: feature.limit === null ? '' : String(feature.limit) });
    setDialog({ kind: 'feature', plan, feature });
  };

  return (
    <div className="page">
      <PageHeader title="Planos e recursos" subtitle="O que cada plano libera. Modelado como dados para não caçar números no código." />
      <Notice tone="info">
        Alterar um recurso vale para todas as empresas do plano na próxima consulta de direitos do app. O preço e a cobrança ficam no Google Play Console; aqui só o mapeamento produto → plano → recursos. Modelo atual: a nuvem é grátis com conta (só para o proprietário, até o teto de produtos); a assinatura libera equipe, produtos sem limite e a Análise Avançada.
      </Notice>
      {query.isLoading ? (
        <Skeleton lines={6} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <Empty icon="tag" title="Nenhum plano cadastrado" />
      ) : (
        <div className="grid grid--2">
          {query.data?.items.map((plan) => (
            <Card
              key={plan.key}
              title={<span className="row">{plan.name} {!plan.isActive && <Badge tone="error">inativo</Badge>}</span>}
              subtitle={plan.description || <span className="faint">sem descrição</span>}
              actions={can('owner') && <button type="button" className="btn btn--ghost btn--sm" onClick={() => openPlan(plan)}>Editar</button>}
            >
              <dl className="kv" style={{ marginBottom: 14 }}>
                <dt>Chave</dt><dd><code>{plan.key}</code></dd>
                <dt>Produto Google</dt><dd>{plan.googleProductId ? <code>{plan.googleProductId}{plan.googleBasePlanId ? ` / ${plan.googleBasePlanId}` : ''}</code> : <span className="muted">sem cobrança (uso local)</span>}</dd>
                <dt>Assinaturas com acesso</dt><dd>{fmtNumber(plan.activeSubscriptions)}</dd>
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
          ))}
        </div>
      )}

      <ConfirmDialog
        open={dialog?.kind === 'plan'}
        onClose={() => setDialog(null)}
        title={`Editar plano ${dialog?.kind === 'plan' ? dialog.plan.name : ''}`}
        confirmLabel="Salvar"
        onConfirm={async (reason) => {
          if (dialog?.kind !== 'plan') return;
          await api.patch(`/billing/plans/${dialog.plan.key}`, { name: draft.name, description: draft.description, isActive: draft.isActive, reason });
          toast.push('Plano atualizado.', 'success');
          void queryClient.invalidateQueries({ queryKey: ['billing', 'plans'] });
        }}
      >
        <label className="field"><span className="field__label">Nome</span><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={80} /></label>
        <label className="field"><span className="field__label">Descrição</span><input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={500} /></label>
        <label className="checkbox"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /> plano ativo</label>
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
