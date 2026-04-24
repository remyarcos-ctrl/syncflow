'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, Send, X, Loader2, Sparkles, User, RotateCcw } from 'lucide-react';
import { cn } from '@/utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'Quelles factures ne sont pas rapprochées ?',
  'Combien d\'exceptions critiques sont ouvertes ?',
  'Quel est le montant total des factures ce mois ?',
  'Résume l\'activité des 7 derniers jours',
];

export default function ChatAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: Message = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json() as { reply?: string; error?: string };
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply ?? data.error ?? 'Erreur.',
      }]);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Désolé, une erreur est survenue.' }]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading]);

  return (
    <>
      {/* Panneau chat */}
      {open && (
        <div className="fixed bottom-20 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-6rem)] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Teddy</p>
              <p className="text-xs text-indigo-200">Posez vos questions sur vos données</p>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={() => setMessages([])}
                  title="Nouvelle conversation"
                  className="p-1.5 rounded-lg hover:bg-white/20 text-white/70 hover:text-white transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg hover:bg-white/20 text-white/70 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col gap-2 pt-2">
                <p className="text-xs text-gray-400 text-center mb-1">Suggestions</p>
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => sendMessage(s)}
                    className="text-left text-xs px-3 py-2 rounded-xl border border-gray-100 hover:border-indigo-200 hover:bg-indigo-50 transition-all text-gray-600 hover:text-indigo-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={cn('flex gap-2', m.role === 'user' ? 'flex-row-reverse' : '')}>
                <div className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                  m.role === 'assistant' ? 'bg-gradient-to-br from-indigo-500 to-purple-600' : 'bg-gray-200'
                )}>
                  {m.role === 'assistant'
                    ? <Bot className="w-3.5 h-3.5 text-white" />
                    : <User className="w-3 h-3 text-gray-500" />
                  }
                </div>
                <div className={cn(
                  'max-w-[82%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap',
                  m.role === 'assistant'
                    ? 'bg-gray-50 border border-gray-100 text-gray-800'
                    : 'bg-indigo-600 text-white'
                )}>
                  {m.content}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex gap-2">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="bg-gray-50 border border-gray-100 rounded-2xl px-3 py-2.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={e => { e.preventDefault(); sendMessage(input); }}
            className="flex gap-2 p-3 border-t border-gray-100 shrink-0"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Posez une question..."
              disabled={isLoading}
              className="flex-1 text-xs rounded-xl border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 flex items-center justify-center transition-colors shrink-0"
            >
              <Send className="w-3.5 h-3.5 text-white" />
            </button>
          </form>
        </div>
      )}

      {/* Bouton flottant */}
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'fixed bottom-4 right-4 z-50 w-13 h-13 rounded-2xl shadow-lg flex items-center justify-center transition-all duration-200',
          open
            ? 'bg-gray-700 hover:bg-gray-800 scale-95'
            : 'bg-gradient-to-br from-indigo-500 to-purple-600 hover:scale-105 hover:shadow-indigo-200 hover:shadow-xl'
        )}
        style={{ width: 52, height: 52 }}
        title="Teddy — Assistant IA"
      >
        {open
          ? <X className="w-5 h-5 text-white" />
          : <Bot className="w-5 h-5 text-white" />
        }
        {!open && messages.length === 0 && (
          <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-400 border-2 border-white" />
        )}
      </button>
    </>
  );
}
