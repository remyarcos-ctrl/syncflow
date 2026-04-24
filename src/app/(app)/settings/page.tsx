'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import PageHeader from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, Bell, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { RegleNotification, TemplateEmail } from '@/types';

type TypeAlerte = 'be_sans_commande' | 'factures_non_rapprochees' | 'retours_en_attente' | 'all';

interface CheckResult {
  sent: boolean;
  message?: string;
  emailsSent?: number;
  alerts: { type: string; count: number; detail: string }[];
}

const TYPE_ALERTE_LABELS: Record<TypeAlerte, string> = {
  be_sans_commande: 'BEs sans commande (+7j)',
  factures_non_rapprochees: 'Factures non rapprochées (+14j)',
  retours_en_attente: 'Retours en attente',
  all: 'Toutes les alertes',
};

export default function SettingsPage() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<'notifications' | 'templates'>('notifications');

  // État pour la vérification manuelle
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);

  // État du formulaire d'ajout de règle
  const [showForm, setShowForm] = useState(false);
  const [formNom, setFormNom] = useState('');
  const [formType, setFormType] = useState<TypeAlerte>('all');
  const [formDestinataires, setFormDestinataires] = useState('');
  const [formActif, setFormActif] = useState(true);
  const [formLoading, setFormLoading] = useState(false);

  const { data: regles = [] } = useQuery<RegleNotification[]>({
    queryKey: ['regles_notifications'],
    queryFn: async () => { const { data } = await supabase.from('regles_notifications').select('*').order('nom_regle'); return data ?? []; },
  });

  const { data: templates = [] } = useQuery<TemplateEmail[]>({
    queryKey: ['templates_emails'],
    queryFn: async () => { const { data } = await supabase.from('templates_emails').select('*').order('nom_template'); return data ?? []; },
  });

  const toggleRegle = useMutation({
    mutationFn: async ({ id, actif }: { id: string; actif: boolean }) => {
      const { error } = await supabase.from('regles_notifications').update({ actif }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regles_notifications'] }),
  });

  async function handleCheck() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch('/api/notifications/check');
      const json: CheckResult = await res.json();
      setCheckResult(json);
      if (json.sent) {
        toast.success(`${json.emailsSent} email(s) envoyé(s)`);
      } else if (json.alerts.length === 0) {
        toast.success('Aucune alerte détectée');
      } else {
        toast.info(`${json.alerts.length} alerte(s) détectée(s), aucun email envoyé (aucune règle active)`);
      }
    } catch (e) {
      console.error(e);
      toast.error('Erreur lors de la vérification');
    } finally {
      setChecking(false);
    }
  }

  async function handleAddRegle(e: React.FormEvent) {
    e.preventDefault();
    if (!formNom.trim() || !formDestinataires.trim()) {
      toast.error('Nom et destinataires requis');
      return;
    }
    setFormLoading(true);
    try {
      const { error } = await supabase.from('regles_notifications').insert({
        nom_regle: formNom.trim(),
        type_alerte: formType,
        destinataires: formDestinataires.trim(),
        actif: formActif,
        type_destinataires: 'fixe',
        inclure_details: true,
        frequence: 'quotidienne',
      });
      if (error) throw error;
      toast.success('Règle ajoutée');
      qc.invalidateQueries({ queryKey: ['regles_notifications'] });
      setShowForm(false);
      setFormNom('');
      setFormType('all');
      setFormDestinataires('');
      setFormActif(true);
    } catch (e) {
      console.error(e);
      toast.error('Erreur lors de l\'ajout');
    } finally {
      setFormLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title="Paramètres" />

      <div className="flex gap-2 mb-5">
        {(['notifications', 'templates'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === t ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {t === 'notifications' ? 'Règles de notification' : 'Templates emails'}
          </button>
        ))}
      </div>

      {activeTab === 'notifications' && (
        <div className="space-y-5">
          {/* Vérification manuelle */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Bell size={16} className="text-indigo-500" />
                <h2 className="text-sm font-semibold text-gray-700">Vérification des alertes</h2>
              </div>
              <Button
                size="sm"
                onClick={handleCheck}
                disabled={checking}
                className="flex items-center gap-2"
              >
                {checking ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
                {checking ? 'Vérification…' : 'Vérifier maintenant'}
              </Button>
            </div>

            {checkResult && (
              <div className="space-y-2">
                {checkResult.alerts.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg px-4 py-3">
                    <CheckCircle size={15} />
                    <span>Aucune alerte détectée</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-4 py-3">
                      <AlertCircle size={15} />
                      <span>
                        {checkResult.alerts.length} alerte(s) détectée(s)
                        {checkResult.sent ? ` — ${checkResult.emailsSent} email(s) envoyé(s)` : ' — aucun email envoyé'}
                      </span>
                    </div>
                    <ul className="space-y-1 mt-2">
                      {checkResult.alerts.map(a => (
                        <li key={a.type} className="text-xs text-gray-600 bg-gray-50 rounded px-3 py-2">
                          <span className="font-medium text-gray-800">{TYPE_ALERTE_LABELS[a.type as TypeAlerte] ?? a.type}</span>
                          {' — '}
                          <span className="font-semibold text-indigo-600">{a.count}</span>
                          {' : '}
                          {a.detail}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Tableau des règles */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">Règles de notification</h2>
              <Button size="sm" variant="outline" onClick={() => setShowForm(v => !v)} className="flex items-center gap-1">
                <Plus size={14} />
                Ajouter
              </Button>
            </div>

            {/* Formulaire d'ajout */}
            {showForm && (
              <form onSubmit={handleAddRegle} className="p-4 border-b border-gray-100 bg-gray-50/50">
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Nom de la règle</label>
                    <Input
                      value={formNom}
                      onChange={e => setFormNom(e.target.value)}
                      placeholder="Ex. Alerte quotidienne"
                      className="text-sm"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Type d&apos;alerte</label>
                    <select
                      value={formType}
                      onChange={e => setFormType(e.target.value as TypeAlerte)}
                      className="w-full h-9 rounded-md border border-input bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {(Object.entries(TYPE_ALERTE_LABELS) as [TypeAlerte, string][]).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Destinataires (séparés par virgule)</label>
                    <Input
                      value={formDestinataires}
                      onChange={e => setFormDestinataires(e.target.value)}
                      placeholder="email1@ex.com, email2@ex.com"
                      type="text"
                      className="text-sm"
                      required
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <input
                      id="form-actif"
                      type="checkbox"
                      checked={formActif}
                      onChange={e => setFormActif(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600"
                    />
                    <label htmlFor="form-actif" className="text-sm text-gray-700">Activer immédiatement</label>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={formLoading} className="flex items-center gap-1">
                    {formLoading ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                    Enregistrer
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                    Annuler
                  </Button>
                </div>
              </form>
            )}

            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50/50 border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Nom</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Type alerte</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Destinataires</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Actif</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {regles.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50/30">
                    <td className="px-4 py-3 font-medium">{r.nom_regle}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {TYPE_ALERTE_LABELS[r.type_alerte as TypeAlerte] ?? r.type_alerte}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate">{r.destinataires}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggleRegle.mutate({ id: r.id, actif: !r.actif })}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${r.actif ? 'bg-indigo-600' : 'bg-gray-200'}`}
                      >
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${r.actif ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {regles.length === 0 && !showForm && (
              <p className="text-sm text-gray-400 text-center py-10">Aucune règle de notification</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'templates' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Template</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Sujet</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Par défaut</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-50">
              {templates.map(t => (
                <tr key={t.id} className="hover:bg-gray-50/30">
                  <td className="px-4 py-3 font-medium">{t.nom_template}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{t.type_document}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[250px] truncate">{t.sujet}</td>
                  <td className="px-4 py-3 text-xs">{t.par_defaut ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {templates.length === 0 && <p className="text-sm text-gray-400 text-center py-10">Aucun template</p>}
        </div>
      )}
    </div>
  );
}
