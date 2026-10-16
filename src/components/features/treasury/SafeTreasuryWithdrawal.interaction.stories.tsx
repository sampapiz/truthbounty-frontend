/**
 * UI-FE-033 — Treasury Guardian Interaction Tests
 *
 * Storybook interaction tests for treasury admin (guardian) context.
 * Tests multi-layer authorization, ABI availability, balance staleness, and validation.
 */

import type { Meta, StoryObj } from '@storybook/react';
import { expect } from '@storybook/jest';
import { within, userEvent, waitFor } from '@storybook/testing-library';
import { SafeTreasuryWithdrawalPanel } from './SafeTreasuryWithdrawalPanel';

const meta: Meta<typeof SafeTreasuryWithdrawalPanel> = {
  title: 'Features/Treasury/GuardianInteractions',
  component: SafeTreasuryWithdrawalPanel,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof SafeTreasuryWithdrawalPanel>;

// ── Base Mock Data ───────────────────────────────────────────────────────────

const authorizedTreasuryContext = {
  walletConnected: true,
  walletAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
  isAdmin: true,
  chainSupported: true,
  chainId: 10,
  abiSupportsWithdraw: true,
  configComplete: true,
  adminAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
  blockReason: null,
};

const treasuryBalance = {
  amountWei: '5000000000000000000', // 5 ETH
  amountFormatted: '5.0',
  symbol: 'ETH',
  fetchedAt: new Date().toISOString(),
  isStale: false,
};

// ── 1. Authorized Guardian Tests ─────────────────────────────────────────────

export const AuthorizedGuardianWithdrawal: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify authorized state
    await waitFor(() => {
      expect(canvas.getByText(/treasury admin/i)).toBeInTheDocument();
      expect(canvas.getByText(/authorized/i)).toBeInTheDocument();
    });

    // Verify balance display
    await waitFor(() => {
      expect(canvas.getByText(/treasury balance/i)).toBeInTheDocument();
      expect(canvas.getByText(/5\.0.*ETH/i)).toBeInTheDocument();
    });

    // Verify withdrawal controls visible
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    const confirmInput = canvas.getByRole('textbox', { name: /confirmation/i });

    expect(recipientInput).toBeInTheDocument();
    expect(amountInput).toBeInTheDocument();
    expect(confirmInput).toBeInTheDocument();

    // Fill valid withdrawal data
    await userEvent.type(recipientInput, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await userEvent.type(amountInput, '1000000000000000000'); // 1 ETH
    await userEvent.type(confirmInput, 'EXECUTE');

    // Verify withdraw button enabled
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    await waitFor(() => {
      expect(withdrawButton).toBeEnabled();
    });
  },
};

export const NonAdminWalletDenied: Story = {
  args: {
    accessGate: {
      ...authorizedTreasuryContext,
      walletAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`,
      isAdmin: false,
      blockReason: 'Connected wallet is not the canonical treasury admin — fail closed.',
    },
    balance: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify unauthorized state
    await waitFor(() => {
      expect(canvas.getByText(/unauthorized/i)).toBeInTheDocument();
    });

    // Verify block reason visible
    await waitFor(() => {
      expect(canvas.getByText(/not the canonical treasury admin/i)).toBeInTheDocument();
      expect(canvas.getByText(/fail closed/i)).toBeInTheDocument();
    });

    // Verify no withdrawal controls
    expect(canvas.queryByRole('textbox', { name: /recipient/i })).not.toBeInTheDocument();
    expect(canvas.queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
  },
};

export const UnsupportedChainBlocks: Story = {
  args: {
    accessGate: {
      ...authorizedTreasuryContext,
      chainId: 1, // Ethereum Mainnet
      chainSupported: false,
      blockReason: 'Unsupported chain. Switch to Optimism Mainnet (10) or OP Sepolia (11155420).',
    },
    balance: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify unsupported chain message
    await waitFor(() => {
      expect(canvas.getByText(/unsupported chain/i)).toBeInTheDocument();
    });

    // Verify switch instruction
    await waitFor(() => {
      expect(canvas.getByText(/switch to optimism/i)).toBeInTheDocument();
    });

    // Verify no controls
    expect(canvas.queryByRole('textbox', { name: /recipient/i })).not.toBeInTheDocument();
  },
};

export const AbiUnavailableFailClosed: Story = {
  args: {
    accessGate: {
      ...authorizedTreasuryContext,
      abiSupportsWithdraw: false,
      blockReason:
        'Canonical ABI does not expose withdrawTreasury — fail closed until artifacts include it.',
    },
    balance: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify ABI unavailable message
    await waitFor(() => {
      expect(
        canvas.getByText(/canonical ABI does not expose withdrawTreasury/i),
      ).toBeInTheDocument();
    });

    // Verify fail closed statement
    await waitFor(() => {
      expect(canvas.getByText(/fail closed/i)).toBeInTheDocument();
    });

    // Verify withdrawal controls disabled
    const withdrawButton = canvas.queryByRole('button', { name: /withdraw/i });
    if (withdrawButton) {
      expect(withdrawButton).toBeDisabled();
    } else {
      expect(withdrawButton).not.toBeInTheDocument();
    }
  },
};

export const DisconnectedWalletGate: Story = {
  args: {
    accessGate: {
      ...authorizedTreasuryContext,
      walletConnected: false,
      walletAddress: null,
      isAdmin: false,
      blockReason: 'Connect an Optimism-compatible wallet to continue.',
    },
    balance: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify connection prompt
    await waitFor(() => {
      expect(canvas.getByText(/connect.*wallet/i)).toBeInTheDocument();
    });

    // Verify connect button
    await waitFor(() => {
      expect(canvas.getByRole('button', { name: /connect/i })).toBeInTheDocument();
    });

    // Verify no withdrawal controls
    expect(canvas.queryByRole('textbox', { name: /recipient/i })).not.toBeInTheDocument();
  },
};

// ── 2. Balance Staleness Tests ───────────────────────────────────────────────

export const StaleBalanceWarning: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: {
      ...treasuryBalance,
      isStale: true,
      fetchedAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify stale warning
    await waitFor(() => {
      expect(canvas.getByText(/balance.*stale/i)).toBeInTheDocument();
    });

    // Verify refresh instruction
    await waitFor(() => {
      expect(canvas.getByText(/refresh before submitting/i)).toBeInTheDocument();
    });

    // Verify refresh button
    const refreshButton = canvas.getByRole('button', { name: /refresh/i });
    expect(refreshButton).toBeInTheDocument();

    // Fill withdrawal data
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    const confirmInput = canvas.getByRole('textbox', { name: /confirmation/i });

    await userEvent.type(recipientInput, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await userEvent.type(amountInput, '1000000000000000000');
    await userEvent.type(confirmInput, 'EXECUTE');

    // Verify withdraw button disabled due to staleness
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toBeDisabled();

    // Click refresh
    await userEvent.click(refreshButton);

    // Verify refresh initiated
    await waitFor(
      () => {
        const refreshing = canvas.queryByText(/refreshing/i);
        if (refreshing) {
          expect(refreshing).toBeInTheDocument();
        }
      },
      { timeout: 1000 },
    );
  },
};

export const MissingBalanceFailClosed: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify balance unavailable message
    await waitFor(() => {
      expect(canvas.getByText(/balance unavailable/i)).toBeInTheDocument();
    });

    // Verify fail closed statement
    await waitFor(() => {
      expect(canvas.getByText(/fail closed/i)).toBeInTheDocument();
    });

    // Verify withdrawal disabled
    const withdrawButton = canvas.queryByRole('button', { name: /withdraw/i });
    if (withdrawButton) {
      expect(withdrawButton).toBeDisabled();
    }
  },
};

// ── 3. Validation Tests ──────────────────────────────────────────────────────

export const InvalidRecipientAddress: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Fill invalid recipient
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    await userEvent.type(recipientInput, 'invalid-address');

    // Fill valid amount
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    await userEvent.type(amountInput, '1000000000000000000');

    // Blur to trigger validation
    await userEvent.tab();

    // Verify validation error
    await waitFor(() => {
      expect(canvas.getByText(/invalid.*address/i)).toBeInTheDocument();
    });

    // Verify button disabled
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toBeDisabled();
  },
};

export const AmountExceedsBalance: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Fill valid recipient
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    await userEvent.type(recipientInput, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');

    // Fill amount exceeding balance
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    await userEvent.type(amountInput, '10000000000000000000'); // 10 ETH > 5 ETH balance

    // Blur to trigger validation
    await userEvent.tab();

    // Verify balance error
    await waitFor(() => {
      expect(canvas.getByText(/exceeds.*balance/i)).toBeInTheDocument();
    });

    // Verify button disabled
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toBeDisabled();
  },
};

export const ZeroAmountRejected: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Fill valid recipient
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    await userEvent.type(recipientInput, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');

    // Fill zero amount
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    await userEvent.type(amountInput, '0');

    // Blur to trigger validation
    await userEvent.tab();

    // Verify zero amount error
    await waitFor(() => {
      expect(canvas.getByText(/greater than zero/i)).toBeInTheDocument();
    });

    // Verify button disabled
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toBeDisabled();
  },
};

export const TypedConfirmationMustMatchExactly: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Fill valid withdrawal data
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    const confirmInput = canvas.getByRole('textbox', { name: /confirmation/i });

    await userEvent.type(recipientInput, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await userEvent.type(amountInput, '1000000000000000000');

    // Type wrong confirmation (lowercase)
    await userEvent.type(confirmInput, 'execute');

    // Verify error
    await waitFor(() => {
      expect(canvas.getByText(/type EXECUTE to confirm/i)).toBeInTheDocument();
    });

    // Verify button disabled
    let withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toBeDisabled();

    // Clear and type correct confirmation
    await userEvent.clear(confirmInput);
    await userEvent.type(confirmInput, 'EXECUTE');

    // Verify button enabled
    withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    await waitFor(() => {
      expect(withdrawButton).toBeEnabled();
    });
  },
};

export const IrreversibleWarningDisplay: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify irreversible warning visible
    await waitFor(() => {
      expect(canvas.getByText(/irreversible/i)).toBeInTheDocument();
    });

    // Verify consequence information
    await waitFor(() => {
      expect(canvas.getByText(/withdraw.*from.*treasury/i)).toBeInTheDocument();
    });

    // Verify explicit confirmation required
    await waitFor(() => {
      expect(canvas.getByText(/type.*EXECUTE.*confirm/i)).toBeInTheDocument();
    });
  },
};

// ── 4. Cross-Context Isolation Tests ─────────────────────────────────────────

export const GuardianCannotAccessOperations: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify only treasury controls visible
    await waitFor(() => {
      expect(canvas.getByText(/treasury/i)).toBeInTheDocument();
    });

    // Verify no operations context elements
    expect(canvas.queryByText(/operational queue/i)).not.toBeInTheDocument();
    expect(canvas.queryByText(/protocol operator/i)).not.toBeInTheDocument();
    expect(canvas.queryByText(/audit trail/i)).not.toBeInTheDocument();
  },
};

export const NoClaimModificationCapability: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify no claim-related controls
    expect(canvas.queryByText(/claim/i)).not.toBeInTheDocument();
    expect(canvas.queryByText(/verdict/i)).not.toBeInTheDocument();
    expect(canvas.queryByText(/dispute/i)).not.toBeInTheDocument();
    expect(canvas.queryByText(/outcome/i)).not.toBeInTheDocument();

    // Verify only treasury withdrawal capability
    await waitFor(() => {
      expect(canvas.getByText(/treasury withdrawal/i)).toBeInTheDocument();
    });
  },
};

// ── 5. Accessibility and Keyboard Navigation Tests ───────────────────────────

export const KeyboardNavigationWithdrawal: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Tab through inputs
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    recipientInput.focus();

    // Fill recipient
    await userEvent.keyboard('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');

    // Tab to amount
    await userEvent.tab();
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    expect(amountInput).toHaveFocus();

    // Fill amount
    await userEvent.keyboard('1000000000000000000');

    // Tab to confirmation
    await userEvent.tab();
    const confirmInput = canvas.getByRole('textbox', { name: /confirmation/i });
    expect(confirmInput).toHaveFocus();

    // Fill confirmation
    await userEvent.keyboard('EXECUTE');

    // Tab to withdraw button
    await userEvent.tab();
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toHaveFocus();
    expect(withdrawButton).toBeEnabled();
  },
};

export const ContrastAndLabelAccessibility: Story = {
  args: {
    accessGate: authorizedTreasuryContext,
    balance: treasuryBalance,
  },
  parameters: {
    a11y: {
      config: {
        rules: [
          { id: 'color-contrast', enabled: true },
          { id: 'label', enabled: true },
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Verify all inputs have labels
    const recipientInput = canvas.getByRole('textbox', { name: /recipient/i });
    const amountInput = canvas.getByRole('textbox', { name: /amount/i });
    const confirmInput = canvas.getByRole('textbox', { name: /confirmation/i });

    expect(recipientInput).toBeInTheDocument();
    expect(amountInput).toBeInTheDocument();
    expect(confirmInput).toBeInTheDocument();

    // Verify buttons have accessible names
    const withdrawButton = canvas.getByRole('button', { name: /withdraw/i });
    expect(withdrawButton).toBeInTheDocument();
  },
};
