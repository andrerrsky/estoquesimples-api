import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError, errorMessage, uploadBinary } from '../api/client';
import type { BrandConfig, BrandTheme, BrandingView } from '../api/types';
import { Badge, Card, ConfirmDialog, Field, Notice, PageHeader, QueryState, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { previewBrand } from '../lib/brand';
import { IMAGE_ACCEPT, ImageError, prepareImage } from '../lib/image';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-company.css';

interface BrandResponse {
  eligible: boolean;
  config: BrandConfig;
  effective: BrandingView;
  suggestedSlug: string;
}

interface Problem {
  field: 'primary' | 'accent' | 'text';
  message: string;
  suggestion?: string;
}

interface PreviewResponse {
  valid: boolean;
  problems: Problem[];
  theme: BrandTheme | null;
}

type ColorKey = 'primaryColor' | 'accentColor' | 'textColor';
type Draft = { slug: string; primaryColor: string | null; accentColor: string | null; textColor: string | null; font: 'default' | 'serif' };

const COLORS: Array<{ key: ColorKey; field: Problem['field']; label: string; hint: string; fallback: string }> = [
  { key: 'primaryColor', field: 'primary', label: 'Cor principal', hint: 'Barras, botões e destaques. Precisa ter contraste com texto branco.', fallback: '#1c679d' },
  { key: 'accentColor', field: 'accent', label: 'Cor de destaque', hint: 'Links e números em evidência. Sem escolher, usa a cor principal.', fallback: '#1c679d' },
  { key: 'textColor', field: 'text', label: 'Cor do texto', hint: 'Textos de leitura. Precisa de alto contraste com o fundo.', fallback: '#1a2330' },
];

const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32);

const toDraft = (data: BrandResponse): Draft => ({
  slug: data.config.slug ?? data.suggestedSlug,
  primaryColor: data.config.primaryColor,
  accentColor: data.config.accentColor,
  textColor: data.config.textColor,
  font: data.config.font,
});

/**
 * Identidade visual da empresa. A tela só EDITA os poucos tokens permitidos;
 * quem valida contraste e deriva a paleta é a API (rota de pré-visualização),
 * e quem decide se a marca vale é o plano em vigor.
 */
export function BrandPage() {
  const { workspaceId, can, refresh } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const base = `/v1/workspaces/${workspaceId}/branding`;
  const query = useQuery({ queryKey: ['brand-config', workspaceId], queryFn: () => api.get<BrandResponse>(base) });
  const data = query.data;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [logoBusy, setLogoBusy] = useState<number | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (data && !draft) setDraft(toDraft(data));
  }, [data, draft]);

  const eligible = data?.eligible ?? false;
  const editable = eligible && can('marca.gerenciar');
  const logoUrl = data?.config.logo?.url ?? null;

  // Pré-visualização: a paleta vem da API; a interface inteira já aparece com ela.
  useEffect(() => {
    if (!draft || !editable) return;
    let undo: (() => void) | null = null;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .post<PreviewResponse>(`${base}/preview`, { primaryColor: draft.primaryColor, accentColor: draft.accentColor, textColor: draft.textColor, font: draft.font })
        .then((result) => {
          if (cancelled) return;
          setProblems(result.problems);
          if (result.theme && (draft.primaryColor || draft.accentColor || draft.textColor || draft.font !== 'default' || logoUrl)) undo = previewBrand(result.theme, logoUrl, draft.slug || 'previa');
        })
        .catch(() => setProblems([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      undo?.();
    };
  }, [draft, editable, base, logoUrl]);

  const save = useMutation({
    mutationFn: (value: Draft) => api.put<BrandConfig>(base, value),
    onSuccess: async () => {
      setFieldErrors({});
      toast.push('Identidade visual salva.', { tone: 'success' });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['brand-config'] }), refresh()]);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const item of error.details) if (item.field) mapped[item.field] = item.message;
        setFieldErrors(mapped);
      }
      toast.push(errorMessage(error), { tone: 'error' });
    },
  });

  const reset = useMutation({
    mutationFn: () => api.delete<BrandConfig>(base),
    onSuccess: async () => {
      setDraft(null);
      toast.push('Voltamos ao visual padrão do Estoque Simples.', { tone: 'success' });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['brand-config'] }), refresh()]);
    },
    onError: (error) => toast.push(errorMessage(error), { tone: 'error' }),
  });

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    setLogoError(null);
    setLogoBusy(0);
    try {
      const prepared = await prepareImage(file, { maxEdge: 640, targetBytes: 200 * 1024, keepAlpha: true });
      try {
        await uploadBinary(`${base}/logo`, prepared.blob, setLogoBusy);
      } finally {
        URL.revokeObjectURL(prepared.previewUrl);
      }
      track('brand.logo_picked');
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['brand-config'] }), refresh()]);
      toast.push('Logotipo atualizado.', { tone: 'success' });
    } catch (error) {
      setLogoError(error instanceof ImageError ? error.message : errorMessage(error));
    } finally {
      setLogoBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeLogo = useMutation({
    mutationFn: () => api.delete<BrandConfig>(`${base}/logo`),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['brand-config'] }), refresh()]);
      toast.push('Logotipo removido.', { tone: 'success' });
    },
    onError: (error) => toast.push(errorMessage(error), { tone: 'error' }),
  });

  const loginUrl = data?.config.slug ? `${window.location.origin}/${data.config.slug}/entrar` : null;
  const problemOf = (field: Problem['field']) => problems.find((problem) => problem.field === field);
  const dirty = !!data && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(data));

  return (
    <div className="page stack">
      <PageHeader
        title="Identidade visual"
        subtitle="Cores, fonte e logotipo da sua empresa sobre o mesmo Estoque Simples. Vale no app Android e na web."
        actions={data?.effective.active ? <Badge tone="success">Aplicada</Badge> : <Badge>Visual padrão</Badge>}
      />
      {(query.isLoading || query.error) && <QueryState loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()} />}
      {data && draft && (
          <>
            {!eligible && (
              <Notice tone="info" title="Recurso do plano Equipe">
                A identidade visual personalizada está disponível enquanto a assinatura do plano Equipe estiver ativa. {data.config.slug ? 'O que você configurou fica guardado e volta a valer quando a empresa assinar de novo.' : ''}{' '}
                <Link to="/app/plano">Ver plano</Link>
              </Notice>
            )}
            {data.config.blocked && (
              <Notice tone="warning" title="Identidade visual bloqueada pelo suporte">
                {data.config.blockedReason ?? 'Fale com o suporte para entender o motivo.'}
              </Notice>
            )}
            {eligible && !can('marca.gerenciar') && <Notice tone="warning">Só o proprietário e os administradores podem alterar a identidade visual.</Notice>}

            <div className="grid grid--2">
              <Card title="Endereço de entrada" subtitle="Uma página de login com a sua marca, usando a mesma conta do Estoque Simples">
                <div className="stack">
                  <Field label="Identificador da empresa" error={fieldErrors.slug} hint="De 3 a 32 letras minúsculas, números e hífen. Ao trocar, o endereço antigo fica reservado para você por 90 dias.">
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <span className="muted" style={{ whiteSpace: 'nowrap' }}>{window.location.host}/</span>
                      <input className="input" value={draft.slug} disabled={!editable} maxLength={32} onChange={(event) => setDraft({ ...draft, slug: slugify(event.target.value) })} aria-label="Identificador" />
                      <span className="muted">/entrar</span>
                    </div>
                  </Field>
                  {loginUrl && (
                    <div className="row" style={{ gap: 8 }}>
                      <a className="btn btn--sm" href={loginUrl} target="_blank" rel="noreferrer">Abrir página de entrada</a>
                      <button type="button" className="btn btn--sm" onClick={() => void navigator.clipboard?.writeText(loginUrl).then(() => toast.push('Endereço copiado.', { tone: 'success' }))}>Copiar endereço</button>
                    </div>
                  )}
                </div>
              </Card>

              <Card title="Logotipo" subtitle="Aparece no lugar do símbolo do Estoque Simples, no canto das telas e na página de entrada">
                <div className="stack">
                  {logoUrl ? <img src={logoUrl} alt="Logotipo atual" style={{ maxWidth: 220, maxHeight: 96, objectFit: 'contain', background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-control)', padding: 8 }} /> : <p className="muted">Nenhum logotipo enviado.</p>}
                  <div className="row" style={{ gap: 8 }}>
                    <input ref={fileInput} type="file" accept={IMAGE_ACCEPT} hidden onChange={(event) => void pickLogo(event.target.files?.[0])} />
                    <button type="button" className="btn btn--sm" disabled={!editable || logoBusy !== null || !data.config.slug} onClick={() => fileInput.current?.click()}>
                      {logoBusy !== null ? `Enviando… ${Math.round(logoBusy * 100)}%` : logoUrl ? 'Trocar logotipo' : 'Enviar logotipo'}
                    </button>
                    {logoUrl && <button type="button" className="btn btn--sm" disabled={!editable || removeLogo.isPending} onClick={() => removeLogo.mutate()}>Remover</button>}
                  </div>
                  {!data.config.slug && <p className="field__hint">Salve o identificador antes de enviar o logotipo.</p>}
                  <p className="field__hint">PNG, JPEG ou WebP. Reduzimos para até 640 px e preservamos a transparência.</p>
                  {logoError && <Notice tone="error">{logoError}</Notice>}
                </div>
              </Card>
            </div>

            <Card title="Cores e fonte" subtitle="A estrutura, o menu e os fluxos continuam exatamente os mesmos">
              <div className="stack">
                {COLORS.map(({ key, field, label, hint, fallback }) => {
                  const value = draft[key];
                  const problem = problemOf(field);
                  return (
                    <Field key={key} label={label} hint={hint} error={problem?.message ?? fieldErrors[field]}>
                      <div className="row" style={{ gap: 8 }}>
                        <input type="color" aria-label={`${label} (seletor)`} disabled={!editable} value={value ?? fallback} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} style={{ width: 44, height: 36, padding: 2 }} />
                        <input className="input" style={{ maxWidth: 130 }} disabled={!editable} value={value ?? ''} placeholder="Padrão" maxLength={7} onChange={(event) => setDraft({ ...draft, [key]: event.target.value.trim() === '' ? null : event.target.value.trim() })} />
                        {value && <button type="button" className="btn btn--sm" disabled={!editable} onClick={() => setDraft({ ...draft, [key]: null })}>Usar padrão</button>}
                        {problem?.suggestion && <button type="button" className="btn btn--sm" disabled={!editable} onClick={() => setDraft({ ...draft, [key]: problem.suggestion ?? null })}>Usar {problem.suggestion}</button>}
                      </div>
                    </Field>
                  );
                })}
                <Field label="Fonte" hint="Usamos fontes já instaladas no aparelho, sem baixar nada de terceiros.">
                  <select className="select" disabled={!editable} value={draft.font} onChange={(event) => setDraft({ ...draft, font: event.target.value as Draft['font'] })} style={{ maxWidth: 260 }}>
                    <option value="default">Padrão do Estoque Simples</option>
                    <option value="serif">Com serifa</option>
                  </select>
                </Field>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn btn--primary" disabled={!editable || save.isPending || problems.length > 0 || draft.slug.length < 3 || (!dirty && !!data.config.slug)} onClick={() => save.mutate(draft)}>
                    {save.isPending ? 'Salvando…' : 'Salvar identidade visual'}
                  </button>
                  <button type="button" className="btn" disabled={!can('marca.gerenciar') || reset.isPending || !data.config.slug} onClick={() => setConfirmReset(true)}>Voltar ao visual padrão</button>
                </div>
                {editable && <p className="field__hint">O que você vê agora nesta tela já é a prévia. Só vale para todos depois de salvar.</p>}
              </div>
            </Card>
          </>
      )}
      <ConfirmDialog open={confirmReset} onClose={() => setConfirmReset(false)} title="Voltar ao visual padrão" description="Cores, fonte e logotipo da empresa serão apagados. O identificador da página de entrada é mantido." confirmLabel="Voltar ao padrão" onConfirm={() => reset.mutateAsync().then(() => undefined)} />
    </div>
  );
}
