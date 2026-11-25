import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { Card, Notice, PageHeader, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

/**
 * Opções da empresa.
 *
 * Existe porque nem todo negócio precisa das mesmas perguntas: lote e
 * validade são o dia a dia de uma mercearia e seriam três campos vazios numa
 * loja de ferragens. O que é da empresa (vale na web e no app, para todo
 * mundo da equipe) fica aqui; o que é de cada pessoa continua em Minha conta.
 */
export function OptionsPage() {
  const { workspaceId, workspace, tracksBatches, refresh, can } = useCurrentWorkspace();
  const toast = useToast();
  const [batches, setBatches] = useState(tracksBatches);
  const pode = can('workspace.configurar');

  const save = useMutation({
    mutationFn: (value: boolean) =>
      api.patch(`/v1/workspaces/${workspaceId}`, {
        // `settings` é substituído inteiro: o que já estava lá precisa voltar.
        settings: { ...workspace.settings, trackBatches: value },
      }),
    onSuccess: async (_result, value) => {
      await refresh();
      track('options.batches', { enabled: value });
      toast.push(value ? 'Controle de lote e validade ligado.' : 'Controle de lote e validade desligado.');
    },
    onError: (caught) => {
      setBatches(tracksBatches);
      toast.error(caught);
    },
  });

  const toggle = (value: boolean) => {
    setBatches(value);
    save.mutate(value);
  };

  return (
    <div className="stack">
      <PageHeader title="Opções" subtitle={`O que esta empresa usa no dia a dia · ${workspace.name}`} />

      {!pode && <Notice tone="info">Seu papel não permite mudar as opções da empresa.</Notice>}

      <Card title="Lote e validade" subtitle="Para quem trabalha com produto que vence">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={batches}
            disabled={!pode || save.isPending}
            onChange={(event) => toggle(event.target.checked)}
          />
          <span>Perguntar lote, fabricação e validade nas entradas</span>
        </label>
        <p className="muted" style={{ marginTop: 12 }}>
          Ligado, cada entrada de estoque pode registrar o lote e a validade da mercadoria, e a tela
          <strong> Validades</strong> mostra o que vence primeiro. O que sai do estoque continua saindo sem escolher
          lote: a conta usa a regra da prateleira, o que vence antes sai antes.
        </p>
        <p className="muted">
          Desligado, os campos desaparecem e nada do que já foi registrado se perde.
        </p>
      </Card>
    </div>
  );
}
