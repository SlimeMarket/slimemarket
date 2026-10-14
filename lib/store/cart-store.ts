/**
 * Shopping Cart Store - Zustand
 *
 * Provides persistent cart state across sessions
 * Syncs with backend cookie-based cart storage
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { computeFee } from '@/lib/fee';

// Interface for cart items
export interface CartItem {
  id: string;
  productId: string;
  variantIndex?: number;
  quantity: number;
  productName: string;
  price: number;
  imageUrl?: string;
  deliveryType: 'instant' | 'manual';
}

// Interface for cart total calculations
interface CartTotals {
  subtotal: number;      // Before fees (micro-USDC)
  platformFee: number;   // 2% buyer-pays platform fee (micro-USDC)
  total: number;         // Final total including the fee (micro-USDC)
}

// Main cart store interface
interface CartState {
  // State
  items: CartItem[];
  isLoading: boolean;

  // Actions
  addItem: (product: any, variantIndex?: number, qty?: number) => void;
  removeItem: (itemId: string) => void;
  updateQuantity: (itemId: string, quantity: number) => void;
  clearCart: () => void;
  calculateTotals: () => CartTotals;
  getItemCount: () => number;
  isNotEmpty: () => boolean;

  // Helper methods
  getCartSummary: () => CartItem[];
  syncWithBackend: () => Promise<void>;
}

/**
 * Calculate cart totals based on items and pricing rules
 */
export function calculateCartTotals(items: CartItem[]): CartTotals {
  // Filter out zero-quantity items first.
  const activeItems = items.filter(item => item.quantity > 0);

  /**
   * normalise each unit price before it reaches BigInt.
   *
   * `BigInt(20.5)` does NOT truncate to `20n`; it THROWS:
   *   RangeError: The number 20.5 cannot be converted to a BigInt because it is
   *   not an integer
   * So one item priced at a fractional USDC value crashed `calculateTotals()`
   * and took the entire cart page down — a far worse failure than a wrong fee.
   *
   * `price` is documented as micro-USDC (an integer), and `CartPage` renders
   * these totals with `/ 1_000_000`. Round defensively anyway so malformed or
   * float-derived input can never reach `BigInt`, and clamp negatives/NaN to 0.
   */
  const toMicro = (n: number): number => {
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n);
  };

  // Subtotal (micro-USDC).
  const subtotal = activeItems.reduce(
    (sum, item) => sum + toMicro(item.price) * Math.max(0, Math.floor(item.quantity)),
    0
  );

  // 2% BUYER-pays platform fee (non-refundable), mirroring the contract's
  // `computeFee` / lib/fee. The old 2% "seller fee" + 5% placeholder + $4 WL
  // base fee were legacy and are removed.

  // NOTE ON THE SELLER SIDE: the seller does NOT receive 100% here. On a
  // MARKETPLACE order the seller receives `price − 2%` (contract
  // SELLER_FEE_BPS = 200) and the platform takes 4% total; only WL/rekber deals
  // pay the seller 100%. See lib/fee.ts.
  const platformFee = Number(computeFee(BigInt(subtotal)));

  // Total is the amount the buyer pays: item price + 2% platform fee.
  const total = subtotal + platformFee;

  return {
    subtotal,
    platformFee,
    total
  };
}

/**
 * Create cart store using Zustand with persistence
 */
export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      // Initial state
      items: [],
      isLoading: false,

      // Add item to cart
      addItem: (product, variantIndex = 0, qty = 1) => {
        const { items } = get();

        // Check if item already exists with same variant
        const existingItem = items.find(
          item => item.productId === product.id && item.variantIndex === variantIndex
        );

        if (existingItem) {
          // Update quantity
          set({
            items: items.map(item =>
              item === existingItem
                ? { ...item, quantity: item.quantity + qty }
                : item
            )
          });
        } else {
          // Add new item
          const newItem: CartItem = {
            id: `${product.id}-variant-${variantIndex}-${Date.now()}`,
            productId: product.id,
            variantIndex,
            quantity: qty,
            productName: product.name,
            price: variantIndex >= 0 && product.variants?.[variantIndex]
              ? product.variants[variantIndex].price
              : product.price,
            imageUrl: product.image,
            deliveryType: product.delivery || 'instant'
          };

          set({ items: [...items, newItem] });
        }
      },

      // Remove item from cart
      removeItem: (itemId) => {
        set({
          items: get().items.filter(item => item.id !== itemId)
        });
      },

      // Update item quantity
      updateQuantity: (itemId, quantity) => {
        if (quantity <= 0) {
          // Remove item if quantity is 0 or negative
          get().removeItem(itemId);
        } else {
          set({
            items: get().items.map(item =>
              item.id === itemId ? { ...item, quantity } : item
            )
          });
        }
      },

      // Clear entire cart
      clearCart: () => {
        set({ items: [] });
      },

      // Calculate cart totals
      calculateTotals: () => {
        const { items } = get();
        return calculateCartTotals(items);
      },

      // Get total item count (sum of quantities)
      getItemCount: () => {
        return get().items.reduce((sum, item) => sum + item.quantity, 0);
      },

      // Check if cart is empty
      isNotEmpty: () => {
        return get().items.length > 0 && get().items.some(item => item.quantity > 0);
      },

      // Get cart summary for display
      getCartSummary: () => {
        const { items } = get();
        return items.filter(item => item.quantity > 0);
      },

      // Sync with backend cookie storage
      syncWithBackend: async () => {
        try {
          set({ isLoading: true });

          // In production, this would fetch from API and save to cookies
          // For now, just sync localStorage with backend expectations

          const payload = {
            count: get().getItemCount(),
            items: get().getCartSummary()
          };

          // Set cookie header for browser
          document.cookie = `slimemarket-cart=${encodeURIComponent(JSON.stringify(payload))}; path=/; max-age=604800`;

          set({ isLoading: false });
        } catch (error) {
          console.error('Failed to sync cart with backend:', error);
          set({ isLoading: false });
        }
      }
    }),
    {
      // Persist to localStorage
      name: 'slimemarket-cart-storage',
      storage: createJSONStorage(() => localStorage),

      // Partialize specific fields
      partialize: (state) => ({
        items: state.items,
        isLoading: state.isLoading
      }),

      // Hydration configuration (zustand hydrates on load; skipHydration=false = auto)
      skipHydration: false
    }
  )
);

// Export helper hooks for convenience
export const useCartItemCount = () => useCartStore(state => state.getItemCount());
export const useCartTotal = () => useCartStore(state => state.calculateTotals());
export const useCartIsEmpty = () => useCartStore(state => !state.isNotEmpty());
export const useCartItems = () => useCartStore(state => state.getCartSummary());
