'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import PageHeader from '@/components/shared/PageHeader';
import EmptyState from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Building2, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Fournisseur } from '@/types';

export default function FournisseursPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ nom: '', aliases: '', email_domaine: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ nom: '', aliases: '', email_domaine: '' });

  const { data: fournisseurs = [] } = useQuery<Fournisseur[]>({
    queryKey: ['fournisseurs'],
    queryFn: async () => {
      const { data } = await supabase.from('fournisseurs').select('*').order('nom').limit(500);
      return data ?? [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('fournisseurs').insert({ nom: form.nom, aliases: form.aliases || null, email_domaine: form.email_domaine || null });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fournisseurs'] });
      setShowCreate(false);
      setForm({ nom: '', aliases: '', email_domaine: '' });
      toast.success('Fournisseur créé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('fournisseurs').update({ nom: editForm.nom, aliases: editForm.aliases || null, email_domaine: editForm.email_domaine || null }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fournisseurs'] });
      setEditing(null);
      toast.success('Fournisseur mis à jour');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('fournisseurs').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fournisseurs'] }); toast.success('Fournisseur supprimé'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const startEdit = (f: Fournisseur) => {
    setEditing(f.id);
    setEditForm({ nom: f.nom, aliases: f.aliases ?? '', email_domaine: f.email_domaine ?? '' });
  };

  return (
    <div>
      <PageHeader
        title="Fournisseurs"
        subtitle={`${fournisseurs.length} fournisseur${fournisseurs.length > 1 ? 's' : ''}`}
        actions={<Button size="sm" onClick={() => setShowCreate(true)}><Plus className="w-4 h-4" /> Nouveau</Button>}
      />

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Nom</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aliases</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Domaine email</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {fournisseurs.map(f => (
              <tr key={f.id} className="hover:bg-gray-50/30">
                <td className="px-4 py-3">
                  {editing === f.id
                    ? <Input value={editForm.nom} onChange={e => setEditForm({ ...editForm, nom: e.target.value })} className="h-7 text-xs" />
                    : <span className="font-medium">{f.nom}</span>}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {editing === f.id
                    ? <Input value={editForm.aliases} onChange={e => setEditForm({ ...editForm, aliases: e.target.value })} className="h-7 text-xs" placeholder="alias1, alias2" />
                    : f.aliases ?? '—'}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {editing === f.id
                    ? <Input value={editForm.email_domaine} onChange={e => setEditForm({ ...editForm, email_domaine: e.target.value })} className="h-7 text-xs" placeholder="fournisseur.fr" />
                    : f.email_domaine ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {editing === f.id ? (
                      <>
                        <button className="p-1.5 rounded hover:bg-emerald-50 text-emerald-500" onClick={() => updateMutation.mutate(f.id)}><Check className="w-3.5 h-3.5" /></button>
                        <button className="p-1.5 rounded hover:bg-gray-100 text-gray-400" onClick={() => setEditing(null)}><X className="w-3.5 h-3.5" /></button>
                      </>
                    ) : (
                      <>
                        <button className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" onClick={() => startEdit(f)}><Pencil className="w-3.5 h-3.5" /></button>
                        <button className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500" onClick={() => deleteMutation.mutate(f.id)}><Trash2 className="w-3.5 h-3.5" /></button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {fournisseurs.length === 0 && <EmptyState icon={Building2} title="Aucun fournisseur" />}
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Nouveau fournisseur</h2>
            <div className="space-y-3">
              <div><label className="text-xs font-medium text-gray-700 mb-1 block">Nom *</label><Input value={form.nom} onChange={e => setForm({ ...form, nom: e.target.value })} /></div>
              <div><label className="text-xs font-medium text-gray-700 mb-1 block">Aliases (séparés par virgules)</label><Input value={form.aliases} onChange={e => setForm({ ...form, aliases: e.target.value })} placeholder="Umarex, UMAREX GmbH" /></div>
              <div><label className="text-xs font-medium text-gray-700 mb-1 block">Domaine email</label><Input value={form.email_domaine} onChange={e => setForm({ ...form, email_domaine: e.target.value })} placeholder="umarex.de" /></div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowCreate(false)}>Annuler</Button>
              <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !form.nom}>
                {createMutation.isPending ? 'Création...' : 'Créer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
