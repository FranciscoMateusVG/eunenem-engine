import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

// Plan 0017 / aperture-16flf — tiny context for the drawer's open/closed
// state. The drawer lives at PaginaPage level (so it overlays the whole
// page chrome) but the triggers — Navbar CartButton, Marketplace
// onAdd → autoOpen, success-page CTA, etc — sit elsewhere in the tree.
// This keeps the trigger surface uniform without prop-drilling.

interface CartDrawerContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /**
   * aperture-v6mpf (Thacy QA) — true while ANY purchase overlay covers the
   * page: the cart drawer (isOpen) OR the single-gift GiftCheckoutModal
   * (reported by Marketplace via setCheckoutModalOpen). PaginaPage gates the
   * floating TweaksPanel on it so the personalization FAB never paints over
   * the payment flow.
   */
  purchaseOverlayVisible: boolean;
  setCheckoutModalOpen: (open: boolean) => void;
}

const CartDrawerContext = createContext<CartDrawerContextValue | null>(null);

export function CartDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  const value = useMemo(
    () => ({
      isOpen,
      open,
      close,
      toggle,
      purchaseOverlayVisible: isOpen || checkoutModalOpen,
      setCheckoutModalOpen,
    }),
    [isOpen, open, close, toggle, checkoutModalOpen],
  );

  return (
    <CartDrawerContext.Provider value={value}>
      {children}
    </CartDrawerContext.Provider>
  );
}

export function useCartDrawer(): CartDrawerContextValue {
  const ctx = useContext(CartDrawerContext);
  if (!ctx) {
    throw new Error("useCartDrawer must be used inside <CartDrawerProvider>");
  }
  return ctx;
}
