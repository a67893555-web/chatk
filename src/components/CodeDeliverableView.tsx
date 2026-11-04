import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { DELIVERABLE_DOCUMENTS, DeliverableDocument } from '../deliverables/referenceSpecs';

interface CodeDeliverableViewProps {
  category: DeliverableDocument['category'];
}

const SECTION_HEADINGS: Record<
  DeliverableDocument['category'],
  { title: string; subtitle: string }
> = {
  schemas: {
    title: 'Database & Storage Schemas (PostgreSQL, ScyllaDB & Redis Cluster)',
    subtitle:
      'Production DDL, wide-column CQL partitioning definitions, and atomic Redis Lua scripts for connection routing and rate limiting.',
  },
  pipeline: {
    title: 'WebSocket Connection Manager & Idempotent Message Pipeline',
    subtitle:
      'Production Node.js/TypeScript services handling RFC 6455 heartbeats, 60s Redis presence TTLs, 24h idempotency locks, ScyllaDB LOCAL_QUORUM writes, and 100k-member sharded fan-out.',
  },
  'client-sync': {
    title: 'Client IndexedDB Offline Store & Multi-Device Sync Engine',
    subtitle:
      'Resilient client synchronization logic implementing IndexedDB persistence, Full-Jitter exponential backoff, /sync?cursor= catch-up, and client_msg_id deduplication.',
  },
};

export const CodeDeliverableView: React.FC<CodeDeliverableViewProps> = ({ category }) => {
  const docs = useMemo(
    () =>
      DELIVERABLE_DOCUMENTS.filter((d) =>
        category === 'pipeline'
          ? d.category === 'pipeline' || d.category === 'client-sync'
          : d.category === category
      ),
    [category]
  );

  const [selectedId, setSelectedId] = useState<string>(docs[0]?.id ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (docs.length > 0 && !docs.some((d) => d.id === selectedId)) {
      setSelectedId(docs[0].id);
    }
  }, [docs, selectedId]);

  const activeDoc = docs.find((d) => d.id === selectedId) ?? docs[0];
  const headerMeta = SECTION_HEADINGS[category];

  const handleCopy = async () => {
    if (!activeDoc) return;
    try {
      await navigator.clipboard.writeText(activeDoc.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API fallback ignored safely
    }
  };

  if (!activeDoc) return null;

  const codeLines = activeDoc.code.split('\n');

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="border-b border-slate-200 pb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {headerMeta.title}
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 max-w-3xl leading-relaxed">
            {headerMeta.subtitle}
          </p>
        </div>

        {/* File Selector Segmented Control (when category has multiple deliverables) */}
        {docs.length > 1 && (
          <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            {docs.map((doc) => {
              const active = doc.id === activeDoc.id;
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => setSelectedId(doc.id)}
                  className={`px-3.5 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {doc.filename}
                </button>
              );
            })}
          </div>
        )}

        {/* Architectural Summary & Highlights */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">{activeDoc.title}</h2>
            <span className="text-xs font-mono text-slate-500">
              {activeDoc.filename} · {codeLines.length} lines
            </span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">{activeDoc.summary}</p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 pt-2 border-t border-slate-100 text-xs text-slate-700">
            {activeDoc.highlights.map((item) => (
              <li key={item} className="leading-relaxed">
                • {item}
              </li>
            ))}
          </ul>
        </div>

        {/* Code Viewer */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
            <span className="text-xs font-mono text-slate-300">{activeDoc.filename}</span>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Source
                </>
              )}
            </button>
          </div>

          <div className="overflow-x-auto p-4">
            <pre className="text-xs leading-relaxed font-mono text-slate-100 tabular-nums">
              <code>
                {codeLines.map((line, i) => (
                  <div key={i} className="table-row">
                    <span
                      aria-hidden="true"
                      className="table-cell pr-4 text-right select-none text-slate-600"
                    >
                      {i + 1}
                    </span>
                    <span className="table-cell whitespace-pre">{line}</span>
                  </div>
                ))}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
