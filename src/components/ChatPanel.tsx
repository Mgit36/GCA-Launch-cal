'use client';

import { useState, useRef, useEffect } from 'react';

type ChatMessage = {
  role: 'user' | 'agent';
  text: string;
  proposal?: any;
  awaitingConfirmation?: boolean;
};

const STORAGE_KEY = 'launch-calendar-chat';

const GREETING: ChatMessage = {
  role: 'agent',
  text: "Tell me about a launch — a new one, or an update to an existing one. Send it the way you'd naturally tell a person.",
};

function loadStoredMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [GREETING];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [GREETING];
  } catch {
    return [GREETING];
  }
}

export function ChatPanel({ onClose, onDataChanged }: { onClose: () => void; onDataChanged?: () => void }) {
  // Always starts from the greeting so server and client render the same HTML
  // on first paint (reading localStorage during the initial render would make
  // that render diverge from the server-rendered markup and fail hydration).
  // The real conversation, if any, loads right after mount instead.
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(loadStoredMessages());
    setHydrated(true);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!hydrated) return; // don't clobber storage with the placeholder greeting
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Private browsing / storage disabled - conversation just won't persist.
    }
  }, [messages, hydrated]);

  async function send(text: string, isConfirmationReply = false, pendingProposal?: any) {
    if (!text.trim()) return;
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    setLoading(true);

    try {
      const body = isConfirmationReply
        ? buildConfirmationBody(text, pendingProposal)
        : { message: text };

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      setMessages((m) => [
        ...m,
        {
          role: 'agent',
          text: data.agentMessage,
          proposal: data.proposal,
          awaitingConfirmation: data.type === 'confirmation_needed',
        },
      ]);

      // A 'done' response is the only one that can have written to the DB
      // (confirmation_needed/unresolved never do) - refresh the table behind the panel.
      if (data.type === 'done') onDataChanged?.();
    } catch {
      setMessages((m) => [...m, { role: 'agent', text: 'Something went wrong. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  }

  function buildConfirmationBody(replyText: string, proposal: any) {
    const lower = replyText.trim().toLowerCase();
    const isYes = ['yes', 'y', 'yeah', 'correct', 'confirm'].includes(lower);
    const isBareNo = ['no', 'n', 'nope'].includes(lower);

    if (isYes) return { proposal, confirm: true };
    if (isBareNo) return { proposal, confirm: false };
    // Anything else is treated as a partial correction, not a bare no.
    return { proposal, confirm: false, correctionText: replyText };
  }

  const lastAgentMsg = [...messages].reverse().find((m) => m.role === 'agent');
  const awaitingConfirmation = lastAgentMsg?.awaitingConfirmation;

  return (
    <div className="fixed bottom-24 right-6 z-50 flex h-[32rem] w-96 max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-neutral-200 bg-[#faf9f7] shadow-2xl">
      <header className="flex items-center justify-between rounded-t-2xl border-b border-neutral-200 bg-white px-4 py-3">
        <h2 className="font-serif text-sm text-neutral-900">Launch Calendar Agent</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-900"
          aria-label="Close chat"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-snug ${
                m.role === 'user'
                  ? 'bg-neutral-900 text-white'
                  : 'bg-white border border-neutral-200 text-neutral-800'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {loading && <div className="text-xs text-neutral-400">thinking…</div>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input, awaitingConfirmation, lastAgentMsg?.proposal);
        }}
        className="border-t border-neutral-200 px-3 py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={awaitingConfirmation ? 'Confirm, correct, or reply...' : 'Type a launch update...'}
          className="w-full rounded-full border border-neutral-300 px-3.5 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-400"
        />
      </form>
    </div>
  );
}
