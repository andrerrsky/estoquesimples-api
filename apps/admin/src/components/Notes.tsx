import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, Empty, Skeleton, Time, useToast } from './ui';

interface Note {
  id: string;
  adminEmail: string;
  body: string;
  createdAt: string;
}

/**
 * Notas de suporte: o que o cliente relatou, o que foi combinado, o que
 * ficou pendente. Ficam com a conta em vez de num chat perdido.
 */
export function NotesPanel({ path, queryKey }: { path: string; queryKey: unknown[] }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const query = useQuery({ queryKey: [...queryKey, 'notes'], queryFn: () => api.get<{ items: Note[] }>(path) });

  const add = useMutation({
    mutationFn: (text: string) => api.post(path, { body: text }),
    onSuccess: () => {
      setBody('');
      toast.push('Nota adicionada.', 'success');
      void queryClient.invalidateQueries({ queryKey: [...queryKey, 'notes'] });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/notes/${id}`),
    onSuccess: () => {
      toast.push('Nota removida.');
      void queryClient.invalidateQueries({ queryKey: [...queryKey, 'notes'] });
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body.trim().length === 0) return;
    add.mutate(body.trim());
  };

  return (
    <div className="stack">
      {can('support') && (
        <form onSubmit={submit} className="stack stack--tight">
          <textarea
            className="textarea"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Ex.: cliente ligou dizendo que o aparelho novo não baixa o estoque; orientado a fazer login de novo."
            maxLength={4000}
            rows={3}
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn--primary btn--sm" disabled={add.isPending || body.trim().length === 0}>
              Adicionar nota
            </button>
          </div>
        </form>
      )}
      {query.isLoading ? (
        <Skeleton />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <Empty icon="note" title="Sem notas de suporte" />
      ) : (
        <div className="list">
          {query.data?.items.map((note) => (
            <div key={note.id} className="list__item" style={{ alignItems: 'flex-start' }}>
              <div className="list__main">
                <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
                <div className="list__sub" style={{ marginTop: 4 }}>
                  {note.adminEmail} · <Time value={note.createdAt} relative={false} />
                </div>
              </div>
              {can('support') && (
                <button type="button" className="btn btn--link small" onClick={() => remove.mutate(note.id)} disabled={remove.isPending}>
                  remover
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
