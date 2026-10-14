/**
 * Shopping Cart Page Route
 * 
 * Displays cart items, allows quantity updates, shows fee breakdown,
 * and provides checkout button to proceed with purchase.
 */

import { CartPage } from '@/components/CartPage';

export const metadata = {
  title: 'Shopping Cart | SlimeMarket',
  description: 'Review your shopping cart before checkout',
};

export default function CartRoutePage() {
  return <CartPage />;
}
