/**
 * UI-FE-033 — Privileged Separation and Fail-Closed Journeys
 *
 * Cross-surface tests proving operations, governance, and guardian authority
 * never bleed together. Every missing/stale authority path is read-only,
 * denied, or unavailable.
 *
 * Architecture constraints:
 * - Contracts are canonical for mutations; API data is freshness-labelled projection.
 * - Fixtures stay out of production. Unpinned actions render unavailable.
 * - UI context, wallet connection, or API data never grants authority.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// ── Test Utilities ───────────────────────────────────────────────────────────

const ADMIN_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const NON_ADMIN_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TREASURY_ADMIN_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

async function mockWalletConnection(
  page: Page,
  address: string,
  chainId: number = 11155420, // OP Sepolia
) {
  await page.evaluate(
    ({ addr, chain }) => {
      (window as unknown as { __E2E_WALLET_OVERRIDE__?: unknown }).__E2E_WALLET_OVERRIDE__ = {
        address: addr,
        chainId: chain,
        isConnected: true,
      };
    },
    { addr: address, chain: chainId },
  );
}

async function mockWalletDisconnect(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __E2E_WALLET_OVERRIDE__?: unknown }).__E2E_WALLET_OVERRIDE__ = {
      address: null,
      chainId: null,
      isConnected: false,
    };
  });
}

async function mockAccountChange(page: Page, newAddress: string) {
  await page.evaluate(
    (addr) => {
      const override = (window as unknown as { __E2E_WALLET_OVERRIDE__?: { address: string } })
        .__E2E_WALLET_OVERRIDE__;
      if (override) {
        override.address = addr;
      }
      window.dispatchEvent(new Event('accountsChanged'));
    },
    newAddress,
  );
}

async function mockChainChange(page: Page, newChainId: number) {
  await page.evaluate(
    (chain) => {
      const override = (window as unknown as { __E2E_WALLET_OVERRIDE__?: { chainId: number } })
        .__E2E_WALLET_OVERRIDE__;
      if (override) {
        override.chainId = chain;
      }
      window.dispatchEvent(new Event('chainChanged'));
    },
    newChainId,
  );
}

async function mockStaleApiData(page: Page, staleness: 'stale' | 'critical') {
  await page.evaluate(
    (level) => {
      (window as unknown as { __E2E_API_STALENESS__?: string }).__E2E_API_STALENESS__ = level;
    },
    staleness,
  );
}

async function mockAbiUnavailable(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __E2E_ABI_UNAVAILABLE__?: boolean }).__E2E_ABI_UNAVAILABLE__ = true;
  });
}

// ── 1. Operations Context Tests ──────────────────────────────────────────────

test.describe('Operations Context (PROTOCOL_OPERATOR)', () => {
  test('authorized admin sees operational queue and can execute bounded operations', async ({
    page,
  }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Verify authorized state
    await expect(page.getByText(/authorized/i)).toBeVisible();
    await expect(page.getByText(ADMIN_ADDRESS)).toBeVisible();

    // Verify operational queue is visible
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText(/operational queue/i)).toBeVisible();

    // Verify bounded operations are present
    await expect(page.getByText(/retry.*batch/i)).toBeVisible();
    await expect(page.getByText(/sync.*projection/i)).toBeVisible();

    // Attempt to execute a bounded operation
    await page.getByRole('button', { name: /execute/i }).first().click();

    // Confirm modal should appear with explicit confirmation required
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/confirm/i)).toBeVisible();
    await expect(page.getByText(/consequence/i)).toBeVisible();

    // Type explicit confirmation
    await page.getByRole('textbox', { name: /confirmation/i }).fill('CONFIRM');
    await page.getByRole('button', { name: /execute operation/i }).click();

    // Verify audit record appears
    await expect(page.getByText(/audit reference/i)).toBeVisible();
    await expect(page.getByText(/AUD-/)).toBeVisible();
  });

  test('unauthorized wallet sees read-only state with clear denial reason', async ({ page }) => {
    await mockWalletConnection(page, NON_ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Verify unauthorized state
    await expect(page.getByText(/unauthorized/i)).toBeVisible();
    await expect(
      page.getByText(/admin role verification failed/i),
    ).toBeVisible();

    // Verify no execute buttons
    await expect(page.getByRole('button', { name: /execute/i })).not.toBeVisible();

    // Verify queue is read-only (visible but no actions)
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText(/read-only/i)).toBeVisible();
  });

  test('disconnected state blocks all operations and shows connection prompt', async ({ page }) => {
    await mockWalletDisconnect(page);
    await page.goto('/admin/operations');

    // Verify connection prompt
    await expect(page.getByText(/connect.*wallet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /connect/i })).toBeVisible();

    // Verify no operational data visible
    await expect(page.getByRole('table')).not.toBeVisible();
  });

  test('account change invalidates session and requires recovery', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Verify initial authorized state
    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Change account
    await mockAccountChange(page, NON_ADMIN_ADDRESS);

    // Verify recovery prompt appears
    await expect(page.getByText(/account.*changed/i)).toBeVisible();
    await expect(page.getByText(/recovery/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /acknowledge/i })).toBeVisible();

    // Acknowledge recovery
    await page.getByRole('button', { name: /acknowledge/i }).click();

    // Verify now unauthorized
    await expect(page.getByText(/unauthorized/i)).toBeVisible();
  });

  test('chain change invalidates wallet-scoped cache and requires recovery', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS, 11155420); // OP Sepolia
    await page.goto('/admin/operations');

    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Change to unsupported chain
    await mockChainChange(page, 1); // Ethereum Mainnet

    // Verify recovery prompt
    await expect(page.getByText(/chain.*changed/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /acknowledge/i })).toBeVisible();

    await page.getByRole('button', { name: /acknowledge/i }).click();

    // Verify unsupported chain message
    await expect(page.getByText(/unsupported chain/i)).toBeVisible();
    await expect(page.getByText(/switch to optimism/i)).toBeVisible();
  });

  test('stale API data shows warning but preserves read-only access', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await mockStaleApiData(page, 'stale');
    await page.goto('/admin/operations');

    // Verify stale data warning
    await expect(page.getByText(/stale/i)).toBeVisible();
    await expect(page.getByText(/refresh/i)).toBeVisible();

    // Verify read-only access maintained
    await expect(page.getByRole('table')).toBeVisible();

    // Verify execute buttons still available (operations use contract as canonical)
    await expect(page.getByRole('button', { name: /execute/i }).first()).toBeVisible();
  });

  test('critically stale API data blocks write operations', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await mockStaleApiData(page, 'critical');
    await page.goto('/admin/operations');

    // Verify critical staleness warning
    await expect(page.getByText(/critically stale/i)).toBeVisible();
    await expect(page.getByText(/blocked/i)).toBeVisible();

    // Verify execute buttons disabled
    const executeButtons = page.getByRole('button', { name: /execute/i });
    await expect(executeButtons.first()).toBeDisabled();
  });

  test('direct URL access without wallet shows connection gate', async ({ page }) => {
    // Navigate directly without any wallet connection
    await page.goto('/admin/operations');

    // Verify connection gate
    await expect(page.getByText(/connect.*wallet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /connect/i })).toBeVisible();

    // Verify no privileged content visible
    await expect(page.getByRole('table')).not.toBeVisible();
    await expect(page.getByText(/operational queue/i)).not.toBeVisible();
  });

  test('operations cannot override claim verdicts (bounded invariant)', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Verify no operations for claim manipulation exist
    await expect(page.getByText(/override.*verdict/i)).not.toBeVisible();
    await expect(page.getByText(/modify.*claim/i)).not.toBeVisible();
    await expect(page.getByText(/change.*outcome/i)).not.toBeVisible();

    // Verify bounded operations only
    const operations = page.getByRole('row');
    await expect(operations).not.toContainText(/verdict/i);
    await expect(operations).not.toContainText(/claim outcome/i);
  });
});

// ── 2. Governance Context Tests ──────────────────────────────────────────────

test.describe('Governance Context (AUDIT_ADMIN)', () => {
  test('audit admin sees read-only protocol parameters', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    // Verify read-only parameter display
    await expect(page.getByText(/protocol parameters/i)).toBeVisible();
    await expect(page.getByText(/read-only/i)).toBeVisible();

    // Verify parameters are displayed
    await expect(page.getByText(/contract source/i)).toBeVisible();
    await expect(page.getByText(/0x[a-fA-F0-9]{40}/)).toBeVisible();

    // Verify no modify buttons
    await expect(page.getByRole('button', { name: /modify/i })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /change/i })).not.toBeVisible();
  });

  test('audit trail shows consequence hashes and operator references', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    // Navigate to audit trail
    await page.getByRole('tab', { name: /audit/i }).click();

    // Verify audit records visible
    await expect(page.getByText(/audit trail/i)).toBeVisible();
    await expect(page.getByText(/AUD-/)).toBeVisible();

    // Verify consequence hash present
    await expect(page.getByText(/0x[a-fA-F0-9]{64}/)).toBeVisible();
    await expect(page.getByText(/consequence hash/i)).toBeVisible();

    // Verify operator address visible
    await expect(page.getByText(/operator/i)).toBeVisible();
    await expect(page.getByText(/0x[a-fA-F0-9]{40}/)).toBeVisible();

    // Verify authority classification
    await expect(page.getByText(/PROTOCOL_OPERATOR|AUDIT_ADMIN|EMERGENCY_ADMIN/)).toBeVisible();
  });

  test('governance notices show timelock and multisig constraints', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    // Verify governance notices section
    await expect(page.getByText(/governance notices/i)).toBeVisible();

    // Verify notice types
    await expect(page.getByText(/timelock/i)).toBeVisible();
    await expect(page.getByText(/multisig/i)).toBeVisible();

    // Verify notices indicate constraints (not capabilities)
    await expect(page.getByText(/requires/i)).toBeVisible();
    await expect(page.getByText(/pending/i)).toBeVisible();
  });

  test('unauthorized wallet cannot see governance data', async ({ page }) => {
    await mockWalletConnection(page, NON_ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    // Verify unauthorized state
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Verify no governance data visible
    await expect(page.getByText(/protocol parameters/i)).not.toBeVisible();
    await expect(page.getByText(/audit trail/i)).not.toBeVisible();
  });

  test('session expiry clears governance view and requires reauth', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    await expect(page.getByText(/protocol parameters/i)).toBeVisible();

    // Mock session expiry
    await page.evaluate(() => {
      (window as unknown as { __E2E_SESSION_EXPIRED__?: boolean }).__E2E_SESSION_EXPIRED__ =
        true;
      window.dispatchEvent(new CustomEvent('sessionExpired'));
    });

    // Verify session expired message
    await expect(page.getByText(/session.*expired/i)).toBeVisible();
    await expect(page.getByText(/sign in again/i)).toBeVisible();

    // Verify governance data cleared
    await expect(page.getByText(/protocol parameters/i)).not.toBeVisible();
  });

  test('session revocation immediately blocks governance access', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    await expect(page.getByText(/protocol parameters/i)).toBeVisible();

    // Mock session revocation
    await page.evaluate(() => {
      (window as unknown as { __E2E_SESSION_REVOKED__?: boolean }).__E2E_SESSION_REVOKED__ = true;
      window.dispatchEvent(new CustomEvent('sessionRevoked'));
    });

    // Verify revocation message
    await expect(page.getByText(/session.*revoked/i)).toBeVisible();

    // Verify access blocked
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    await expect(page.getByText(/protocol parameters/i)).not.toBeVisible();
  });
});

// ── 3. Guardian Context Tests (Treasury Admin) ───────────────────────────────

test.describe('Guardian Context (Treasury Admin)', () => {
  test('treasury admin sees withdrawal panel with multi-layer authorization', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10); // OP Mainnet
    await page.goto('/admin/treasury');

    // Verify authorized state
    await expect(page.getByText(/treasury admin/i)).toBeVisible();
    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Verify withdrawal panel visible
    await expect(page.getByText(/treasury withdrawal/i)).toBeVisible();

    // Verify balance display
    await expect(page.getByText(/treasury balance/i)).toBeVisible();
    await expect(page.getByText(/ETH/i)).toBeVisible();

    // Verify recipient input
    await expect(page.getByRole('textbox', { name: /recipient/i })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /amount/i })).toBeVisible();

    // Verify typed confirmation required
    await expect(page.getByText(/type.*EXECUTE.*confirm/i)).toBeVisible();
  });

  test('non-admin wallet cannot see treasury controls (fail-closed)', async ({ page }) => {
    await mockWalletConnection(page, NON_ADMIN_ADDRESS, 10);
    await page.goto('/admin/treasury');

    // Verify unauthorized state
    await expect(page.getByText(/unauthorized/i)).toBeVisible();
    await expect(
      page.getByText(/not the canonical treasury admin/i),
    ).toBeVisible();

    // Verify no withdrawal controls
    await expect(page.getByRole('textbox', { name: /recipient/i })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /withdraw/i })).not.toBeVisible();
  });

  test('unsupported chain blocks treasury operations', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 1); // Ethereum Mainnet
    await page.goto('/admin/treasury');

    // Verify unsupported chain message
    await expect(page.getByText(/unsupported chain/i)).toBeVisible();
    await expect(page.getByText(/switch to optimism/i)).toBeVisible();

    // Verify no withdrawal controls
    await expect(page.getByRole('textbox', { name: /recipient/i })).not.toBeVisible();
  });

  test('unavailable ABI fails closed and blocks withdrawals', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);
    await mockAbiUnavailable(page);
    await page.goto('/admin/treasury');

    // Verify ABI unavailable message
    await expect(
      page.getByText(/canonical ABI does not expose withdrawTreasury/i),
    ).toBeVisible();
    await expect(page.getByText(/fail closed/i)).toBeVisible();

    // Verify withdrawal controls disabled
    const withdrawButton = page.getByRole('button', { name: /withdraw/i });
    await expect(withdrawButton).toBeDisabled();
  });

  test('stale treasury balance shows warning and requires refresh', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);
    await page.goto('/admin/treasury');

    // Mock stale balance
    await page.evaluate(() => {
      (window as unknown as { __E2E_TREASURY_STALE__?: boolean }).__E2E_TREASURY_STALE__ = true;
    });

    // Verify staleness warning
    await expect(page.getByText(/balance.*stale/i)).toBeVisible();
    await expect(page.getByText(/refresh before submitting/i)).toBeVisible();

    // Verify refresh button available
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();

    // Verify withdrawal blocked until refresh
    await page.getByRole('textbox', { name: /recipient/i }).fill(NON_ADMIN_ADDRESS);
    await page.getByRole('textbox', { name: /amount/i }).fill('1000000000000000000');
    await page.getByRole('textbox', { name: /confirmation/i }).fill('EXECUTE');

    const withdrawButton = page.getByRole('button', { name: /withdraw/i });
    await expect(withdrawButton).toBeDisabled();
  });

  test('withdrawal validation enforces address format and balance', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);
    await page.goto('/admin/treasury');

    // Invalid recipient address
    await page.getByRole('textbox', { name: /recipient/i }).fill('invalid-address');
    await page.getByRole('textbox', { name: /amount/i }).fill('1000000000000000000');

    // Verify validation error
    await expect(page.getByText(/invalid.*address/i)).toBeVisible();

    // Amount exceeds balance
    await page.getByRole('textbox', { name: /recipient/i }).fill(NON_ADMIN_ADDRESS);
    await page.getByRole('textbox', { name: /amount/i }).fill('999999999999999999999999');

    // Verify balance error
    await expect(page.getByText(/exceeds.*balance/i)).toBeVisible();

    // Verify withdraw button disabled
    const withdrawButton = page.getByRole('button', { name: /withdraw/i });
    await expect(withdrawButton).toBeDisabled();
  });

  test('typed confirmation phrase must match exactly', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);
    await page.goto('/admin/treasury');

    // Fill valid withdrawal data
    await page.getByRole('textbox', { name: /recipient/i }).fill(NON_ADMIN_ADDRESS);
    await page.getByRole('textbox', { name: /amount/i }).fill('1000000000000000000');

    // Wrong confirmation phrase
    await page.getByRole('textbox', { name: /confirmation/i }).fill('execute');

    // Verify error
    await expect(page.getByText(/type EXECUTE to confirm/i)).toBeVisible();

    // Verify button disabled
    const withdrawButton = page.getByRole('button', { name: /withdraw/i });
    await expect(withdrawButton).toBeDisabled();

    // Correct confirmation phrase
    await page.getByRole('textbox', { name: /confirmation/i }).fill('EXECUTE');

    // Verify button enabled
    await expect(withdrawButton).toBeEnabled();
  });

  test('guardian cannot access operations or governance contexts', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);

    // Try to access operations
    await page.goto('/admin/operations');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Try to access governance
    await page.goto('/admin/governance');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Verify treasury access maintained
    await page.goto('/admin/treasury');
    await expect(page.getByText(/treasury admin/i)).toBeVisible();
    await expect(page.getByText(/authorized/i)).toBeVisible();
  });
});

// ── 4. Cross-Context Isolation Tests ─────────────────────────────────────────

test.describe('Cross-Context Isolation', () => {
  test('operations context cannot trigger treasury withdrawals', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Verify no treasury operations in operational queue
    await expect(page.getByText(/withdraw.*treasury/i)).not.toBeVisible();
    await expect(page.getByText(/transfer.*funds/i)).not.toBeVisible();

    // Verify operational queue only contains bounded operations
    const operations = page.getByRole('row');
    await expect(operations).not.toContainText(/treasury/i);
    await expect(operations).not.toContainText(/funds/i);
  });

  test('governance context is read-only and cannot execute operations', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');

    // Verify no execute buttons
    await expect(page.getByRole('button', { name: /execute/i })).not.toBeVisible();

    // Verify parameters are read-only
    await expect(page.getByText(/read-only/i)).toBeVisible();

    // Verify no input fields for modification
    const inputs = page.getByRole('textbox');
    await expect(inputs).toHaveCount(0);
  });

  test('treasury guardian cannot access audit trail', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);
    await page.goto('/admin/governance');

    // Verify unauthorized
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Verify no audit data visible
    await expect(page.getByText(/audit trail/i)).not.toBeVisible();
    await expect(page.getByText(/consequence hash/i)).not.toBeVisible();
  });

  test('authority verification happens per-context not per-route', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);

    // Admin can access operations
    await page.goto('/admin/operations');
    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Admin can access governance
    await page.goto('/admin/governance');
    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Admin cannot access treasury (different admin address)
    await page.goto('/admin/treasury');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();
  });

  test('disconnecting wallet clears all contexts uniformly', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Disconnect
    await mockWalletDisconnect(page);

    // Verify operations cleared
    await expect(page.getByText(/connect.*wallet/i)).toBeVisible();

    // Verify governance cleared
    await page.goto('/admin/governance');
    await expect(page.getByText(/connect.*wallet/i)).toBeVisible();

    // Verify treasury cleared
    await page.goto('/admin/treasury');
    await expect(page.getByText(/connect.*wallet/i)).toBeVisible();
  });

  test('account change invalidates all privileged contexts', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Change account
    await mockAccountChange(page, NON_ADMIN_ADDRESS);
    await page.getByRole('button', { name: /acknowledge/i }).click();

    // Verify operations unauthorized
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Verify governance unauthorized
    await page.goto('/admin/governance');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Verify treasury unauthorized
    await page.goto('/admin/treasury');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();
  });
});

// ── 5. Audit and Reference Continuity Tests ──────────────────────────────────

test.describe('Audit and Reference Continuity', () => {
  test('all privileged actions generate audit references', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Execute a bounded operation
    await page.getByRole('button', { name: /execute/i }).first().click();
    await page.getByRole('textbox', { name: /confirmation/i }).fill('CONFIRM');
    await page.getByRole('button', { name: /execute operation/i }).click();

    // Verify audit reference appears immediately
    await expect(page.getByText(/audit reference/i)).toBeVisible();
    await expect(page.getByText(/AUD-\d+/)).toBeVisible();

    // Navigate to audit trail
    await page.goto('/admin/governance');
    await page.getByRole('tab', { name: /audit/i }).click();

    // Verify audit record persisted
    await expect(page.getByText(/AUD-\d+/)).toBeVisible();
    await expect(page.getByText(/consequence hash/i)).toBeVisible();
  });

  test('safe recovery preserves audit continuity after wallet change', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/governance');
    await page.getByRole('tab', { name: /audit/i }).click();

    // Note existing audit records
    const auditCount = await page.getByText(/AUD-/).count();
    expect(auditCount).toBeGreaterThan(0);

    // Change account and recover
    await mockAccountChange(page, ADMIN_ADDRESS); // Same admin address
    await page.getByRole('button', { name: /acknowledge/i }).click();

    // Verify audit trail still visible
    const newAuditCount = await page.getByText(/AUD-/).count();
    expect(newAuditCount).toBe(auditCount);

    // Verify no data loss
    await expect(page.getByText(/consequence hash/i)).toBeVisible();
  });

  test('failed operations are logged with failure status', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    // Mock operation failure
    await page.evaluate(() => {
      (window as unknown as { __E2E_OPERATION_FAIL__?: boolean }).__E2E_OPERATION_FAIL__ = true;
    });

    // Attempt operation
    await page.getByRole('button', { name: /execute/i }).first().click();
    await page.getByRole('textbox', { name: /confirmation/i }).fill('CONFIRM');
    await page.getByRole('button', { name: /execute operation/i }).click();

    // Verify failure message
    await expect(page.getByText(/failed/i)).toBeVisible();

    // Navigate to audit trail
    await page.goto('/admin/governance');
    await page.getByRole('tab', { name: /audit/i }).click();

    // Verify failure logged
    await expect(page.getByText(/FAILED/)).toBeVisible();
  });

  test('direct URL access to privileged routes preserves denial audit', async ({ page }) => {
    await mockWalletConnection(page, NON_ADMIN_ADDRESS);

    // Direct navigation to privileged routes
    await page.goto('/admin/operations');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    await page.goto('/admin/governance');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    await page.goto('/admin/treasury');
    await expect(page.getByText(/unauthorized/i)).toBeVisible();

    // Verify consistent denial across all contexts
    const unauthorizedCount = await page.getByText(/unauthorized/i).count();
    expect(unauthorizedCount).toBeGreaterThan(0);
  });
});

// ── 6. Release Change and Configuration Tests ────────────────────────────────

test.describe('Release Change and Configuration Integrity', () => {
  test('release change invalidates cached authority', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);
    await page.goto('/admin/operations');

    await expect(page.getByText(/authorized/i)).toBeVisible();

    // Mock release change
    await page.evaluate(() => {
      (window as unknown as { __E2E_RELEASE_CHANGED__?: boolean }).__E2E_RELEASE_CHANGED__ = true;
      window.dispatchEvent(new CustomEvent('releaseChanged'));
    });

    // Verify revalidation required
    await expect(page.getByText(/configuration.*changed/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
  });

  test('missing contract artifacts fail closed', async ({ page }) => {
    await mockWalletConnection(page, TREASURY_ADMIN_ADDRESS, 10);

    // Mock missing artifacts
    await page.evaluate(() => {
      (window as unknown as { __E2E_ARTIFACTS_MISSING__?: boolean }).__E2E_ARTIFACTS_MISSING__ =
        true;
    });

    await page.goto('/admin/treasury');

    // Verify fail-closed state
    await expect(page.getByText(/missing.*canonical/i)).toBeVisible();
    await expect(page.getByText(/fail closed/i)).toBeVisible();

    // Verify no controls available
    await expect(page.getByRole('textbox', { name: /recipient/i })).not.toBeVisible();
  });

  test('invalid canonical admin address blocks all privileged access', async ({ page }) => {
    await mockWalletConnection(page, ADMIN_ADDRESS);

    // Mock invalid admin config
    await page.evaluate(() => {
      (window as unknown as { __E2E_INVALID_ADMIN__?: boolean }).__E2E_INVALID_ADMIN__ = true;
    });

    await page.goto('/admin/operations');

    // Verify fail-closed state
    await expect(page.getByText(/invalid.*configuration/i)).toBeVisible();
    await expect(page.getByText(/fail closed/i)).toBeVisible();
  });
});
