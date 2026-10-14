# SlimeMarket Test Accounts & Login Helpers

## Quick Dev Login (bypass Circle OTP)

```bash
# Login as buyer (sets httpOnly cookies)
curl -c cookies-buyer.txt -X POST http://localhost:3000/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"testbuyer@slimemarket.app","role":"Buyer"}'

# Login as seller
curl -c cookies-seller.txt -X POST http://localhost:3000/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"testseller@slimemarket.app","role":"Seller"}'

# Login as admin
curl -c cookies-admin.txt -X POST http://localhost:3000/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"rimuru@slimemarket.app","role":"Admin"}'

# Use cookies for authenticated requests
curl -b cookies-buyer.txt http://localhost:3000/api/orders
curl -b cookies-seller.txt http://localhost:3000/api/my/orders
curl -b cookies-admin.txt http://localhost:3000/api/admin/audit
```

## Test Accounts (existing in DB)

> Passwords rotated after repo cleanup — set new test credentials via Supabase/`dev-login` as needed.

| Email | Role | Password (if Circle OTP needed) |
|-------|------|------|
| rimuru@slimemarket.app | Admin | <ROTATED> |
| testmm@slimemarket.app | Middleman | <ROTATED> |
| testseller@slimemarket.app | Seller | <ROTATED> |
| testbuyer@slimemarket.app | Buyer | <ROTATED> |
| *(real Circle test accounts — deliberately NOT listed here; see your Circle Console)* | Seller | (Circle UCW) |

## TestSprite Segments (5 free accounts, 150 credits each)

### Segment 1: Buyer Checkout Flow (buyer account)
- Login via dev-login as testbuyer
- Browse products (/api/products)
- Checkout instant product (prepare → challenge → confirm)
- Verify order created + credentials sent
- Cancel order + verify refund

### Segment 2: Seller Center Flow (seller account)
- Login via dev-login as testseller
- View seller orders (/api/my/orders)
- Process order (advance → send)
- View earnings + wallet
- Create product with variants

### Segment 3: Admin Panel (admin account)
- Login via dev-login as rimuru
- View disputes panel
- Resolve dispute (refund/release)
- View audit log
- View treasury + collect fees

### Segment 4: Escrow/WL Deal Flow (buyer + seller)
- Buyer creates WL deal (prepare → challenge → confirm)
- Seller proceeds with collateral
- Admin releases/refunds escrow
- Verify deal room accessible by both parties

### Segment 5: Wallet & Profile (any account)
- View wallet balance + transaction history
- Verify tx hash links to Arc explorer
- Top-up via dev faucet
- View profile + contacts

## Browser Login (manual, for real UCW testing)
1. Visit http://localhost:3000/auth
2. Enter email → receive OTP via email
3. Enter OTP → W3S SDK initializes UCW
4. Cookies set automatically

## Dev Login via Browser Console
```javascript
// Open browser console, paste:
fetch('/api/auth/dev-login', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({email: 'testbuyer@slimemarket.app', role: 'Buyer'})
}).then(r => r.json()).then(d => { console.log('Logged in:', d); location.reload(); });
```
