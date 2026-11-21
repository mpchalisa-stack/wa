import React, { useState } from 'react';
import { Check, Users, X } from 'lucide-react';
import { Contact } from '../types';
import { PRESET_AVATARS, formatSixDigitId } from '../lib/media';
import { Avatar } from './Avatar';

interface NewGroupModalProps {
  contacts: Contact[];
  onCreateGroup: (name: string, memberIds: string[], avatar: string) => void;
  onClose: () => void;
}

export const NewGroupModal: React.FC<NewGroupModalProps> = ({
  contacts,
  onCreateGroup,
  onClose,
}) => {
  const individualContacts = contacts.filter((c) => !c.isGroup);
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [manualId, setManualId] = useState('');
  const [groupAvatar, setGroupAvatar] = useState(PRESET_AVATARS[0].id);
  const [error, setError] = useState('');

  const toggleMember = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
    if (error) setError('');
  };

  const handleAddManualId = () => {
    const clean = manualId.replace(/\D/g, '');
    if (clean.length !== 6) {
      setError('ID anggota harus 6 digit angka.');
      return;
    }
    if (!selectedIds.includes(clean)) {
      setSelectedIds((prev) => [...prev, clean]);
    }
    setManualId('');
    setError('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) {
      setError('Masukkan nama grup terlebih dahulu.');
      return;
    }
    if (selectedIds.length === 0) {
      setError('Pilih minimal 1 anggota untuk membuat grup.');
      return;
    }
    onCreateGroup(groupName.trim(), selectedIds, groupAvatar);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[88dvh] flex flex-col rounded-2xl bg-white dark:bg-[#233138] shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-[#008069] dark:bg-[#1F2C34] text-white px-5 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5" />
            <div>
              <h2 className="text-base font-semibold leading-tight">Grup Baru (P2P)</h2>
              <p className="text-xs text-white/75">{selectedIds.length} anggota dipilih</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="p-5 space-y-4 border-b border-black/5 dark:border-white/10 shrink-0">
            <div className="flex items-center gap-3.5">
              <Avatar src={groupAvatar} name={groupName || 'Grup'} size="lg" isGroup />
              <div className="flex-1">
                <input
                  type="text"
                  maxLength={40}
                  value={groupName}
                  onChange={(e) => {
                    setGroupName(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="Ketik subjek / nama grup..."
                  autoFocus
                  className="w-full h-11 px-3.5 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] text-sm text-[#111B21] dark:text-[#E9EDEF] placeholder:text-[#8696A0] focus:outline-none focus:ring-2 focus:ring-[#00A884]"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              {PRESET_AVATARS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setGroupAvatar(p.id)}
                  style={{ backgroundColor: p.bg }}
                  className={`w-7 h-7 rounded-full flex items-center justify-center cursor-pointer ${
                    groupAvatar === p.id ? 'ring-2 ring-offset-2 ring-[#00A884] dark:ring-offset-[#233138]' : 'opacity-75'
                  }`}
                >
                  {groupAvatar === p.id && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>

            {/* Quick add 6-digit ID directly into group */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={manualId}
                onChange={(e) => setManualId(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Tambah ID 6 digit langsung..."
                className="flex-1 h-10 px-3 rounded-xl bg-[#F0F2F5] dark:bg-[#111B21] text-xs font-mono-id text-[#111B21] dark:text-[#E9EDEF] placeholder:font-sans placeholder:text-[#8696A0] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddManualId}
                className="h-10 px-3.5 rounded-xl bg-[#008069]/15 dark:bg-[#00A884]/20 text-[#008069] dark:text-[#00A884] text-xs font-semibold hover:bg-[#008069]/25 cursor-pointer"
              >
                Tambah
              </button>
            </div>
          </div>

          {/* Contact Selection List */}
          <div className="flex-1 overflow-y-auto wa-scroll p-2">
            {individualContacts.length === 0 && selectedIds.length === 0 ? (
              <div className="py-8 px-4 text-center text-xs text-[#667781] dark:text-[#8696A0]">
                Belum ada kontak tersimpan. Anda tetap bisa menambahkan anggota langsung menggunakan kolom ID 6 digit di atas.
              </div>
            ) : (
              <div className="divide-y divide-black/5 dark:divide-white/5">
                {/* Manually added IDs not yet in contacts */}
                {selectedIds
                  .filter((id) => !individualContacts.some((c) => c.id === id))
                  .map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleMember(id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                    >
                      <Avatar name={id} size="md" />
                      <div className="flex-1 text-left min-w-0">
                        <div className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF] font-mono-id">
                          ID {formatSixDigitId(id)}
                        </div>
                        <div className="text-xs text-[#667781] dark:text-[#8696A0]">Ditambahkan manual</div>
                      </div>
                      <span className="w-6 h-6 rounded-full bg-[#00A884] text-white flex items-center justify-center">
                        <Check className="w-3.5 h-3.5" strokeWidth={3} />
                      </span>
                    </button>
                  ))}

                {individualContacts.map((contact) => {
                  const checked = selectedIds.includes(contact.id);
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={() => toggleMember(contact.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[#F5F6F6] dark:hover:bg-[#182229] transition-colors cursor-pointer"
                    >
                      <Avatar src={contact.avatar} name={contact.name} size="md" />
                      <div className="flex-1 text-left min-w-0">
                        <div className="text-sm font-medium text-[#111B21] dark:text-[#E9EDEF] truncate">
                          {contact.name}
                        </div>
                        <div className="text-xs text-[#667781] dark:text-[#8696A0] font-mono-id">
                          ID: {formatSixDigitId(contact.id)}
                        </div>
                      </div>
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center border transition-colors ${
                          checked
                            ? 'bg-[#00A884] border-[#00A884] text-white'
                            : 'border-[#8696A0]/50'
                        }`}
                      >
                        {checked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-4 border-t border-black/5 dark:border-white/10 shrink-0">
            {error && <p className="mb-2 text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
            <button
              type="submit"
              className="w-full h-11 rounded-xl bg-[#008069] hover:bg-[#017561] dark:bg-[#00A884] dark:hover:bg-[#06CF9C] text-white dark:text-[#111B21] text-sm font-semibold transition-colors cursor-pointer"
            >
              Buat Grup ({selectedIds.length})
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
