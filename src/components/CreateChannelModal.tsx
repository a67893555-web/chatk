import React, { useState } from 'react';
import { X } from 'lucide-react';
import { ChannelType, UserProfile } from '../shared/types';

interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: UserProfile[];
  currentUserId: string;
  onCreate: (params: {
    name: string;
    description: string;
    type: ChannelType;
    memberIds: string[];
    simulatedLargeGroupCount?: number;
  }) => Promise<unknown>;
}

export const CreateChannelModal: React.FC<CreateChannelModalProps> = ({
  isOpen,
  onClose,
  users,
  currentUserId,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ChannelType>(ChannelType.GROUP);
  const [selectedPeers, setSelectedPeers] = useState<string[]>(['u-marcus']);
  const [largeGroupScale, setLargeGroupScale] = useState<number>(25_000);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const peers = users.filter((u) => u.id !== currentUserId);

  const togglePeer = (id: string) => {
    setSelectedPeers((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      setValidationError('Channel name must be at least 2 characters.');
      return;
    }
    if (selectedPeers.length === 0) {
      setValidationError('Select at least one participant.');
      return;
    }

    setValidationError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: cleanName,
        description: description.trim(),
        type,
        memberIds: selectedPeers,
        simulatedLargeGroupCount:
          type === ChannelType.GROUP ? largeGroupScale : undefined,
      });
      setName('');
      setDescription('');
      onClose();
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Unable to create channel');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-channel-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
    >
      <div className="w-full max-w-md bg-white rounded-xl border border-slate-200 shadow-lg p-6">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200">
          <h2 id="create-channel-title" className="text-base font-bold text-slate-900">
            Create Synchronized Channel
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
          <div>
            <span className="block text-xs font-semibold text-slate-700 mb-1.5">
              Channel Topology
            </span>
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setType(ChannelType.GROUP)}
                className={`py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  type === ChannelType.GROUP
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Scalable Group
              </button>
              <button
                type="button"
                onClick={() => setType(ChannelType.DIRECT)}
                className={`py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  type === ChannelType.DIRECT
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Direct 1-to-1
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="ch-name-input" className="block text-xs font-semibold text-slate-700 mb-1">
              Channel Name
            </label>
            <input
              id="ch-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === ChannelType.GROUP ? 'e.g. edge-routing-wg' : 'e.g. Tomasz Kowalski'}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          <div>
            <label htmlFor="ch-desc-input" className="block text-xs font-semibold text-slate-700 mb-1">
              Topic / Purpose
            </label>
            <input
              id="ch-desc-input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="ScyllaDB partition keys & fan-out coordination"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          {type === ChannelType.GROUP && (
            <div>
              <label htmlFor="ch-scale-select" className="block text-xs font-semibold text-slate-700 mb-1">
                Provisioned Member Capacity Tier
              </label>
              <select
                id="ch-scale-select"
                value={largeGroupScale}
                onChange={(e) => setLargeGroupScale(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-lg text-slate-900"
              >
                <option value={50}>Standard Group (50 members · Direct Pub/Sub)</option>
                <option value={25000}>Large Guild (25,000 members · Sharded Worker Pool)</option>
                <option value={100000}>Mega Broadcast (100,000 members · 500-batch Fan-out)</option>
              </select>
            </div>
          )}

          <div>
            <span className="block text-xs font-semibold text-slate-700 mb-1.5">
              Include Active Workspace Engineers
            </span>
            <div className="space-y-1.5">
              {peers.map((peer) => {
                const checked = selectedPeers.includes(peer.id);
                return (
                  <label
                    key={peer.id}
                    className="flex items-center justify-between px-3 py-2 border border-slate-200 rounded-lg text-xs cursor-pointer hover:bg-slate-50"
                  >
                    <span className="font-medium text-slate-800">
                      {peer.displayName}{' '}
                      <span className="text-slate-400 font-normal">· {peer.title}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePeer(peer.id)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                  </label>
                );
              })}
            </div>
          </div>

          {validationError && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {validationError}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 cursor-pointer disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
