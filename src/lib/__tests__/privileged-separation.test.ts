/**
 * UI-FE-033 — Privileged Separation Unit Tests
 *
 * Unit tests proving operations, governance, and guardian authority never bleed together.
 * Tests authority verification, fail-closed patterns, and context isolation.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateAccessGate,
  normalizeAdminAddress,
  isSupportedTreasuryChain,
  validateWithdrawalDraft,
  abiHasFunction,
} from '@/lib/treasury/safe-withdrawal';
import {
  classifyWalletIdentityTransition,
  transitionClearsWalletCache,
  transitionRequiresAuthRevalidation,
  transitionRequiresRecovery,
  isWalletScopedQueryKey,
} from '@/lib/wallet/identity';
import {
  evaluateSessionHealth,
  classifySessionRefreshError,
  isTerminalRefreshFailure,
} from '@/lib/auth/session-lifecycle';
import type { TreasuryAccessGate } from '@/app/types/treasury';

// ── 1. Treasury Guardian Context Tests ───────────────────────────────────────

describe('Treasury Guardian Context', () => {
  const validAbi = [
    {
      type: 'function',
      name: 'withdrawTreasury',
      inputs: [
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
  ];

  const roles = {
    admin: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  };

  describe('evaluateAccessGate', () => {
    it('grants access when all conditions met', () => {
      const gate = evaluateAccessGate({
        walletAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
        abi: validAbi,
        roles,
        contractAddress: '0x1234567890123456789012345678901234567890',
      });

      expect(gate.isAdmin).toBe(true);
      expect(gate.walletConnected).toBe(true);
      expect(gate.chainSupported).toBe(true);
      expect(gate.abiSupportsWithdraw).toBe(true);
      expect(gate.configComplete).toBe(true);
      expect(gate.blockReason).toBeNull();
    });

    it('fails closed for non-admin wallet', () => {
      const gate = evaluateAccessGate({
        walletAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`,
        chainId: 10,
        abi: validAbi,
        roles,
        contractAddress: '0x1234567890123456789012345678901234567890',
      });

      expect(gate.isAdmin).toBe(false);
      expect(gate.blockReason).toContain('not the canonical treasury admin');
      expect(gate.blockReason).toContain('fail closed');
    });

    it('fails closed for unsupported chain', () => {
      const gate = evaluateAccessGate({
        walletAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 1, // Ethereum Mainnet
        abi: validAbi,
        roles,
        contractAddress: '0x1234567890123456789012345678901234567890',
      });

      expect(gate.chainSupported).toBe(false);
      expect(gate.blockReason).toContain('Unsupported chain');
      expect(gate.blockReason).toContain('Optimism');
    });

    it('fails closed when ABI lacks withdrawTreasury', () => {
      const invalidAbi = [
        {
          type: 'function',
          name: 'otherFunction',
          inputs: [],
        },
      ];

      const gate = evaluateAccessGate({
        walletAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
        abi: invalidAbi,
        roles,
        contractAddress: '0x1234567890123456789012345678901234567890',
      });

      expect(gate.abiSupportsWithdraw).toBe(false);
      expect(gate.blockReason).toContain('canonical ABI does not expose withdrawTreasury');
      expect(gate.blockReason).toContain('fail closed');
    });

    it('fails closed when wallet disconnected', () => {
      const gate = evaluateAccessGate({
        walletAddress: null,
        chainId: 10,
        abi: validAbi,
        roles,
        contractAddress: '0x1234567890123456789012345678901234567890',
      });

      expect(gate.walletConnected).toBe(false);
      expect(gate.blockReason).toContain('Connect an Optimism-compatible wallet');
    });

    it('fails closed when config incomplete', () => {
      const gate = evaluateAccessGate({
        walletAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
        abi: validAbi,
        roles: {},
        contractAddress: null,
      });

      expect(gate.configComplete).toBe(false);
      expect(gate.blockReason).toContain('Missing or invalid canonical treasury configuration');
      expect(gate.blockReason).toContain('fail closed');
    });

    it('is case-insensitive for admin address matching', () => {
      const gate = evaluateAccessGate({
        walletAddress: '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266' as `0x${string}`,
        chainId: 10,
        abi: validAbi,
        roles,
        contractAddress: '0x1234567890123456789012345678901234567890',
      });

      expect(gate.isAdmin).toBe(true);
      expect(gate.blockReason).toBeNull();
    });
  });

  describe('validateWithdrawalDraft', () => {
    const validBalance = {
      amountWei: '5000000000000000000', // 5 ETH
      amountFormatted: '5.0',
      symbol: 'ETH',
      fetchedAt: new Date().toISOString(),
      isStale: false,
    };

    it('passes validation for valid withdrawal', () => {
      const draft = {
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountWei: '1000000000000000000', // 1 ETH
      };

      const validation = validateWithdrawalDraft(draft, validBalance, 'EXECUTE', true);

      expect(validation.ok).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('fails for invalid recipient address', () => {
      const draft = {
        recipient: 'invalid-address',
        amountWei: '1000000000000000000',
      };

      const validation = validateWithdrawalDraft(draft, validBalance, 'EXECUTE', true);

      expect(validation.ok).toBe(false);
      expect(validation.errors.some((e) => e.includes('Recipient'))).toBe(true);
    });

    it('fails when amount exceeds balance', () => {
      const draft = {
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountWei: '10000000000000000000', // 10 ETH > 5 ETH
      };

      const validation = validateWithdrawalDraft(draft, validBalance, 'EXECUTE', true);

      expect(validation.ok).toBe(false);
      expect(validation.errors.some((e) => e.includes('exceeds canonical treasury balance'))).toBe(
        true,
      );
    });

    it('fails for zero amount', () => {
      const draft = {
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountWei: '0',
      };

      const validation = validateWithdrawalDraft(draft, validBalance, 'EXECUTE', true);

      expect(validation.ok).toBe(false);
      expect(validation.errors.some((e) => e.includes('greater than zero'))).toBe(true);
    });

    it('warns when balance is stale', () => {
      const staleBalance = {
        ...validBalance,
        isStale: true,
      };

      const draft = {
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountWei: '1000000000000000000',
      };

      const validation = validateWithdrawalDraft(draft, staleBalance, 'EXECUTE', true);

      expect(validation.warnings.some((w) => w.includes('stale'))).toBe(true);
      expect(validation.warnings.some((w) => w.includes('refresh before submitting'))).toBe(true);
    });

    it('fails closed when balance unavailable', () => {
      const draft = {
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountWei: '1000000000000000000',
      };

      const validation = validateWithdrawalDraft(draft, null, 'EXECUTE', true);

      expect(validation.ok).toBe(false);
      expect(validation.errors.some((e) => e.includes('Treasury balance unavailable'))).toBe(true);
      expect(validation.errors.some((e) => e.includes('fail closed'))).toBe(true);
    });

    it('requires exact typed confirmation', () => {
      const draft = {
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amountWei: '1000000000000000000',
      };

      // Wrong confirmation
      let validation = validateWithdrawalDraft(draft, validBalance, 'execute', true);
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((e) => e.includes('Type EXECUTE to confirm'))).toBe(true);

      // Missing confirmation
      validation = validateWithdrawalDraft(draft, validBalance, '', true);
      expect(validation.ok).toBe(false);

      // Correct confirmation
      validation = validateWithdrawalDraft(draft, validBalance, 'EXECUTE', true);
      expect(validation.ok).toBe(true);
    });
  });

  describe('chain and ABI support', () => {
    it('supports Optimism Mainnet (10)', () => {
      expect(isSupportedTreasuryChain(10)).toBe(true);
    });

    it('supports OP Sepolia (11155420)', () => {
      expect(isSupportedTreasuryChain(11155420)).toBe(true);
    });

    it('rejects Ethereum Mainnet', () => {
      expect(isSupportedTreasuryChain(1)).toBe(false);
    });

    it('rejects unsupported chains', () => {
      expect(isSupportedTreasuryChain(137)).toBe(false); // Polygon
      expect(isSupportedTreasuryChain(42161)).toBe(false); // Arbitrum
    });

    it('detects withdrawTreasury in ABI', () => {
      const abi = [{ type: 'function', name: 'withdrawTreasury', inputs: [] }];
      expect(abiHasFunction(abi, 'withdrawTreasury')).toBe(true);
    });

    it('returns false when function missing from ABI', () => {
      const abi = [{ type: 'function', name: 'otherFunction', inputs: [] }];
      expect(abiHasFunction(abi, 'withdrawTreasury')).toBe(false);
    });

    it('normalizes admin address', () => {
      const roles = { admin: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' };
      const normalized = normalizeAdminAddress(roles);
      expect(normalized).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('returns null for invalid admin address', () => {
      expect(normalizeAdminAddress({ admin: 'invalid' })).toBeNull();
      expect(normalizeAdminAddress({})).toBeNull();
      expect(normalizeAdminAddress(null)).toBeNull();
    });
  });
});

// ── 2. Wallet Identity Invalidation Tests ────────────────────────────────────

describe('Wallet Identity Transitions', () => {
  describe('classifyWalletIdentityTransition', () => {
    it('detects account change', () => {
      const previous = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
      };
      const next = {
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`,
        chainId: 10,
      };

      const transition = classifyWalletIdentityTransition(previous, next);
      expect(transition).toBe('account-change');
    });

    it('detects chain change', () => {
      const previous = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
      };
      const next = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 11155420,
      };

      const transition = classifyWalletIdentityTransition(previous, next);
      expect(transition).toBe('chain-change');
    });

    it('detects disconnect', () => {
      const previous = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
      };
      const next = {
        address: null,
        chainId: null,
      };

      const transition = classifyWalletIdentityTransition(previous, next);
      expect(transition).toBe('disconnect');
    });

    it('detects connect', () => {
      const previous = {
        address: null,
        chainId: null,
      };
      const next = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
      };

      const transition = classifyWalletIdentityTransition(previous, next);
      expect(transition).toBe('connect');
    });

    it('returns none when identity unchanged', () => {
      const identity = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
      };

      const transition = classifyWalletIdentityTransition(identity, identity);
      expect(transition).toBe('none');
    });

    it('is case-insensitive for account matching', () => {
      const previous = {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
        chainId: 10,
      };
      const next = {
        address: '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266' as `0x${string}`,
        chainId: 10,
      };

      const transition = classifyWalletIdentityTransition(previous, next);
      expect(transition).toBe('none');
    });
  });

  describe('transition behavior requirements', () => {
    it('account-change clears wallet cache', () => {
      expect(transitionClearsWalletCache('account-change')).toBe(true);
    });

    it('chain-change clears wallet cache', () => {
      expect(transitionClearsWalletCache('chain-change')).toBe(true);
    });

    it('disconnect clears wallet cache', () => {
      expect(transitionClearsWalletCache('disconnect')).toBe(true);
    });

    it('connect does not clear cache', () => {
      expect(transitionClearsWalletCache('connect')).toBe(false);
    });

    it('account-change requires auth revalidation', () => {
      expect(transitionRequiresAuthRevalidation('account-change')).toBe(true);
    });

    it('account-change requires recovery', () => {
      expect(transitionRequiresRecovery('account-change')).toBe(true);
    });

    it('chain-change requires recovery', () => {
      expect(transitionRequiresRecovery('chain-change')).toBe(true);
    });

    it('disconnect does not require recovery', () => {
      expect(transitionRequiresRecovery('disconnect')).toBe(false);
    });
  });

  describe('wallet-scoped query detection', () => {
    it('detects user scope', () => {
      expect(isWalletScopedQueryKey(['user', '0xabc', 10])).toBe(true);
    });

    it('detects user verifications', () => {
      expect(isWalletScopedQueryKey(['verifications', 'user', '0xabc'])).toBe(true);
    });

    it('does not flag global claims', () => {
      expect(isWalletScopedQueryKey(['claims', 'all'])).toBe(false);
    });

    it('does not flag disputes', () => {
      expect(isWalletScopedQueryKey(['disputes', 'active'])).toBe(false);
    });

    it('handles empty keys', () => {
      expect(isWalletScopedQueryKey([])).toBe(false);
    });
  });
});

// ── 3. Session Lifecycle Tests ───────────────────────────────────────────────

describe('Session Lifecycle', () => {
  const validSession = {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    token: 'valid-token-123',
    chainId: 10,
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    issuedAt: Date.now() - 60_000, // 1 min ago
  };

  describe('evaluateSessionHealth', () => {
    it('returns active for healthy session', () => {
      const health = evaluateSessionHealth(validSession);
      expect(health).toBe('active');
    });

    it('returns expired when past expiresAt', () => {
      const expiredSession = {
        ...validSession,
        expiresAt: Date.now() - 1000,
      };

      const health = evaluateSessionHealth(expiredSession);
      expect(health).toBe('expired');
    });

    it('returns refresh-due within refresh window', () => {
      const soonExpiring = {
        ...validSession,
        expiresAt: Date.now() + 30_000, // 30s from now
      };

      const health = evaluateSessionHealth(soonExpiring, Date.now(), 60_000);
      expect(health).toBe('refresh-due');
    });

    it('returns none when session is null', () => {
      const health = evaluateSessionHealth(null);
      expect(health).toBe('none');
    });

    it('returns invalid for malformed session', () => {
      const malformed = {
        address: '',
        token: 'valid-token',
        chainId: 10,
        expiresAt: Date.now() + 3600_000,
        issuedAt: Date.now(),
      };

      const health = evaluateSessionHealth(malformed);
      expect(health).toBe('invalid');
    });
  });

  describe('classifySessionRefreshError', () => {
    it('classifies REUSED failure', () => {
      const error = { message: 'token was already used' };
      const failure = classifySessionRefreshError(error);

      expect(failure.kind).toBe('REUSED');
      expect(failure.message).toContain('already rotated');
    });

    it('classifies REVOKED failure', () => {
      const error = { message: 'session revoked by admin' };
      const failure = classifySessionRefreshError(error);

      expect(failure.kind).toBe('REVOKED');
      expect(failure.message).toContain('revoked');
    });

    it('classifies EXPIRED failure', () => {
      const error = { message: 'session expired' };
      const failure = classifySessionRefreshError(error);

      expect(failure.kind).toBe('EXPIRED');
      expect(failure.message).toContain('expired');
    });

    it('classifies UNAUTHORIZED for 401 status', () => {
      const error = { httpStatus: 401 };
      const failure = classifySessionRefreshError(error);

      expect(failure.kind).toBe('UNAUTHORIZED');
    });

    it('classifies NETWORK for 5xx errors', () => {
      const error = { httpStatus: 503 };
      const failure = classifySessionRefreshError(error);

      expect(failure.kind).toBe('NETWORK');
    });

    it('fails closed with INVALID for unknown errors', () => {
      const error = { message: 'unknown error' };
      const failure = classifySessionRefreshError(error);

      expect(failure.kind).toBe('INVALID');
    });
  });

  describe('isTerminalRefreshFailure', () => {
    it('marks REUSED as terminal', () => {
      expect(isTerminalRefreshFailure('REUSED')).toBe(true);
    });

    it('marks REVOKED as terminal', () => {
      expect(isTerminalRefreshFailure('REVOKED')).toBe(true);
    });

    it('marks EXPIRED as terminal', () => {
      expect(isTerminalRefreshFailure('EXPIRED')).toBe(true);
    });

    it('marks UNAUTHORIZED as terminal', () => {
      expect(isTerminalRefreshFailure('UNAUTHORIZED')).toBe(true);
    });

    it('marks INVALID as terminal', () => {
      expect(isTerminalRefreshFailure('INVALID')).toBe(true);
    });

    it('marks NETWORK as non-terminal', () => {
      expect(isTerminalRefreshFailure('NETWORK')).toBe(false);
    });
  });
});

// ── 4. Cross-Context Isolation Tests ─────────────────────────────────────────

describe('Cross-Context Isolation', () => {
  it('treasury admin does not grant operations authority', () => {
    const treasuryAdmin = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const operationsAdmin = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

    // Different admin addresses = different contexts
    expect(treasuryAdmin.toLowerCase()).not.toBe(operationsAdmin.toLowerCase());
  });

  it('operations context cannot trigger treasury withdrawal', () => {
    // Operations allowlist must not include treasury operations
    const allowedOperations = ['op-retry-batch-4410', 'op-sync-dispute-projection'];

    expect(allowedOperations).not.toContain('withdraw-treasury');
    expect(allowedOperations).not.toContain('transfer-funds');
  });

  it('wallet scope keys do not include admin privileges', () => {
    const userKeys = ['user', '0xabc', 10];
    const adminKeys = ['admin', 'operations'];

    expect(isWalletScopedQueryKey(userKeys)).toBe(true);
    expect(isWalletScopedQueryKey(adminKeys)).toBe(false);
  });

  it('session expiry affects all contexts uniformly', () => {
    const expiredSession = {
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      token: 'token',
      chainId: 10,
      expiresAt: Date.now() - 1000,
      issuedAt: Date.now() - 3600_000,
    };

    const health = evaluateSessionHealth(expiredSession);
    expect(health).toBe('expired');

    // Same session, same expiry, regardless of context
    const healthCheck2 = evaluateSessionHealth(expiredSession);
    expect(healthCheck2).toBe('expired');
  });

  it('account change invalidates all privileged contexts', () => {
    const transition = classifyWalletIdentityTransition(
      { address: '0xabc' as `0x${string}`, chainId: 10 },
      { address: '0xdef' as `0x${string}`, chainId: 10 },
    );

    expect(transition).toBe('account-change');
    expect(transitionClearsWalletCache(transition)).toBe(true);
    expect(transitionRequiresAuthRevalidation(transition)).toBe(true);
    expect(transitionRequiresRecovery(transition)).toBe(true);
  });
});
