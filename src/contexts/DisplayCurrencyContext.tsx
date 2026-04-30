'use client';

import { createContext, useContext, useState, useCallback } from 'react';

type DisplayCurrencyContextType = {
  showTTC: boolean;
  toggle: () => void;
};

const DisplayCurrencyContext = createContext<DisplayCurrencyContextType>({
  showTTC: false,
  toggle: () => {},
});

export function DisplayCurrencyProvider({ children }: { children: React.ReactNode }) {
  const [showTTC, setShowTTC] = useState(false);
  const toggle = useCallback(() => setShowTTC(v => !v), []);
  return (
    <DisplayCurrencyContext.Provider value={{ showTTC, toggle }}>
      {children}
    </DisplayCurrencyContext.Provider>
  );
}

export const useDisplayCurrency = () => useContext(DisplayCurrencyContext);
