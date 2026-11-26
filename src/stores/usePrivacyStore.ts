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
