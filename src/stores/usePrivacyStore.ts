import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * "Show emails": one choice per browser that every screen naming accounts follows (Quota,
 * Analytics). Off by default, so screens show a masked form until someone asks for the address.
 */
interface PrivacyState {
  revealEmails: boolean;
  setRevealEmails: (reveal: boolean) => void;
}

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set) => ({
      revealEmails: false,
      setRevealEmails: (revealEmails) => set({ revealEmails }),
    }),
    {
      name: 'proxui-privacy',
      merge: (persisted, current) => ({
        ...current,
        revealEmails: (persisted as Partial<PrivacyState> | undefined)?.revealEmails === true,
      }),
    }
  )
);

// Another tab changing the choice updates this one, so turning it off hides addresses everywhere.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === 'proxui-privacy') void usePrivacyStore.persist.rehydrate();
  });
