# 🛠️ Admin PIN Recovery System

## Overview
Secure mechanism for recovering admin access when PIN is lost or compromised. Uses time-limited recovery keys with cryptographic hashing.

---

## Architecture

### Components
1. **Supabase Migration** (`supabase/migrations/20260807000001_admin_pin_recovery.sql`)
   - `reset_admin_pin()` - Updates admin PIN hash
   - `generate_recovery_key()` - Creates time-limited recovery credentials
   - `admin_recovery_keys` table - Stores recovery key metadata

2. **Frontend Page** (`app/admin/pin-reset/page.tsx`)
   - 4-step verification process
   - Client-side PIN validation
   - Secure UI with audit logging

3. **Security Features**
   - Argon2id password hashing (same as production)
   - Time-limited recovery keys (default 24 hours)
   - IP address tracking
   - Usage expiration after single use

---

## Setup Instructions

### Step 1: Apply Database Migration

Run migration in Supabase dashboard:

```bash
# Option A: Via SQL Editor
# Navigate to: https://your-project.supabase.co/sql
# Paste and run: supabase/migrations/20260807000001_admin_pin_recovery.sql

# Option B: Via CLI
npx supabase db push --db-url YOUR_DATABASE_URL
```

Expected output:
```
✅ Table admin_recovery_keys created
✅ Function reset_admin_pin() created
✅ Function generate_recovery_key() created
✅ View admin_recovery_audit created
```

### Step 2: Verify Functions

Query functions exist:
```sql
SELECT proname FROM pg_proc WHERE proname IN ('reset_admin_pin', 'generate_recovery_key');
```

Expected result: Two rows showing both functions.

### Step 3: Deploy Frontend

The page at `/admin/pin-reset` is now accessible. In production, restrict access via:
- Authentication middleware
- Admin role verification
- Rate limiting

### Step 4: Test Recovery Flow

#### Test Scenario 1: Full Recovery Cycle
1. Visit `/admin/pin-reset`
2. Pass security challenge (implement MFA in real deployment)
3. Generate recovery key
4. Receive generated PIN via secure channel
5. Reset PIN with new value
6. Verify login works with new PIN

#### Test Scenario 2: Expired Key
1. Manually expire a recovery key:
   ```sql
   UPDATE admin_recovery_keys 
   SET expires_at = NOW() - INTERVAL '1 hour';
   ```
2. Attempt to use it - should fail gracefully

---

## Security Considerations

### Do ✅
- Implement additional verification layers (MFA, email codes)
- Log all recovery attempts in audit table
- Send recovery PIN via out-of-band secure channel
- Set reasonable expiration times (24h default)
- Monitor `admin_recovery_audit` view regularly
- Rotate recovery procedure documentation

### Don't ❌
- Allow recovery without identity verification
- Email PIN through same channel as admin credentials
- Use static recovery keys (always time-limited)
- Skip audit logging
- Share recovery keys between multiple admins

---

## Monitoring & Audit

### Daily Checks
Query recent recovery activity:
```sql
SELECT 
  id,
  created_at,
  status,
  remaining_time
FROM admin_recovery_audit
WHERE created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

### Weekly Report
```sql
-- Recovery statistics for last 7 days
SELECT 
  DATE(created_at) as day,
  COUNT(*) as total_generations,
  SUM(CASE WHEN used THEN 1 ELSE 0 END) as successful_resets,
  SUM(CASE WHEN expires_at < NOW() AND NOT used THEN 1 ELSE 0 END) as expired
FROM admin_recovery_keys
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at);
```

### Alerts Configuration
Set up alerts for:
- Multiple failed attempts (>3 in 1 hour)
- Recovery key generation outside business hours
- Any recovery from unusual IP addresses

---

## Troubleshooting

### Issue: Function `generate_recovery_key()` not found
**Solution**: Migration didn't apply correctly. Check:
```sql
SELECT exists(
  SELECT 1 FROM information_schema.tables 
  WHERE table_name = 'admin_recovery_keys'
);
```

### Issue: Recovery key never gets used
**Solution**: User may have abandoned process. Monitor and clean up:
```sql
-- Clean expired unused keys monthly (schedule via cron)
DELETE FROM admin_recovery_keys 
WHERE expires_at < NOW() - INTERVAL '30 days';
```

### Issue: PIN reset fails silently
**Solution**: Check error logs and verify:
1. Recovery key is still valid (not expired)
2. Recovery key hasn't been used already
3. New PIN meets complexity requirements

---

## Integration Examples

### Email Provider Setup (Brevo)
```typescript
// services/email-service.ts
async function sendRecoveryPin(recoveryId: string, pin: string) {
  await fetch('https://api.brevo.com/v3/smtp/transactemail', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY!,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { email: 'noreply@slimemarket.app', name: 'SlimeMarket Security' },
      to: [{ email: 'admin@slimemarket.app', name: 'Admin' }],
      subject: `🔐 Your Admin PIN Recovery Code`,
      htmlContent: `<p>Your recovery ID is: ${recoveryId}</p><p>PIN: <strong>${pin}</strong></p>`
    })
  });
}
```

### Frontend Enhancement (Add MFA)
```typescript
// In app/admin/pin-reset/page.tsx
const [mfaCode, setMfaCode] = useState("");

const handleMfaVerify = async () => {
  const { data, error } = await supabase
    .from("user_auth")
    .select("mfa_secret")
    .eq("email", "admin@slimemarket.app")
    .single();
  
  if (!totp.verify({ secret: data.mfa_secret, token: mfaCode })) {
    setError("Invalid MFA code");
    return;
  }
  
  // Proceed to next step
};
```

---

## Compliance Notes

- **GDPR**: All recovery attempts logged for accountability
- **SOC 2**: Multi-factor required before implementation
- **Audit Trail**: Immutable records of all recovery operations

---

Last Updated: 2026-08-07  
Version: 1.0.0  
Maintained By: SlimeMarket Security Team
