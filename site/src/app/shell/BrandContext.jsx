import { createContext, useCallback, useContext, useMemo, useState } from "react";

const BrandContext = createContext(null);
const storageKey = (userId) => `metta:brand:${userId}`;

function readBrand(userId) {
  if (!userId) return null;
  try {
    return localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
}

function writeBrand(userId, brandId) {
  if (!userId) return;
  try {
    localStorage.setItem(storageKey(userId), brandId);
  } catch {
    /* private mode or blocked storage: the choice lasts until reload */
  }
}

// Current brand for clients with more than one; staff get an empty list.
export function BrandProvider({ user, children }) {
  const userId = user?.id;
  const brands = useMemo(
    () => (user?.role === "client" ? user.brands || [] : []),
    [user],
  );
  const [chosen, setChosen] = useState(() => readBrand(userId));
  const brand = brands.find((item) => item.id === chosen) || brands[0] || null;
  const setBrandId = useCallback(
    (id) => {
      setChosen(id);
      writeBrand(userId, id);
    },
    [userId],
  );
  const value = useMemo(
    () => ({ brands, brand, brandId: brand?.id ?? null, setBrandId }),
    [brands, brand, setBrandId],
  );
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

const empty = { brands: [], brand: null, brandId: null, setBrandId: () => {} };

export function useBrand() {
  return useContext(BrandContext) || empty;
}
