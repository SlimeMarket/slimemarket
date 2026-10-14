/**
 * Shopping Cart Page Component
 *
 * Displays all cart items with ability to:
 * - View item details
 * - Update quantities
 * - See fee breakdown
 * - Proceed to checkout
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useCartStore, useCartTotal } from '@/lib/store/cart-store';
import { OptimizedImage } from './OptimizedImage';

export function CartPage() {
  const [updatingItem, setUpdatingItem] = useState<string | null>(null);

  const items = useCartStore(state => state.getCartSummary());
  const removeItem = useCartStore(state => state.removeItem);
  const updateQuantity = useCartStore(state => state.updateQuantity);
  const clearCart = useCartStore(state => state.clearCart);
  const totals = useCartTotal();
  const isCartEmpty = items.length === 0;

  // Calculate percentage of each fee for display
  const subtotalPercent = totals.total > 0 ? (totals.subtotal / totals.total) * 100 : 0;
  // .C — single 2% buyer-pays platform fee (v4 model); seller receives 100%.
  const platformFeePercent = totals.total > 0 ? (totals.platformFee / totals.total) * 100 : 0;

  if (isCartEmpty) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
            Your Cart Is Empty
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 mb-8">
            Looks like you haven&apos;t added any products yet.
          </p>
          <Link
            href="/storefront"
            className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
          >
            Start Shopping →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Shopping Cart
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          You have {items.reduce((sum, item) => sum + item.quantity, 0)} items in your cart
        </p>
      </div>

      {/* Cart Items List */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Items Column */}
        <div className="lg:col-span-2 space-y-4">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center space-x-4 p-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm hover:shadow-md transition-shadow"
            >
              {/* Product Image */}
              <div className="w-20 h-20 flex-shrink-0 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
                {item.imageUrl ? (
                  <OptimizedImage
                    src={item.imageUrl}
                    alt={item.productName}
                    width={80}
                    height={80}
                    className="object-cover w-full h-full"
                  />
                ) : (
                  <div className="w-full h-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                    <span className="text-xs text-gray-500">No image</span>
                  </div>
                )}
              </div>

              {/* Product Details */}
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {item.productName}
                </h3>
                {item.variantIndex !== undefined && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Variant #{item.variantIndex + 1}
                  </p>
                )}
                <p className="text-sm font-medium text-blue-600 dark:text-blue-400 mt-2">
                  ${(item.price / 1000000).toFixed(2)} USDC
                </p>
              </div>

              {/* Quantity Controls */}
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => updateQuantity(item.id, item.quantity - 1)}
                  disabled={updatingItem === item.id || item.quantity <= 1}
                  className="w-8 h-8 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label={`Decrease quantity for ${item.productName}`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    className="w-4 h-4"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M18 12H6"
                    />
                  </svg>
                </button>

                <span className="w-8 text-center text-sm font-medium text-gray-900 dark:text-white">
                  {item.quantity}
                </span>

                <button
                  onClick={() => updateQuantity(item.id, item.quantity + 1)}
                  disabled={updatingItem === item.id}
                  className="w-8 h-8 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label={`Increase quantity for ${item.productName}`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                    className="w-4 h-4"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 6v12m6-6H6"
                    />
                  </svg>
                </button>
              </div>

              {/* Remove Button */}
              <button
                onClick={() => removeItem(item.id)}
                className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                aria-label={`Remove ${item.productName} from cart`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>

              {/* Item Total */}
              <div className="text-right hidden sm:block">
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  ${(item.price * item.quantity / 1000000).toFixed(2)} USDC
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {item.deliveryType === 'instant' ? 'Instant Delivery' : 'Manual Delivery'}
                </p>
              </div>
            </div>
          ))}

          {/* Continue Shopping Button */}
          <div className="mt-6 flex items-center">
            <Link
              href="/storefront"
              className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
            >
              ← Continue Shopping
            </Link>
          </div>
        </div>

        {/* Summary Column */}
        <div className="lg:col-span-1">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 sticky top-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Order Summary
            </h2>

            {/* Fee Breakdown */}
            <div className="space-y-3 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Subtotal</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  ${(totals.subtotal / 1000000).toFixed(2)} USDC
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Platform Fee (2%)</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  ${(totals.platformFee / 1000000).toFixed(2)} USDC
                </span>
              </div>

              {/* Divider */}
              <div className="border-t border-gray-200 dark:border-gray-700 my-4"></div>

              {/* Total */}
              <div className="flex justify-between text-lg font-semibold">
                <span className="text-gray-900 dark:text-white">Total</span>
                <span className="text-blue-600 dark:text-blue-400 font-bold">
                  ${(totals.total / 1000000).toFixed(2)} USDC
                </span>
              </div>

              {/* Percentage Indicators */}
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-blue-500"
                    style={{ width: `${subtotalPercent}%` }}
                    title="Subtotal"
                  />
                  <div
                    className="bg-yellow-500"
                    style={{ width: `${platformFeePercent}%` }}
                    title="Platform Fee (2%)"
                  />
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Fee breakdown shown above
                </p>
              </div>
            </div>

            {/* this used to point at `/checkout`, which has no view:
                the SPA router falls through to `notfound`, and middleware
                bounces an empty cart cookie back to `/`. Nothing links to /cart
                either, so the button dead-ended for anyone who found the page.
                Buying happens on the storefront (instant-buy checkout), so send
                people there. */}
            <button
              onClick={() => { window.location.href = '/'; }}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors shadow-sm"
            >
              Continue shopping
            </button>

            {/* Clear Cart Option */}
            <button
              onClick={() => {
                if (window.confirm('Are you sure you want to clear your cart?')) {
                  clearCart();
                }
              }}
              className="w-full mt-3 py-2 px-4 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 transition-colors text-sm"
            >
              Clear Cart
            </button>

            {/* Security Notice */}
            <div className="mt-6 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <div className="flex items-start">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z"
                  />
                </svg>
                <div className="ml-3">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    Secure payment powered by Circle & Arc blockchain
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CartPage;
